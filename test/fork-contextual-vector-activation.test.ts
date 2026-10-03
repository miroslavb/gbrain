/**
 * v0.60 port decision: unproven legacy contextual vectors are invalidated even
 * during protocol activation. Raw-text hashes do not prove the title prefix
 * supplied to the embedder. The required stage rebuild/re-embed replaces the
 * retired fork shortcut; no input hash may be manufactured to reuse a vector.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MIGRATIONS } from '../src/core/migrate.ts';
import { installPageProjection, preparePageProjection, readProjectionSnapshot,
  rebuildPendingPageProjections } from '../src/core/page-state/projections.ts';

const sourceId = 'fork-contextual-activation';
const vector = new Float32Array(1536); vector[0] = 0.5; vector[2] = -0.125;
const vectorText = `[${Array.from(vector).join(',')}]`;

describe('fork contextual vector provenance on protocol activation', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$1)', [sourceId]);
  }, 120_000);
  afterAll(async () => { await engine.disconnect(); });

  async function seed(slug: string) {
    await engine.putPage(slug, { type: 'note', title: 'Contextual fixture ' + slug,
      compiled_truth: 'Synthetic juniper memory for ' + slug + '.', timeline: '',
      frontmatter: {}, source_path: `notes/${slug}.md` }, { sourceId });
    await engine.executeRaw(`UPDATE pages SET contextual_retrieval_mode='title' WHERE source_id=$1 AND slug=$2`, [sourceId, slug]);
    const prepared = (await readProjectionSnapshot(engine, slug, sourceId, { allowUnsealed: true }))!;
    const { chunks } = await preparePageProjection(prepared);
    await installPageProjection(engine, prepared, chunks, { seal: true });
    await engine.executeRaw(`UPDATE content_chunks SET embedding=$2::vector, model=$3, embedded_text_hash=md5(chunk_text),
      embedded_at=now() WHERE page_id=$1`, [prepared.snapshot.page.id, vectorText, prepared.embeddingModel]);
    return prepared.snapshot.page.id;
  }
  const vectors = (pageId: number) => engine.executeRaw<{ embedding: string | null }>(
    'SELECT embedding FROM content_chunks WHERE page_id=$1 ORDER BY chunk_index', [pageId]);

  test('activation and ordinary rebuild both clear unproven title-mode vectors', async () => {
    const kept = await seed('kept-page');
    const activation = MIGRATIONS.find(m => m.name === 'verified_text_projection_activation')!;
    expect(activation.version).toBe(161);
    await engine.transaction(tx => tx.runMigration(activation.version, activation.sql!));
    expect(await rebuildPendingPageProjections(engine, 100)).toEqual({ rebuilt: 1, superseded: 0 });
    const afterActivation = await vectors(kept);
    expect(afterActivation.length).toBeGreaterThan(0);
    for (const row of afterActivation) expect(row.embedding).toBeNull();

    // A non-activation rebuild of the same contextual page must re-embed.
    await engine.executeRaw(`UPDATE pages SET text_projection_revision=NULL WHERE id=$1`, [kept]);
    await engine.executeRaw(`INSERT INTO page_projection_jobs(source_incarnation,slug,revision,reason)
      SELECT s.incarnation,p.slug,p.knowledge_revision,'content_changed' FROM pages p JOIN sources s ON s.id=p.source_id WHERE p.id=$1`, [kept]);
    expect(await rebuildPendingPageProjections(engine, 100)).toEqual({ rebuilt: 1, superseded: 0 });
    for (const row of await vectors(kept)) expect(row.embedding).toBeNull();
  }, 120_000);
});
