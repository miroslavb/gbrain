import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  PROPOSE_TAKES_ALLOWED_PAGE_TYPES,
  PROPOSE_TAKES_PROMPT_VERSION,
  contentHash,
  parseExtractorOutput,
  runPhaseProposeTakes,
  versionedSourceHash,
  type ProposeTakesExtractor,
} from '../src/core/cycle/propose-takes.ts';
import { MIGRATIONS } from '../src/core/migrate.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('cycle.propose_takes.enabled', 'false');
});

function context(target: BrainEngine = engine, dryRun = false): OperationContext {
  return {
    engine: target,
    config: {} as never,
    logger: { info() {}, warn() {}, error() {} } as never,
    dryRun,
    remote: false,
    sourceId: 'default',
  };
}

async function putPage(slug: string, body: string, type = 'concept'): Promise<void> {
  await engine.putPage(slug, {
    title: slug,
    type: type as never,
    compiled_truth: body,
    frontmatter: {},
    timeline: '',
  });
}

async function count(table: 'take_proposals' | 'proposal_page_runs'): Promise<number> {
  const rows = await engine.executeRaw<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${table}`);
  return rows[0]!.n;
}

function claimExtractor(claim = 'Widget markets will consolidate'): ProposeTakesExtractor {
  return async ({ pageBody }) => [{
    claim_text: claim,
    kind: 'take',
    holder: 'brain',
    weight: 0.7,
    domain: 'market',
    evidence_span: pageBody,
  }];
}

describe('propose_takes producer containment', () => {
  test('default-off phase-local gate blocks direct callers before extraction', async () => {
    await putPage('concepts/gated', 'Widget markets will consolidate over the next year.');
    let calls = 0;
    const extractor: ProposeTakesExtractor = async () => {
      calls++;
      return [];
    };

    const result = await runPhaseProposeTakes(context(), { extractor });

    expect(result.status).toBe('skipped');
    expect(result.details.reason).toBe('disabled');
    expect(calls).toBe(0);
    expect(await count('take_proposals')).toBe(0);
    expect(await count('proposal_page_runs')).toBe(0);
  });

  test('one-shot bypass runs while leaving the disabled config untouched', async () => {
    const body = 'Widget markets will consolidate over the next year.';
    await putPage('concepts/once', body);

    const result = await runPhaseProposeTakes(context(), {
      extractor: claimExtractor(),
      once: true,
    });

    expect(result.status).toBe('ok');
    expect((result.details as Record<string, unknown>).proposals_inserted).toBe(1);
    expect(await engine.getConfig('cycle.propose_takes.enabled')).toBe('false');
    expect(await count('proposal_page_runs')).toBe(1);
  });

  test('dry-run extracts but writes neither proposals nor completion markers', async () => {
    const body = 'Widget markets will consolidate over the next year.';
    await putPage('concepts/dry-run', body);
    await engine.setConfig('cycle.propose_takes.enabled', 'true');
    let calls = 0;
    const extractor: ProposeTakesExtractor = async ({ pageBody }) => {
      calls++;
      return [{
        claim_text: 'Widget markets will consolidate',
        kind: 'take',
        holder: 'brain',
        weight: 0.7,
        evidence_span: pageBody,
      }];
    };

    const result = await runPhaseProposeTakes(context(engine, true), { extractor });

    expect(result.status).toBe('ok');
    expect(calls).toBe(1);
    expect((result.details as Record<string, unknown>).proposals_inserted).toBe(0);
    expect(await count('take_proposals')).toBe(0);
    expect(await count('proposal_page_runs')).toBe(0);
  });

  test('DB page_limit bounds one-shot and scheduled producer runs', async () => {
    await putPage('concepts/first-limit', 'First allowed page has a gradeable claim.', PROPOSE_TAKES_ALLOWED_PAGE_TYPES[0]);
    await putPage('concepts/second-limit', 'Second allowed page has a gradeable claim.', PROPOSE_TAKES_ALLOWED_PAGE_TYPES[0]);
    await engine.setConfig('cycle.propose_takes.enabled', 'true');
    await engine.setConfig('cycle.propose_takes.page_limit', '1');
    let calls = 0;
    const extractor: ProposeTakesExtractor = async ({ pageBody }) => {
      calls++;
      return [{
        claim_text: `Bounded claim ${calls}`,
        kind: 'take',
        holder: 'brain',
        weight: 0.6,
        evidence_span: pageBody,
      }];
    };

    await runPhaseProposeTakes(context(), { extractor });
    expect(calls).toBe(1);
  });

  test('SQL allowlist is applied before LIMIT so disallowed recent pages cannot starve eligible pages', async () => {
    const allowedBody = 'Allowed longform predicts a widget market consolidation.';
    await putPage('concepts/allowed', allowedBody, PROPOSE_TAKES_ALLOWED_PAGE_TYPES[0]);
    await putPage('conversations/recent', 'A newer conversation should not be proposed from.', 'conversation');
    await engine.setConfig('cycle.propose_takes.enabled', 'true');
    let seenPath = '';
    const extractor: ProposeTakesExtractor = async ({ pagePath, pageBody }) => {
      seenPath = pagePath;
      return [{
        claim_text: 'Widget markets will consolidate',
        kind: 'take',
        holder: 'brain',
        weight: 0.7,
        evidence_span: pageBody,
      }];
    };

    await runPhaseProposeTakes(context(), { extractor, pageLimit: 1 });

    expect(seenPath).toBe('concepts/allowed');
  });
});

describe('propose_takes parser grounding contract', () => {
  const pageBody = 'I predict widget markets will consolidate. I bet pricing falls next year.';

  test('maps model taxonomy to canonical kinds and rejects unknown kinds', () => {
    const out = parseExtractorOutput(JSON.stringify([
      { claim_text: 'Widget markets will consolidate', kind: 'prediction', holder: 'brain', weight: 0.7, evidence_span: 'I predict widget markets will consolidate.' },
      { claim_text: 'Widget markets look fragile', kind: 'judgment', holder: 'brain', weight: 0.5, evidence_span: 'I predict widget markets will consolidate.' },
      { claim_text: 'Pricing falls next year', kind: 'bet', holder: 'brain', weight: 0.8, evidence_span: 'I bet pricing falls next year.' },
      { claim_text: 'Unknown row', kind: 'fact', holder: 'brain', weight: 0.5, evidence_span: 'I bet pricing falls next year.' },
    ]), pageBody);

    expect(out.map(row => row.kind)).toEqual(['take', 'take', 'bet']);
  });

  test('accepts exactly 200 claim characters and rejects 201', () => {
    const out = parseExtractorOutput(JSON.stringify([
      { claim_text: 'x'.repeat(200), kind: 'prediction', holder: 'brain', weight: 0.5, evidence_span: 'I predict widget markets will consolidate.' },
      { claim_text: 'y'.repeat(201), kind: 'prediction', holder: 'brain', weight: 0.5, evidence_span: 'I predict widget markets will consolidate.' },
    ]), pageBody);

    expect(out).toHaveLength(1);
    expect(out[0]!.claim_text).toHaveLength(200);
  });

  test('stores only exact contiguous evidence spans from the page body', () => {
    const out = parseExtractorOutput(JSON.stringify([
      { claim_text: 'Grounded', kind: 'prediction', holder: 'brain', weight: 0.5, evidence_span: 'I predict widget markets will consolidate.' },
      { claim_text: 'Paraphrased evidence', kind: 'prediction', holder: 'brain', weight: 0.5, evidence_span: 'Widget markets probably consolidate.' },
      { claim_text: 'Missing evidence', kind: 'prediction', holder: 'brain', weight: 0.5 },
    ]), pageBody);

    expect(out).toHaveLength(1);
    expect(out[0]!.evidence_span).toBe('I predict widget markets will consolidate.');
  });

  test('prompt requests exact evidence and the model taxonomy', async () => {
    const source = await Bun.file(new URL('../src/core/cycle/propose-takes.ts', import.meta.url)).text();
    expect(source).toContain('evidence_span');
    expect(source).toContain('exact contiguous substring');
    expect(source).toContain("'prediction' | 'judgment' | 'bet'");
  });
});

describe('propose_takes page-run resumability', () => {
  test('partial proposal rows without a completed marker are replayed and completed', async () => {
    const body = 'Claim one is supported here. Claim two is supported here.';
    const slug = 'concepts/partial';
    await putPage(slug, body);
    await engine.setConfig('cycle.propose_takes.enabled', 'true');
    const hash = contentHash(body);
    await engine.executeRaw(
      `INSERT INTO take_proposals
         (source_id, page_slug, content_hash, prompt_version, proposal_run_id,
          claim_text, kind, holder, weight, dedup_against_fence_rows, model_id,
          evidence_span, source_hash)
       VALUES ('default', $1, $2, $3, 'crashed-run', 'Claim one', 'take', 'brain',
               0.6, '[]'::jsonb, 'test-model', 'Claim one is supported here.', $4)`,
      [slug, hash, PROPOSE_TAKES_PROMPT_VERSION, versionedSourceHash(body)],
    );
    const extractor: ProposeTakesExtractor = async () => [
      { claim_text: 'Claim one', kind: 'take', holder: 'brain', weight: 0.6, evidence_span: 'Claim one is supported here.' },
      { claim_text: 'Claim two', kind: 'take', holder: 'brain', weight: 0.7, evidence_span: 'Claim two is supported here.' },
    ];

    const result = await runPhaseProposeTakes(context(), { extractor, model: 'test-model' });

    expect((result.details as Record<string, unknown>).cache_hits).toBe(0);
    expect(await count('take_proposals')).toBe(2);
    expect(await count('proposal_page_runs')).toBe(1);
  });

  test('empty extraction writes only an empty page-run outcome and replays as a cache hit', async () => {
    await putPage('concepts/empty', 'This page has no gradeable claim.');
    await engine.setConfig('cycle.propose_takes.enabled', 'true');
    let calls = 0;
    const extractor: ProposeTakesExtractor = async () => {
      calls++;
      return [];
    };

    const first = await runPhaseProposeTakes(context(), { extractor });
    const second = await runPhaseProposeTakes(context(), { extractor });
    const outcomes = await engine.executeRaw<{ outcome: string; proposal_count: number }>(
      `SELECT outcome, proposal_count FROM proposal_page_runs`,
    );

    expect((first.details as Record<string, unknown>).empty_runs_written).toBe(1);
    expect((second.details as Record<string, unknown>).cache_hits).toBe(1);
    expect(calls).toBe(1);
    expect(await count('take_proposals')).toBe(0);
    expect(outcomes).toEqual([{ outcome: 'empty', proposal_count: 0 }]);
  });

  test('new proposals store exact evidence and a versioned source hash', async () => {
    const body = 'Widget markets will consolidate over the next year.';
    await putPage('concepts/evidence', body);
    await engine.setConfig('cycle.propose_takes.enabled', 'true');

    await runPhaseProposeTakes(context(), { extractor: claimExtractor(), model: 'test-model' });
    const rows = await engine.executeRaw<{ evidence_span: string; source_hash: string }>(
      `SELECT evidence_span, source_hash FROM take_proposals`,
    );

    expect(rows).toEqual([{
      evidence_span: body,
      source_hash: versionedSourceHash(body),
    }]);
    expect(rows[0]!.source_hash).toMatch(/^sha256:v1:[0-9a-f]{64}$/);
  });
});

describe('migration v127 — proposal producer containment', () => {
  test('ships page-run marker, grounding columns, and schema/RLS parity', async () => {
    const migration = MIGRATIONS.find(entry => entry.version === 127);
    expect(migration?.name).toBe('take_proposal_page_runs');
    expect(migration?.sql).toContain('CREATE TABLE IF NOT EXISTS proposal_page_runs');
    expect(migration?.sql).toContain('ADD COLUMN IF NOT EXISTS evidence_span');
    expect(migration?.sql).toContain('ADD COLUMN IF NOT EXISTS source_hash');

    const [schema, embedded, pglite] = await Promise.all([
      Bun.file(new URL('../src/schema.sql', import.meta.url)).text(),
      Bun.file(new URL('../src/core/schema-embedded.ts', import.meta.url)).text(),
      Bun.file(new URL('../src/core/pglite-schema.ts', import.meta.url)).text(),
    ]);
    for (const source of [schema, embedded, pglite]) {
      expect(source).toContain('CREATE TABLE IF NOT EXISTS proposal_page_runs');
      expect(source).toContain('evidence_span');
      expect(source).toContain('source_hash');
    }
    expect(schema).toContain('ALTER TABLE proposal_page_runs ENABLE ROW LEVEL SECURITY');
    expect(embedded).toContain('ALTER TABLE proposal_page_runs ENABLE ROW LEVEL SECURITY');
  });
});
