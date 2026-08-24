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

describe('migration v144 — proposal rejection histogram is a JSONB object', () => {
  test('repairs double-encoded receipts and enforces the object shape', async () => {
    expect(MIGRATIONS.find((candidate) => candidate.version === 144)?.name)
      .toBe('take_proposal_rejection_reason_jsonb_object');
    await engine.executeRaw(`
      ALTER TABLE proposal_page_runs
        DROP CONSTRAINT IF EXISTS proposal_page_runs_rejection_reason_counts_object_check
    `);
    await engine.executeRaw(`
      INSERT INTO proposal_page_runs
        (source_id,page_slug,source_hash,prompt_version,proposal_run_id,model_id,
         status,proposal_count,evidence_span_count,error_code,rejection_reason_counts)
      VALUES ('default','analysis/double-encoded','h','p','r','m',
              'quality_rejected',0,0,'invalid_claim_contract',
              to_jsonb('{"missing_gradeable_signal":2}'::text))
    `);
    await engine.setConfig('version', '143');

    expect((await runMigrations(engine)).applied).toBeGreaterThanOrEqual(1);
    expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));
    expect(await engine.executeRaw(`
      SELECT rejection_reason_counts, jsonb_typeof(rejection_reason_counts) AS reason_type
        FROM proposal_page_runs WHERE page_slug='analysis/double-encoded'
    `)).toEqual([{
      rejection_reason_counts: { missing_gradeable_signal: 2 },
      reason_type: 'object',
    }]);
    await expect(engine.executeRaw(`
      UPDATE proposal_page_runs
         SET rejection_reason_counts = to_jsonb('{"bad":1}'::text)
       WHERE page_slug='analysis/double-encoded'
    `)).rejects.toThrow();
  }, 30_000);
});
