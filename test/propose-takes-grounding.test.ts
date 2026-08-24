import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runPhaseProposeTakes, contentHash, type ProposeTakesExtractor } from '../src/core/cycle/propose-takes.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('cycle.propose_takes.enabled', 'true');
});

const ctx = (): OperationContext => ({
  engine, config: {} as never, logger: { info() {}, warn() {}, error() {} } as never,
  dryRun: false, remote: false, sourceId: 'default',
});

async function putPage(slug: string, body: string): Promise<void> {
  await engine.putPage(slug, { type: 'analysis', title: slug, compiled_truth: body, frontmatter: {} });
}

describe('grounded take proposal publication', () => {
  test('stores exact evidence/source hash and rejects an ungrounded sibling', async () => {
    const body = 'I bet the launch reaches 100 customers by September.';
    await putPage('analysis/launch', body);
    const extractor: ProposeTakesExtractor = async () => [
      { claim_text: 'Launch reaches 100 customers by September', kind: 'bet', holder: 'brain', weight: 0.7, evidence_span: body },
      { claim_text: 'Launch reaches 1,000 customers tomorrow', kind: 'bet', holder: 'brain', weight: 0.9, evidence_span: 'This sentence is not in the page.' },
    ];

    const result = await runPhaseProposeTakes(ctx(), { extractor, pageLimit: 1 });
    expect(result.details).toMatchObject({
      proposals_inserted: 1,
      proposals_rejected_ungrounded: 1,
      page_receipts_completed: 1,
    });
    const proposals = await engine.executeRaw<{ evidence_span: string; source_hash: string }>(
      `SELECT evidence_span, source_hash FROM take_proposals WHERE status='pending'`,
    );
    expect(proposals).toEqual([{ evidence_span: body, source_hash: contentHash(body) }]);
    const receipts = await engine.executeRaw<{ status: string; proposal_count: number; evidence_span_count: number }>(
      `SELECT status, proposal_count, evidence_span_count FROM proposal_page_runs`,
    );
    expect(receipts).toEqual([{ status: 'completed', proposal_count: 1, evidence_span_count: 1 }]);
  });

  test('all-ungrounded output publishes only a retryable quality receipt', async () => {
    await putPage('analysis/unsupported', 'The page contains no forecast.');
    const extractor: ProposeTakesExtractor = async () => [
      { claim_text: 'Unsupported forecast', kind: 'bet', holder: 'brain', weight: 0.8, evidence_span: 'fabricated quote' },
    ];
    const result = await runPhaseProposeTakes(ctx(), { extractor, pageLimit: 1 });

    expect(result.details).toMatchObject({ proposals_inserted: 0, page_receipts_quality_rejected: 1 });
    expect(await engine.executeRaw(`SELECT id FROM take_proposals`)).toHaveLength(0);
    expect(await engine.executeRaw<{ status: string }>(`SELECT status FROM proposal_page_runs`))
      .toEqual([{ status: 'quality_rejected' }]);
  });

  test('a second-claim insert fault rolls back the first claim before writing failed receipt', async () => {
    const body = 'I think claim one and claim two will both hold.';
    await putPage('analysis/atomic', body);
    const extractor: ProposeTakesExtractor = async () => [
      { claim_text: 'Claim one holds', kind: 'take', holder: 'brain', weight: 0.6, evidence_span: body },
      { claim_text: 'Claim two holds', kind: 'take', holder: 'brain', weight: 0.6, evidence_span: body },
    ];
    const original = engine.transaction.bind(engine);
    (engine as unknown as { transaction: BrainEngine['transaction'] }).transaction = async (fn) =>
      original(async (tx) => {
        let inserts = 0;
        const proxy = new Proxy(tx, {
          get(target, prop, receiver) {
            if (prop !== 'executeRaw') return Reflect.get(target, prop, receiver);
            return async (sql: string, params?: unknown[]) => {
              if (sql.includes('INSERT INTO take_proposals') && ++inserts === 2) {
                throw new Error('injected second-claim failure');
              }
              return target.executeRaw(sql, params);
            };
          },
        });
        return fn(proxy);
      });
    try {
      const result = await runPhaseProposeTakes(ctx(), { extractor, pageLimit: 1 });
      expect(result.details).toMatchObject({ proposals_inserted: 0, page_receipts_failed: 1 });
    } finally {
      (engine as unknown as { transaction: BrainEngine['transaction'] }).transaction = original;
    }

    expect(await engine.executeRaw(`SELECT id FROM take_proposals`)).toHaveLength(0);
    expect(await engine.executeRaw<{ status: string; error_code: string }>(
      `SELECT status, error_code FROM proposal_page_runs`,
    )).toEqual([{ status: 'failed', error_code: 'publication_error' }]);
  });

  test('pageLimit is an exact cross-page cap with one terminal receipt per processed page', async () => {
    await putPage('analysis/cap-a', 'No gradeable claim in A.');
    await putPage('analysis/cap-b', 'No gradeable claim in B.');
    await putPage('analysis/cap-c', 'No gradeable claim in C.');
    const extractor: ProposeTakesExtractor = async () => [];

    const result = await runPhaseProposeTakes(ctx(), { extractor, pageLimit: 2 });
    expect(result.details).toMatchObject({ pages_scanned: 2, page_receipts_empty: 2 });
    expect(await engine.executeRaw(`SELECT id FROM proposal_page_runs`)).toHaveLength(2);
  });
});
