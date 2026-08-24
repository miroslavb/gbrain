import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { LATEST_VERSION, MIGRATIONS, runMigrations } from '../src/core/migrate.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => engine.disconnect());

describe('migration v145 — explicit legacy extraction-receipt provenance policy', () => {
  test('stamps only guarded operation receipts and converges on a second run', async () => {
    expect(MIGRATIONS.find((candidate) => candidate.version === 145)?.name)
      .toBe('legacy_extract_receipt_raw_trace_exemptions');

    const legacy = {
      dream_generated: true,
      kind: 'facts.conversation',
      run_id: 'run-synthetic',
      round: 'single',
      source_id: 'default',
    };
    await engine.putPage('extracts/legacy-operation', {
      title: 'legacy operation receipt', type: 'note', compiled_truth: 'aggregate-only receipt',
      timeline: '', frontmatter: legacy, source_path: null,
    });
    await engine.putPage('extracts/unrelated-dream', {
      title: 'unrelated dream', type: 'note', compiled_truth: 'not an operation receipt',
      timeline: '', frontmatter: { dream_generated: true }, source_path: null,
    });
    await engine.setConfig('version', '144');

    expect((await runMigrations(engine)).applied).toBeGreaterThanOrEqual(1);
    expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));
    const rows = await engine.executeRaw<{ slug: string; exempt: string | null; reason: string | null }>(`
      SELECT slug,
             frontmatter->>'raw_trace_exempt' AS exempt,
             frontmatter->>'raw_trace_exempt_reason' AS reason
        FROM pages WHERE slug IN ('extracts/legacy-operation', 'extracts/unrelated-dream')
       ORDER BY slug
    `);
    expect(rows).toEqual([
      {
        slug: 'extracts/legacy-operation',
        exempt: 'true',
        reason: 'legacy extraction operation receipt; run_id/round/source_id identify the source operation',
      },
      { slug: 'extracts/unrelated-dream', exempt: null, reason: null },
    ]);
    expect((await runMigrations(engine)).applied).toBe(0);
  }, 30_000);
});
