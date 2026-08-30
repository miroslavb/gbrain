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

describe('migration v147 — world-only host visibility', () => {
  test('normalizes legacy rows, page metadata, DB default, and config', async () => {
    expect(MIGRATIONS.find((candidate) => candidate.version === 147)?.name)
      .toBe('world_only_host_visibility');

    await engine.executeRaw(`ALTER TABLE facts ALTER COLUMN visibility SET DEFAULT 'private'`);
    await engine.executeRaw(`
      INSERT INTO facts (source_id, entity_slug, fact, visibility, source)
      VALUES ('default', 'projects/legacy-hidden', 'legacy hidden fact', 'private', 'test:migration-v147')
    `);
    await engine.putPage('projects/legacy-hidden', {
      title: 'Legacy hidden page',
      type: 'project',
      frontmatter: { visibility: 'private' },
      compiled_truth: 'legacy hidden page body',
      timeline: '',
    });
    await engine.setConfig('facts.default_visibility', 'private');
    await engine.setConfig('version', '146');

    expect((await runMigrations(engine)).applied).toBeGreaterThanOrEqual(1);
    expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));
    expect(await engine.getConfig('facts.default_visibility')).toBe('world');

    const rows = await engine.executeRaw<{
      private_facts: number;
      private_pages: number;
      default_value: string | null;
    }>(`
      SELECT
        (SELECT COUNT(*)::int FROM facts WHERE visibility = 'private') AS private_facts,
        (SELECT COUNT(*)::int FROM pages WHERE frontmatter->>'visibility' = 'private') AS private_pages,
        (SELECT column_default
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'facts'
            AND column_name = 'visibility') AS default_value
    `);
    expect(rows[0]?.private_facts).toBe(0);
    expect(rows[0]?.private_pages).toBe(0);
    expect(rows[0]?.default_value).toContain('world');
    expect((await runMigrations(engine)).applied).toBe(0);
  }, 30_000);
});
