import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { projectFactPageBody, factPageProjection } from '../src/core/facts/page-projection.ts';
import { readPriorBody, readLastSnapshotBody } from '../src/core/facts/delta.ts';
import type { BrainEngine } from '../src/core/engine.ts';
let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
afterAll(async () => { await engine.disconnect(); });

test('a guarded fact stub records its origin and a second claimant rolls back the entire fact transaction even without the unique index', async () => {
  await projectFactPageBody(engine, 'default', factPageProjection('# First\n\nOriginal', 'notes/origin-first', 'shared.md'));
  expect((await engine.getPage('notes/origin-first'))?.source_path).toBe('shared.md');
  await engine.executeRaw('DROP INDEX pages_live_origin_key');
  await expect(engine.transaction(async tx => {
    await tx.executeRaw("INSERT INTO facts(fact,source,visibility) VALUES('origin rollback sentinel','test:origin','world')");
    await projectFactPageBody(tx, 'default', factPageProjection('# Second\n\nReplacement', 'notes/origin-second', 'shared.md'));
  })).rejects.toMatchObject({ code: 'page_identity_changed', detail: 'origin_already_claimed' });
  expect(await engine.getPage('notes/origin-second')).toBeNull();
  expect(await engine.executeRaw("SELECT id FROM facts WHERE fact='origin rollback sentinel'")).toEqual([]);
  expect((await engine.getPage('notes/origin-first'))?.compiled_truth).toContain('Original');
  await engine.executeRaw("INSERT INTO sources(id,name) VALUES('origin-other','Origin other')");
  await projectFactPageBody(engine, 'origin-other', factPageProjection('# Other', 'notes/origin-second', 'shared.md'));
  expect((await engine.getPage('notes/origin-second', { sourceId: 'origin-other' }))?.source_path).toBe('shared.md');
});

test('fact projection refuses a segmented page before overwriting its stored body', async () => {
  await projectFactPageBody(engine, 'default', factPageProjection('# Segmented\n\nOriginal', 'notes/segmented-origin', 'segmented.md'));
  await engine.executeRaw("UPDATE pages SET body_storage='segmented',compiled_truth=NULL,timeline=NULL,body_bytes=42 WHERE source_id='default' AND slug='notes/segmented-origin'");
  await expect(projectFactPageBody(engine, 'default', factPageProjection('# Changed', 'notes/segmented-origin', 'segmented.md')))
    .rejects.toMatchObject({ code: 'page_body_segmented' });
  expect(await engine.executeRaw("SELECT compiled_truth,body_storage FROM pages WHERE source_id='default' AND slug='notes/segmented-origin'"))
    .toEqual([{ compiled_truth: null, body_storage: 'segmented' }]);
});

test('delta body readers propagate segmented refusal instead of treating an empty sentinel as prior content', async () => {
  const stub = { getPage: async () => ({ body_storage: 'segmented', slug: 'notes/segmented', compiled_truth: '' }),
    executeRaw: async () => [{ body_storage: 'segmented', compiled_truth: '' }] } as unknown as BrainEngine;
  await expect(readPriorBody(stub, 'notes/segmented', 'default')).rejects.toMatchObject({ code: 'page_body_segmented' });
  await expect(readLastSnapshotBody(stub, 'notes/segmented', 'default')).rejects.toMatchObject({ code: 'page_body_segmented' });
});
