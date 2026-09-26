import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { writeFactsToFence } from '../src/core/facts/fence-write.ts';
import { forgetFactInFence } from '../src/core/facts/forget.ts';
import { rebuildPendingPageProjections } from '../src/core/page-state/projections.ts';

// Fork contract: the legacy markdown-first fact writers project the fence
// into pages.compiled_truth in the fact transaction. Upstream's page-state
// trigger then unseals the text projection; its pages_projection_queue
// trigger must queue the keyless rebuild so the entity page returns to search
// without waiting for the next sync re-import.
let engine: PGLiteEngine;
let root: string;
const source = 'fact-projection-seal';
const slug = 'projects/sealed-decision';
beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  root = mkdtempSync(join(tmpdir(), 'fact-projection-seal-'));
  mkdirSync(join(root, 'projects'));
  await engine.executeRaw('INSERT INTO sources (id, name, local_path) VALUES ($1, $1, $2)', [source, root]);
});
afterAll(async () => { await engine.disconnect(); rmSync(root, { recursive: true, force: true }); });

const sealed = async () => (await engine.executeRaw<{ sealed: boolean }>(
  `SELECT text_projection_revision IS NOT DISTINCT FROM knowledge_revision AS sealed
     FROM pages WHERE source_id=$1 AND slug=$2`, [source, slug]))[0]?.sealed;
const queued = async () => (await engine.executeRaw(
  `SELECT 1 FROM page_projection_jobs j JOIN sources s ON s.incarnation=j.source_incarnation
    WHERE s.id=$1 AND j.slug=$2`, [source, slug])).length;

test('fence fact write and forget queue a projection rebuild that reseals the page', async () => {
  writeFileSync(join(root, slug + '.md'), '---\ntype: project\ntitle: Sealed decision\n---\n\nKeep the searchable sentinel prose.\n');
  const target = { sourceId: source, slug, localPath: root, resolutionSource: 'exact_page' as const };
  const written = await writeFactsToFence(engine, target, [{ fact: 'Sealsentinel claim stays searchable.', kind: 'fact',
    notability: 'high', visibility: 'world', source: 'test', embedding: null, sessionId: null }]);
  expect(written.inserted).toBe(1);
  expect(await queued()).toBe(1);
  await rebuildPendingPageProjections(engine, 20);
  expect(await sealed()).toBe(true);
  expect(await queued()).toBe(0);
  expect((await engine.searchKeyword('sealsentinel', { sourceId: source })).map(r => r.slug)).toContain(slug);

  expect((await forgetFactInFence(engine, written.ids[0], { sourceId: source })).path).toBe('fence');
  expect(await queued()).toBe(1);
  await rebuildPendingPageProjections(engine, 20);
  expect(await sealed()).toBe(true);
  expect((await engine.searchKeyword('searchable sentinel prose', { sourceId: source })).map(r => r.slug)).toContain(slug);
});
