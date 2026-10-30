/** Reviewed fork reader inventory: real storage, explicit refusals and honest censuses. */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { readPriorBody, readLastSnapshotBody } from '../src/core/facts/delta.ts';
import { countDeletedPageNullChunks } from '../src/core/embedding-invalidation.ts';
import { quarantineEntry } from '../src/commands/doctor/checks/content-quality.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';
import { readReconcileState } from '../src/core/persistence/reconcile-state.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { PAGE_MAX_BYTES } from '../src/core/page-size-policy.ts';
import { createSegmentedPage } from './helpers/segmented-page.ts';
import { segmentPage } from './helpers/segmented-chunks-fixture.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
const home = mkdtempSync(join(tmpdir(), 'fork-reader-inventory-'));
beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  await engine.setConfig('pages.segmented_storage', 'on');
}, 60_000);
afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

test('delta readers refuse real segmented live pages and retained versions while preserving source-exact inline reads', async () => {
  const slug = 'notes/delta-storage';
  await createSegmentedPage(engine, { slug, truth: 'A complete segmented fact source.' });
  await engine.createVersion(slug, { sourceId: 'default' });
  await engine.executeRaw("INSERT INTO sources(id,name) VALUES('delta-inline','Delta inline')");
  await engine.putPage(slug, { title: 'Inline twin', type: 'note', compiled_truth: 'Inline source stays exact.' }, { sourceId: 'delta-inline' });
  await engine.createVersion(slug, { sourceId: 'delta-inline' });
  await expect(readPriorBody(engine, slug, 'default')).rejects.toMatchObject({ code: 'page_body_segmented' });
  await expect(readLastSnapshotBody(engine, slug, 'default')).rejects.toMatchObject({ code: 'page_body_segmented' });
  expect(await readPriorBody(engine, slug, 'delta-inline')).toBe('Inline source stays exact.');
  expect(await readLastSnapshotBody(engine, slug, 'delta-inline')).toBe('Inline source stays exact.');
});

const flagged = async () => (await quarantineEntry.run({ engine, progress: { heartbeat() {} } } as unknown as DoctorContext) as Check[])
  .find(check => check.name === 'flagged_pages')!;

test('doctor preserves inline flag classification and explicitly reports segmented pages as unchecked', async () => {
  await engine.putPage('projects/gbrain', { title: 'Managed facts', type: 'project', compiled_truth: '<!--- gbrain:facts:begin -->\nFacts' });
  await engine.putPage('notes/actionable-flag', { title: 'Ordinary', type: 'note', compiled_truth: 'Ordinary flagged page.' });
  await createSegmentedPage(engine, { slug: 'notes/segmented-flag', truth: '<!--- gbrain:facts:begin -->\nSegmented facts' });
  await engine.executeRaw("UPDATE pages SET frontmatter=frontmatter || '{\"content_flag\":{\"reason\":\"markup_heavy\"}}'::jsonb WHERE slug=ANY($1::text[])",
    [['projects/gbrain', 'notes/actionable-flag', 'notes/segmented-flag']]);
  const check = await flagged();
  expect(check.status).toBe('warn');
  expect(check.skipped_segmented).toBe(1);
  expect(check.message).toContain('skipped (segmented): 1');
  expect(check.details).toMatchObject({ total: 3, checked: 2, accepted: 1, actionable: 1,
    accepted_by_reason: { managed_facts_page: 1 } });
  expect(check.details?.inventory).toEqual(expect.arrayContaining([
    expect.objectContaining({ slug: 'projects/gbrain', accepted: true, reason: 'managed_facts_page' }),
    expect.objectContaining({ slug: 'notes/actionable-flag', accepted: false, reason: 'unclassified_content_flag' }),
    expect.objectContaining({ slug: 'notes/segmented-flag', accepted: false, skipped: true, reason: 'segmented_body_unclassified' }),
  ]));
  await engine.executeRaw("UPDATE pages SET frontmatter=frontmatter - 'content_flag' WHERE body_storage='inline'");
  const onlySkipped = await flagged();
  expect(onlySkipped).toMatchObject({ status: 'warn', skipped_segmented: 1, details: { total: 1, checked: 0, accepted: 0, actionable: 0 } });
  expect(onlySkipped.message).toContain('No flagged page could be classified.');
});

test('deleted NULL residue counts live, staged and retired generations only on eligible deleted pages', async () => {
  const fixture = await segmentPage(engine, 'notes/deleted-generation-residue', { generation: 2, occurrences: [
    { id: 7101, byteStart: 0, genFrom: 1, genTo: 2, chunks: [{ text: 'retired residue' }] },
    { id: 7102, byteStart: 0, genFrom: 2, chunks: [{ text: 'current residue' }] },
    { id: 7103, byteStart: 0, genFrom: 3, chunks: [{ text: 'staged residue' }] },
  ] });
  expect(await countDeletedPageNullChunks(engine)).toBe(0);
  await engine.executeRaw('UPDATE pages SET deleted_at=now() WHERE id=$1', [fixture.pageId]);
  expect(await countDeletedPageNullChunks(engine)).toBe(3);
  await engine.executeRaw("UPDATE pages SET frontmatter=frontmatter || '{\"embed_skip\":false}'::jsonb WHERE id=$1", [fixture.pageId]);
  expect(await countDeletedPageNullChunks(engine)).toBe(0); // key existence, not its value
});

test('doctor reports a failed flag census as unknown rather than healthy', async () => {
  const original = engine.executeRaw;
  engine.executeRaw = async function (this: PGLiteEngine, sql, params) {
    if (sql.includes('has_managed_facts_fence')) throw new Error('fixture flag census unavailable');
    return original.call(this, sql, params);
  } as typeof engine.executeRaw;
  try {
    const check = await flagged();
    expect(check.status).toBe('warn');
    expect(check.message).toContain('fixture flag census unavailable');
    expect(check.fix_unavailable_reason).toBe('check_errored');
  } finally { engine.executeRaw = original; }
});

test('reconcile materializes a small segmented snapshot and refuses over-ceiling metadata before reading segments or changing the file', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  const sourceId = 'reader-reconcile', slug = 'notes/reconcile', root = join(home, 'source');
  mkdirSync(join(root, 'notes'), { recursive: true });
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [sourceId, root]);
  await claimWorktree(engine, sourceId, root);
  const { id } = await createSegmentedPage(engine, { sourceId, slug, truth: 'Segmented database preimage.',
    meta: { source_path: `${slug}.md`, title: 'Reconcile' } });
  const path = join(root, `${slug}.md`), content = `---\nslug: ${slug}\ntype: note\ntitle: Reconcile\n---\n\nChanged canonical file.\n`;
  writeFileSync(path, content);
  const state = await readReconcileState(engine, sourceId, slug);
  expect(state.snapshot.page.compiled_truth).toBe('Segmented database preimage.');
  expect(state.file.compiled_truth).toContain('Changed canonical file.');
  await engine.executeRaw('UPDATE pages SET body_bytes=$2 WHERE id=$1', [id, PAGE_MAX_BYTES + 1]);
  const original = engine.readSegmentTexts;
  let segmentReads = 0;
  engine.readSegmentTexts = async function (...args) { segmentReads++; return original.apply(this, args); };
  try {
    await expect(readReconcileState(engine, sourceId, slug)).rejects.toMatchObject({ code: 'page_body_segmented' });
    expect(segmentReads).toBe(0);
    expect(readFileSync(path, 'utf8')).toBe(content);
  } finally { engine.readSegmentTexts = original; }
}));
