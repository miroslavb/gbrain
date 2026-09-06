/**
 * Real-Postgres regression for the proposal dedup JSONB bind. A grounded
 * proposal must store an array with readable fence fields, never a doubly
 * encoded string. A clean empty extraction now writes a terminal page-run
 * receipt with zero proposals; the historical fake-proposal tombstone stays absent.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { setupDB, teardownDB, hasDatabase } from './helpers.ts';
import {
  runPhaseProposeTakes,
  EMPTY_EXTRACTION_TOMBSTONE_TEXT,
  type ProposeTakesExtractor,
} from '../../src/core/cycle/propose-takes.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import type { OperationContext } from '../../src/core/operations.ts';

const skip = !hasDatabase();
const describeIfDB = skip ? describe.skip : describe;

let engine: PostgresEngine;
const CLAIM = 'I predict city message volume doubles by 2027.';

const FENCE = [
  '<!-- gbrain:takes:begin -->',
  '| # | Claim | Kind | Holder | Weight |',
  '|---|-------|------|--------|--------|',
  '| 1 | Cities send messages | take | brain | 0.65 |',
  '<!-- gbrain:takes:end -->',
].join('\n');

function buildCtx(e: PostgresEngine): OperationContext {
  return {
    engine: e,
    config: {} as never,
    logger: { info() {}, warn() {}, error() {} } as never,
    dryRun: false,
    remote: false,
    sourceId: 'default',
  };
}

beforeAll(async () => {
  if (skip) return;
  engine = await setupDB();
  // This isolated JSONB fixture deliberately admits the phase; production stays default-off.
  await engine.setConfig('cycle.propose_takes.enabled', 'true');
  // take_proposals is not in the helpers' truncate list; clear stale rows so
  // idempotency-cache hits from a prior run cannot skip the write under test.
  await engine.executeRaw(`TRUNCATE take_proposals, proposal_page_runs CASCADE`);

  // Page A: carries a takes fence → non-empty existingTakes; extractor
  // proposes one claim → exercises the dedup write (site 1).
  await engine.putPage('takes/fence-page', {
    type: 'writing',
    title: 'Fence page',
    compiled_truth: `Prose about cities. ${CLAIM}\n\n${FENCE}\n`,
    timeline: '',
  });
  // Page B: also carries a fence (non-empty existingTakes) but the extractor
  // returns zero claims → exercises the dedicated empty page-run receipt.
  await engine.putPage('takes/empty-page', {
    type: 'writing',
    title: 'Empty page',
    compiled_truth: `Nothing gradeable here.\n\n${FENCE}\n`,
    timeline: '',
  });
});

afterAll(async () => {
  if (skip) return;
  await teardownDB();
});

describeIfDB('propose_takes dedup_against_fence_rows JSONB — Postgres regression (D3)', () => {
  test('grounded proposal stores a JSONB array and empty extraction stores only its terminal receipt', async () => {
    const extractor: ProposeTakesExtractor = async ({ pagePath }) => {
      if (pagePath === 'takes/fence-page') {
        return [{ claim_text: CLAIM, kind: 'take', holder: 'brain', weight: 0.7, evidence_span: CLAIM }];
      }
      return [];
    };

    const result = await runPhaseProposeTakes(buildCtx(engine), {
      extractor,
      pageLimit: 10,
      // Small source text isolates JSONB binding from the ordinary extraction size floor.
      minPageChars: 1,
    });

    // The phase catches thrown errors into status:'fail' — surface them.
    expect(result.error?.message ?? '').toBe('');
    expect(result.status).not.toBe('fail');
    expect(result.details).toMatchObject({ pages_scanned: 2, proposals_inserted: 1, budget_exhausted: false, warnings: [] });
    expect(result.details.tombstones_written).toBe(0);
    expect(result.details.empty_runs_written).toBe(1);
    expect(result.details.proposals_rejected_ungrounded).toBe(0);

    // Site 1: the dedup write. Must be a real jsonb array whose first element
    // round-trips the fence row it recorded.
    const dedup = await engine.executeRaw<{
      kind: string;
      first_claim: string | null;
      first_weight: string | null;
    }>(
      `SELECT jsonb_typeof(dedup_against_fence_rows) AS kind,
              dedup_against_fence_rows -> 0 ->> 'claim' AS first_claim,
              dedup_against_fence_rows -> 0 ->> 'weight' AS first_weight
         FROM take_proposals
        WHERE page_slug = $1 AND claim_text = $2`,
      ['takes/fence-page', CLAIM],
    );
    expect(dedup.length).toBe(1);
    expect(dedup[0]!.kind).toBe('array');
    expect(dedup[0]!.first_claim).toBe('Cities send messages');
    expect(dedup[0]!.first_weight).toBe('0.65');

    // Empty extraction is a real terminal receipt, not a synthetic proposal.
    const empty = await engine.executeRaw<{
      status: string; proposal_count: number; evidence_span_count: number;
    }>(
      `SELECT status, proposal_count, evidence_span_count FROM proposal_page_runs
        WHERE source_id = $1 AND page_slug = $2`,
      ['default', 'takes/empty-page'],
    );
    expect(empty).toEqual([{ status: 'empty', proposal_count: 0, evidence_span_count: 0 }]);
    const tomb = await engine.executeRaw(
      `SELECT id FROM take_proposals WHERE page_slug = $1 OR claim_text = $2`,
      ['takes/empty-page', EMPTY_EXTRACTION_TOMBSTONE_TEXT],
    );
    expect(tomb).toEqual([]);

  });
});
