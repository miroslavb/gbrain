/**
 * Fork patch 2026-09-27 — stale-chunk selectors skip soft-deleted pages.
 *
 * The embed path resolves each stale row's page through readPageSnapshot, which
 * does not return soft-deleted pages, so their NULL-vector chunks could never be
 * embedded: countStaleChunks stayed above zero and `migrate embeddings` could
 * never report completion (3 chunks of deleted pages on the Giga cutover
 * rehearsal). getHealth().missing_embeddings stays raw by contract (#1305, chunks
 * occupy storage until purge), so migration verify subtracts the deleted-page
 * residue before its "NULL vectors outside the stale predicate" blocker and
 * reports it separately. A restored page is stale again and the next run embeds it.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { verifyMigrationComplete } from '../src/core/embedding-migration.ts';
import { readContentChunksEmbeddingDim } from '../src/core/embedding-dim-check.ts';

let engine: PGLiteEngine;
const LIVE = 'notes/live-page';
const GONE = 'notes/gone-page';
const MODEL = 'test:model';

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const slug of [LIVE, GONE]) {
    await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `body of ${slug}` }, { sourceId: 'default' });
    await engine.upsertChunks(slug, [{
      chunk_index: 0, chunk_text: `chunk of ${slug}`, chunk_source: 'compiled_truth', token_count: 4,
    }], { sourceId: 'default' });
  }
  expect(await engine.softDeletePage(GONE, { sourceId: 'default' })).not.toBeNull();
});

afterAll(async () => {
  await engine.disconnect();
});

describe('stale-chunk selectors and soft-deleted pages', () => {
  test('a soft-deleted page is not stale: count, char sum and every listing variant see only live pages', async () => {
    expect(await engine.countStaleChunks()).toBe(1);
    expect(await engine.countStaleChunks({ sourceId: 'default' })).toBe(1);
    expect(await engine.sumStaleChunkChars()).toBe(`chunk of ${LIVE}`.length);
    for (const orderBy of ['page_id', 'updated_desc'] as const) {
      for (const sourceId of [undefined, 'default']) {
        const rows = await engine.listStaleChunks({ orderBy, ...(sourceId ? { sourceId } : {}) });
        expect(rows.map((r) => r.slug)).toEqual([LIVE]);
      }
    }
  });

  test('signature-widened staleness (the migrate-embeddings census) ignores deleted pages too', async () => {
    expect(await engine.countStaleChunks({ signature: `${MODEL}:8`, includeNullSignature: true })).toBe(1);
  });

  test('migration verify: deleted-page NULL residue is reported, not a blocker; health reports live missing chunks', async () => {
    const dims = (await readContentChunksEmbeddingDim(engine)).dims!;
    const vec = `[${Array.from({ length: dims }, () => '0.1').join(',')}]`;
    // The live page converges in the target space; the deleted page keeps its NULL chunk.
    await engine.executeRaw(
      `UPDATE content_chunks SET embedding = $1::vector, model = $2, embedded_text_hash = md5(chunk_text)
        WHERE page_id = (SELECT id FROM pages WHERE slug = $3)`, [vec, MODEL, LIVE]);
    await engine.executeRaw(`UPDATE pages SET embedding_signature = $1 WHERE slug = $2`, [`${MODEL}:${dims}`, LIVE]);

    const v = await verifyMigrationComplete(engine, { toModel: MODEL, toDims: dims }, { filePlane: { model: MODEL, dims } });
    expect(v.details.stale_wide).toBe(0);
    expect(v.details.missing_embeddings).toBe(0); // upstream excludes deleted pages
    expect(v.details.deleted_page_null_chunks).toBe(1);
    expect(v.blockers.filter((b) => /not in the target embedding space|NULL vectors outside the stale predicate/.test(b))).toEqual([]);
  });

  test('deleted residue never subtracts a live missing-vector blocker twice', async () => {
    const { splitDeletedPageNull } = await import('../src/core/embedding-invalidation.ts');
    expect(await splitDeletedPageNull(engine, 1)).toEqual({ deletedNull: 1, liveMissing: 1 });
  });

  test('a restored page is stale again', async () => {
    expect(await engine.restorePage(GONE, { sourceId: 'default' })).toBe(true);
    expect(await engine.countStaleChunks()).toBe(1);
    const rows = await engine.listStaleChunks({});
    expect(rows.map((r) => r.slug)).toEqual([GONE]);
  });
});
