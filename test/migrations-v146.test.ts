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

describe('migration v146 — current extraction health state', () => {
  test('backfills conservatively and converges on a second run', async () => {
    expect(MIGRATIONS.find(m => m.version === 146)?.name).toBe('extract_health_current_state');
    await engine.executeRaw('DROP TABLE IF EXISTS extract_health_state');
    await engine.executeRaw('DELETE FROM extract_rollup_7d');
    await engine.executeRaw(`
      INSERT INTO extract_rollup_7d
        (kind, source_id, day, halt_count, round_completed_count, updated_at)
      VALUES
        ('atoms','default',CURRENT_DATE - 1,3,0,NOW() - INTERVAL '1 day'),
        ('atoms','default',CURRENT_DATE,1,1,NOW()),
        ('facts.conversation','default',CURRENT_DATE,0,1,NOW()),
        ('legacy.orphan','missing-source',CURRENT_DATE,1,0,NOW())
    `);
    await engine.setConfig('version', '145');
    expect((await runMigrations(engine)).applied).toBeGreaterThanOrEqual(1);
    expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));
    expect(await engine.executeRaw(`
      SELECT kind, last_outcome, consecutive_halts, consecutive_completions
        FROM extract_health_state ORDER BY kind
    `)).toEqual([
      { kind: 'atoms', last_outcome: 'unknown', consecutive_halts: 0, consecutive_completions: 0 },
      { kind: 'facts.conversation', last_outcome: 'completed', consecutive_halts: 0, consecutive_completions: 1 },
    ]);
    expect((await runMigrations(engine)).applied).toBe(0);
  }, 30_000);
});
