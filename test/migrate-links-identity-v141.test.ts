import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { LATEST_VERSION, MIGRATIONS, runMigrations } from '../src/core/migrate.ts';

describe('migration v141 — NULL-origin link identity repair', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);

  afterAll(async () => {
    await engine.disconnect();
  }, 60_000);

  test('collapses legacy duplicates, installs NULLS NOT DISTINCT, and replays idempotently', async () => {
    const migration = MIGRATIONS.find(m => m.version === 141);
    expect(migration?.name).toBe('links_identity_nulls_not_distinct_repair');
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(141);

    await engine.executeRaw('DELETE FROM links');
    await engine.executeRaw("DELETE FROM pages WHERE slug IN ('people/v141-a','people/v141-b')");
    await engine.putPage('people/v141-a', {
      type: 'person', title: 'V141 A', compiled_truth: '', timeline: '',
    });
    await engine.putPage('people/v141-b', {
      type: 'person', title: 'V141 B', compiled_truth: '', timeline: '',
    });
    await engine.executeRaw(
      'ALTER TABLE links DROP CONSTRAINT links_from_to_type_source_origin_unique',
    );
    await engine.executeRaw(`
      ALTER TABLE links ADD CONSTRAINT links_from_to_type_source_origin_key
      UNIQUE (from_page_id, to_page_id, link_type, link_source, origin_page_id)
    `);
    await engine.executeRaw(`
      INSERT INTO links (from_page_id,to_page_id,link_type,link_source,origin_page_id,context)
      SELECT a.id,b.id,'mentions','markdown',NULL,'earliest'
        FROM pages a,pages b
       WHERE a.slug='people/v141-a' AND b.slug='people/v141-b'
    `);
    await engine.executeRaw(`
      INSERT INTO links (from_page_id,to_page_id,link_type,link_source,origin_page_id,context)
      SELECT a.id,b.id,'mentions','markdown',NULL,'later'
        FROM pages a,pages b
       WHERE a.slug='people/v141-a' AND b.slug='people/v141-b'
    `);
    await engine.setConfig('version', '140');

    const expectedApplied = MIGRATIONS.filter(m => m.version > 140).length;
    const first = await runMigrations(engine);
    expect(first).toMatchObject({ applied: expectedApplied, current: LATEST_VERSION });
    const rows = await engine.executeRaw<{ context: string }>(
      "SELECT context FROM links WHERE link_type='mentions' ORDER BY id",
    );
    expect(rows).toEqual([{ context: 'earliest' }]);
    const constraint = await engine.executeRaw<{ definition: string }>(`
      SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
       WHERE conname='links_from_to_type_source_origin_unique'
    `);
    expect(constraint[0]?.definition).toContain('UNIQUE NULLS NOT DISTINCT');

    const created = await engine.addLinksBatch([{
      from_slug: 'people/v141-a',
      to_slug: 'people/v141-b',
      link_type: 'mentions',
      link_source: 'markdown',
      context: 'replay',
      from_source_id: 'default',
      to_source_id: 'default',
    }], { auditSite: 'extract.stale' });
    expect(created).toBe(0);

    await engine.setConfig('version', '140');
    const second = await runMigrations(engine);
    expect(second.applied).toBe(expectedApplied);
    expect(await engine.executeRaw("SELECT id FROM links WHERE link_type='mentions'")).toHaveLength(1);
  }, 60_000);
});
