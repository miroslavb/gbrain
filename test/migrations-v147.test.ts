import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { LATEST_VERSION, MIGRATIONS, runMigrations } from '../src/core/migrate.ts';

let engine: PGLiteEngine;
let skewEngine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  skewEngine = new PGLiteEngine();
  await skewEngine.connect({});
  await skewEngine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  await skewEngine.disconnect();
});

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

  test('v152 convergence guard repairs a DB that ran the older upgrade candidate', async () => {
    expect(MIGRATIONS.find((candidate) => candidate.version === 152)?.name)
      .toBe('world_only_host_visibility_convergence_guard');

    await skewEngine.executeRaw(`ALTER TABLE facts ALTER COLUMN visibility SET DEFAULT 'private'`);
    await skewEngine.executeRaw(`
      INSERT INTO facts (source_id, entity_slug, fact, visibility, source)
      VALUES ('default', 'projects/skew-hidden', 'skew hidden fact', 'private', 'test:migration-v152')
    `);
    await skewEngine.putPage('projects/skew-hidden', {
      title: 'Skew hidden page',
      type: 'project',
      frontmatter: { visibility: 'private' },
      compiled_truth: 'skew hidden page body',
      timeline: '',
    });
    await skewEngine.setConfig('facts.default_visibility', 'private');
    await skewEngine.setConfig('version', '151');

    expect((await runMigrations(skewEngine)).applied).toBe(1);
    expect(await skewEngine.getConfig('facts.default_visibility')).toBe('world');
    expect(await skewEngine.executeRaw<{ private_facts: number; private_pages: number }>(`
      SELECT
        (SELECT COUNT(*)::int FROM facts WHERE visibility = 'private') AS private_facts,
        (SELECT COUNT(*)::int FROM pages WHERE frontmatter->>'visibility' = 'private') AS private_pages
    `)).toEqual([{ private_facts: 0, private_pages: 0 }]);
    expect((await runMigrations(skewEngine)).applied).toBe(0);
  }, 30_000);
});
