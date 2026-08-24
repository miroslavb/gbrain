import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  runPhaseProposeTakes,
  contentHash,
  PROPOSE_TAKES_ALLOWED_PAGE_TYPES,
  PROPOSE_TAKES_EXCLUDED_SLUG_PATTERNS,
  PROPOSE_TAKES_MIN_PAGE_CHARS,
  type ProposeTakesExtraction,
  type ProposeTakesExtractor,
  type ProposeTakesOpts,
} from '../src/core/cycle/propose-takes.ts';
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

const ctx = (dryRun = false): OperationContext => ({
  engine, config: {} as never, logger: { info() {}, warn() {}, error() {} } as never,
  dryRun, remote: false, sourceId: 'default',
});

async function putPage(slug: string, body: string, type = 'concept'): Promise<void> {
  await engine.putPage(slug, { type: type as never, title: slug, compiled_truth: body, frontmatter: {} });
}

const CLEAN_SENSITIVITY_CONFIG = { allowlist: [], blocklistRe: null, patterns: [] };

/** Existing focused fixtures intentionally use short prose; production-floor coverage is separate. */
async function runShortFixture(
  operationCtx: OperationContext,
  opts: ProposeTakesOpts,
) {
  return runPhaseProposeTakes(operationCtx, {
    minPageChars: 0,
    sensitivityConfig: CLEAN_SENSITIVITY_CONFIG,
    ...opts,
  });
}

describe('grounded take proposal publication', () => {
  test('stores exact evidence/source hash and rejects an ungrounded sibling', async () => {
    const body = 'I bet the launch reaches 100 customers by September.';
    await putPage('analysis/launch', body);
    const extractor: ProposeTakesExtractor = async () => [
      { claim_text: 'launch reaches 100 customers by September', kind: 'bet', holder: 'brain', weight: 0.7, evidence_span: body },
      { claim_text: 'Launch reaches 1,000 customers tomorrow', kind: 'bet', holder: 'brain', weight: 0.9, evidence_span: 'This sentence is not in the page.' },
    ];

    const result = await runShortFixture(ctx(), { extractor, pageLimit: 1 });
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
    const result = await runShortFixture(ctx(), { extractor, pageLimit: 1 });

    expect(result.details).toMatchObject({ proposals_inserted: 0, page_receipts_quality_rejected: 1 });
    expect(await engine.executeRaw(`SELECT id FROM take_proposals`)).toHaveLength(0);
    expect(await engine.executeRaw<{ status: string }>(`SELECT status FROM proposal_page_runs`))
      .toEqual([{ status: 'quality_rejected' }]);
  });

  test('a second-claim insert fault rolls back the first claim before writing failed receipt', async () => {
    const body = 'I think claim one and claim two will both hold.';
    await putPage('analysis/atomic', body);
    const extractor: ProposeTakesExtractor = async () => [
      { claim_text: 'claim one', kind: 'take', holder: 'brain', weight: 0.6, evidence_span: body },
      { claim_text: 'claim two', kind: 'take', holder: 'brain', weight: 0.6, evidence_span: body },
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
      const result = await runShortFixture(ctx(), { extractor, pageLimit: 1 });
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

    const result = await runShortFixture(ctx(), { extractor, pageLimit: 2 });
    expect(result.details).toMatchObject({ pages_scanned: 2, page_receipts_empty: 2 });
    expect(await engine.executeRaw(`SELECT id FROM proposal_page_runs`)).toHaveLength(2);
  });

  test('SQL allowlist runs before LIMIT so a newer conversation cannot starve durable prose', async () => {
    await putPage('concepts/eligible', 'I predict durable markets will consolidate.');
    await putPage('conversations/newer', 'I predict this session note will be skipped.', 'conversation');
    let seen = '';
    const extractor: ProposeTakesExtractor = async ({ pagePath, pageBody }) => {
      seen = pagePath;
      return [{ claim_text: 'durable markets will consolidate', kind: 'bet', holder: 'brain', weight: 0.6, evidence_span: pageBody }];
    };

    await runShortFixture(ctx(), { extractor, pageLimit: 1 });
    expect(seen).toBe('concepts/eligible');
    expect(PROPOSE_TAKES_ALLOWED_PAGE_TYPES).not.toContain('conversation' as never);
  });

  test('SQL slug denylist runs before LIMIT when operational pages are mislabeled as concepts', async () => {
    await putPage('concepts/eligible-judgment', 'I think a sequential design is better.');
    await putPage('projects/newer-project', 'I think this project status is better.');
    await putPage('infra/newer-benchmark', 'I think this benchmark is better.');
    await putPage('codex/skill', 'I think this generated skill is better.');
    await putPage('jira/jm-108', 'I think this root Jira directive is better.');
    await putPage('jusan/jira/jm-107', 'I think this imported Jira directive is better.');
    await putPage('cf/10059779', 'I think this root Confluence directive is better.');
    await putPage('jusan/cf/10059778', 'I think this imported Confluence directive is better.');
    let seen = '';
    const extractor: ProposeTakesExtractor = async ({ pagePath, pageBody }) => {
      seen = pagePath;
      return [{ claim_text: 'I think a sequential design is better.', kind: 'take', holder: 'brain', weight: 0.6, evidence_span: pageBody }];
    };

    await runShortFixture(ctx(), { extractor, pageLimit: 1 });
    expect(seen).toBe('concepts/eligible-judgment');
    expect(PROPOSE_TAKES_EXCLUDED_SLUG_PATTERNS).toContain('projects/%');
    expect(PROPOSE_TAKES_EXCLUDED_SLUG_PATTERNS).toContain('jira/%');
    expect(PROPOSE_TAKES_EXCLUDED_SLUG_PATTERNS).toContain('%/jira/%');
    expect(PROPOSE_TAKES_EXCLUDED_SLUG_PATTERNS).toContain('cf/%');
    expect(PROPOSE_TAKES_EXCLUDED_SLUG_PATTERNS).toContain('%/cf/%');
    expect(PROPOSE_TAKES_EXCLUDED_SLUG_PATTERNS).toContain('%/skill');
  });

  test('production long-form floor runs before LIMIT so factual stubs cannot consume canary slots', async () => {
    const longBody = `I think a sequential design is better. ${'Durable supporting prose. '.repeat(40)}`;
    await putPage('concepts/long-form', longBody);
    await putPage('concepts/newer-stub', 'A short factual entity stub.');
    let seen = '';
    const extractor: ProposeTakesExtractor = async ({ pagePath, pageBody }) => {
      seen = pagePath;
      return [{ claim_text: 'I think a sequential design is better.', kind: 'take', holder: 'brain', weight: 0.6, evidence_span: pageBody }];
    };

    await runPhaseProposeTakes(ctx(), {
      extractor,
      pageLimit: 1,
      sensitivityConfig: CLEAN_SENSITIVITY_CONFIG,
    });
    expect(seen).toBe('concepts/long-form');
    expect(PROPOSE_TAKES_MIN_PAGE_CHARS).toBe(800);
  });

  test('full-source sensitive scan rejects before extractor and writes no proposal text', async () => {
    const body = `Authorization: Bearer fake-canary-token-1234567890\nI think a sequential design is better. ${'Padding. '.repeat(100)}`;
    await putPage('concepts/sensitive-source', body);
    let calls = 0;
    const extractor: ProposeTakesExtractor = async () => {
      calls++;
      return [{ claim_text: 'I think a sequential design is better.', kind: 'take', holder: 'brain', weight: 0.6, evidence_span: body }];
    };

    const result = await runPhaseProposeTakes(ctx(), {
      extractor,
      pageLimit: 1,
      sensitivityConfig: CLEAN_SENSITIVITY_CONFIG,
    });
    expect(calls).toBe(0);
    expect(result.details).toMatchObject({
      proposals_inserted: 0,
      pages_rejected_sensitive: 1,
      page_receipts_quality_rejected: 1,
    });
    expect(String(result.details.warnings)).not.toContain('fake-canary-token');
    expect(await engine.executeRaw(`SELECT id FROM take_proposals`)).toHaveLength(0);
    expect(await engine.executeRaw<{ status: string; error_code: string; model_id: string }>(
      `SELECT status, error_code, model_id FROM proposal_page_runs`,
    )).toEqual([{
      status: 'quality_rejected',
      error_code: 'sensitive_source',
      model_id: 'deterministic:sensitivity-scan',
    }]);
  });

  test('dry-run performs extraction but writes no proposals, receipts, or rollup', async () => {
    const body = 'I predict dry-run markets will consolidate.';
    await putPage('concepts/dry-run', body);
    const extractor: ProposeTakesExtractor = async () => [
      { claim_text: 'dry-run markets will consolidate', kind: 'bet', holder: 'brain', weight: 0.6, evidence_span: body },
    ];

    const result = await runShortFixture(ctx(true), { extractor, pageLimit: 1 });
    expect(result.details).toMatchObject({ pages_scanned: 1, proposals_inserted: 0 });
    expect(await engine.executeRaw(`SELECT id FROM take_proposals`)).toHaveLength(0);
    expect(await engine.executeRaw(`SELECT id FROM proposal_page_runs`)).toHaveLength(0);
    expect(await engine.executeRaw(`SELECT kind FROM extract_rollup_7d WHERE kind='takes.proposed'`)).toHaveLength(0);
  });

  test('stores the provider/model that actually answered, not the requested route', async () => {
    const body = 'I predict fallback markets will consolidate.';
    await putPage('concepts/model-provenance', body);
    const extraction = [{
      claim_text: 'fallback markets will consolidate', kind: 'bet' as const,
      holder: 'brain', weight: 0.6, evidence_span: body,
    }] as ProposeTakesExtraction;
    Object.defineProperty(extraction, 'modelId', { value: 'together:deepseek-v4-flash:0731' });

    await runShortFixture(ctx(), {
      extractor: async () => extraction,
      model: 'claude-cli:claude-sonnet-5',
      pageLimit: 1,
    });
    expect(await engine.executeRaw<{ model_id: string }>(`SELECT model_id FROM take_proposals`))
      .toEqual([{ model_id: 'together:deepseek-v4-flash:0731' }]);
    expect(await engine.executeRaw<{ model_id: string }>(`SELECT model_id FROM proposal_page_runs`))
      .toEqual([{ model_id: 'together:deepseek-v4-flash:0731' }]);
  });

  test('strict-parser rejection writes a retryable quality receipt, never an empty cache marker', async () => {
    await putPage('concepts/invalid-contract', 'Acme was founded in 2020.');
    const extraction = [] as ProposeTakesExtraction;
    Object.defineProperty(extraction, 'qualityRejected', { value: true });
    Object.defineProperty(extraction, 'modelId', { value: 'test:strict-parser' });
    Object.defineProperty(extraction, 'rejectionReasonCounts', {
      value: { missing_gradeable_signal: 2, invalid_holder: 1 },
    });

    const result = await runShortFixture(ctx(), { extractor: async () => extraction, pageLimit: 1 });
    expect(result.details).toMatchObject({ page_receipts_quality_rejected: 1, page_receipts_empty: 0 });
    expect(await engine.executeRaw<{
      status: string; error_code: string; rejection_reason_counts: Record<string, number>; reason_type: string;
    }>(
      `SELECT status, error_code, rejection_reason_counts,
              jsonb_typeof(rejection_reason_counts) AS reason_type
         FROM proposal_page_runs`,
    )).toEqual([{
      status: 'quality_rejected',
      error_code: 'invalid_claim_contract',
      rejection_reason_counts: { missing_gradeable_signal: 2, invalid_holder: 1 },
      reason_type: 'object',
    }]);
  });
});
