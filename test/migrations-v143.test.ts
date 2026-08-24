import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { LATEST_VERSION, MIGRATIONS, runMigrations } from '../src/core/migrate.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

describe('migration v143 — take proposal rejection reason receipts', () => {
  test('registry entry is canonical and idempotent', () => {
    const migration = MIGRATIONS.find((candidate) => candidate.version === 143);
    expect(migration?.name).toBe('take_proposal_rejection_reason_receipts');
    expect(migration?.idempotent).toBe(true);
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(143);
  });

  test('v142 receipts upgrade to an empty aggregate without fabricating content', async () => {
    await engine.executeRaw(`ALTER TABLE proposal_page_runs DROP COLUMN IF EXISTS rejection_reason_counts`);
    await engine.executeRaw(`
      INSERT INTO proposal_page_runs
        (source_id,page_slug,source_hash,prompt_version,proposal_run_id,model_id,
         status,proposal_count,evidence_span_count,error_code)
      VALUES ('default','analysis/old-rejection','source-hash','old-prompt','old-run','old-model',
              'quality_rejected',0,0,'invalid_claim_contract')
    `);
    await engine.setConfig('version', '142');

    const result = await runMigrations(engine);
    expect(result.applied).toBeGreaterThanOrEqual(1);
    expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));
    expect(await engine.executeRaw<{ rejection_reason_counts: Record<string, number> }>(
      `SELECT rejection_reason_counts FROM proposal_page_runs WHERE page_slug='analysis/old-rejection'`,
    )).toEqual([{ rejection_reason_counts: {} }]);

    expect((await runMigrations(engine)).applied).toBe(0);
    await engine.setConfig('version', '142');
    expect((await runMigrations(engine)).applied).toBeGreaterThanOrEqual(1);
    expect(await engine.executeRaw(`SELECT id FROM proposal_page_runs WHERE page_slug='analysis/old-rejection'`))
      .toHaveLength(1);
  }, 30_000);
});
