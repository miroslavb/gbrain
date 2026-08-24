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

describe('migration v142 — grounded take proposal receipts', () => {
  test('registry entry is canonical and idempotent', () => {
    const migration = MIGRATIONS.find((candidate) => candidate.version === 142);
    expect(migration?.name).toBe('grounded_take_proposal_receipts');
    expect(migration?.idempotent).toBe(true);
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(142);
  });

  test('pre-v142 legacy queue upgrades without fabricating grounding', async () => {
    await engine.executeRaw(`DROP TABLE IF EXISTS proposal_page_runs`);
    await engine.executeRaw(`ALTER TABLE take_proposals DROP COLUMN IF EXISTS evidence_span`);
    await engine.executeRaw(`ALTER TABLE take_proposals DROP COLUMN IF EXISTS source_hash`);
    await engine.executeRaw(
      `INSERT INTO take_proposals
        (source_id,page_slug,content_hash,prompt_version,proposal_run_id,
         claim_text,kind,holder,weight,model_id)
       VALUES ('default','analysis/legacy','old-hash','old-prompt','old-run',
               'legacy claim','take','brain',0.5,'old-model')`,
    );
    await engine.executeRaw(`
      CREATE TABLE proposal_page_runs (
        source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        page_slug TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        proposal_run_id TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('completed','empty')),
        proposal_count INTEGER NOT NULL CHECK (proposal_count >= 0),
        model_id TEXT NOT NULL,
        completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (source_id, page_slug, source_hash, prompt_version)
      )
    `);
    await engine.executeRaw(`
      INSERT INTO proposal_page_runs
        (source_id,page_slug,source_hash,prompt_version,proposal_run_id,outcome,proposal_count,model_id)
      VALUES ('default','analysis/old-receipt','old-source-hash','old-prompt','old-run','completed',2,'old-model')
    `);
    await engine.setConfig('version', '141');

    const result = await runMigrations(engine);
    expect(result.applied).toBeGreaterThanOrEqual(1);
    expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));
    expect(await engine.executeRaw<{
      status: string; proposal_count: number; evidence_span_count: number; error_code: string | null;
    }>(`SELECT status, proposal_count, evidence_span_count, error_code FROM proposal_page_runs`))
      .toEqual([{ status: 'completed', proposal_count: 2, evidence_span_count: 2, error_code: null }]);
    expect(await engine.executeRaw<{ evidence_span: string | null; source_hash: string | null }>(
      `SELECT evidence_span, source_hash FROM take_proposals WHERE page_slug='analysis/legacy'`,
    )).toEqual([{ evidence_span: null, source_hash: null }]);

    expect((await runMigrations(engine)).applied).toBe(0);
    await engine.setConfig('version', '141');
    expect((await runMigrations(engine)).applied).toBeGreaterThanOrEqual(1);
    expect(await engine.executeRaw(`SELECT id FROM proposal_page_runs`)).toHaveLength(1);
  }, 30_000);
});
