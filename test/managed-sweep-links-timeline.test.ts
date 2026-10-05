/**
 * Serve idle sweep, link/timeline pass, on a managed brain.
 *
 * 1. Protects: a page written without its link/timeline projection gets its
 *    links, its canonical timeline row and its links_extracted_at watermark
 *    from the sweep, through the persistence coordinator.
 * 2. Fails when: the pass batch-inserts timeline rows or stamps the watermark
 *    outside the coordinator — the armed managed writer guard refuses with
 *    writer_coordinator_required, the pass aborts (links_timeline_error) and
 *    the page stays stale on every sweep.
 * 3. sweep.test.ts covers the same pass on an unmanaged brain.
 * 4. No production seam.
 *
 * Runs on PGLite; also on Postgres when DATABASE_URL is set (testBackends).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { runMaintenanceSweep } from '../src/core/sweep.ts';
import type { CapabilityReport } from '../src/core/capability.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';

const KEYLESS: CapabilityReport = {
  embeddings: { available: false },
  extraction: { available: false },
  search: 'keyword-only',
  mode: 'keyless',
};
const backends = testBackends();
const engines: BrainEngine[] = [];
const dataDir = mkdtempSync(join(tmpdir(), 'gbrain-managed-sweep-links-db-'));
let closePostgres: (() => Promise<void>) | undefined;

beforeAll(async () => {
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({ database_path: dataDir }); await engine.initSchema(); engines.push(engine);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(pg.engine); closePostgres = pg.close;
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.(); rmSync(dataDir, { recursive: true, force: true });
});

const MEETING = [
  '---', 'title: Meeting', 'type: note', '---',
  '# Meeting', '',
  'Talked with [Alice](people/alice-example) about the roadmap.', '',
  '## Timeline', '',
  '- **2026-01-02** | Kickoff meeting with alice-example', '',
].join('\n');

test('managed: the sweep publishes a stale page\'s links, timeline row and watermark through the coordinator', async () => {
  for (const engine of engines) {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-managed-sweep-links-'));
    const root = join(dir, 'brain'); mkdirSync(root);
    const sourceId = `links-${randomUUID().slice(0, 8)}`;
    try {
      await withEnv({ GBRAIN_HOME: join(dir, 'home'), GBRAIN_AUDIT_DIR: join(dir, 'audit') }, async () => {
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
        await engine.setConfig('sync.write_through', 'true');
        await claimWorktree(engine, sourceId, root);
        const ctx = { engine, sourceId, remote: false as const, config: { engine: engine.kind, embedding_disabled: true },
          dryRun: false, logger: { info() {}, warn() {}, error() {} } };
        await submitPageMutation(ctx, { operation: 'put_page', params: { slug: 'people/alice-example',
          content: '---\ntitle: Alice Example\ntype: person\n---\n# Alice Example\n', request_id: randomUUID() } });
        await submitPageMutation(ctx, { operation: 'put_page', params: { slug: 'notes/meeting-example',
          content: MEETING, request_id: randomUUID() } });
        await disposePersistenceConsumer(engine);
        // A page published without its projection (e.g. by a remote put_page):
        // no derived links, no timeline row, no watermark.
        const [meeting] = await engine.executeRaw<{ id: number }>(
          'SELECT id FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, 'notes/meeting-example']);
        await engine.executeRaw('DELETE FROM links WHERE from_page_id=$1', [meeting.id]);
        await engine.executeRaw('DELETE FROM timeline_entries WHERE page_id=$1', [meeting.id]);
        await engine.executeRaw('UPDATE pages SET links_extracted_at=NULL WHERE source_id=$1', [sourceId]);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        await expect(engine.executeRaw(`INSERT INTO timeline_entries(page_id,date,source,summary,detail)
          VALUES($1,'2026-01-03','test','uncoordinated','')`, [meeting.id])).rejects.toThrow(/writer_coordinator_required/);

        const r = await runMaintenanceSweep(engine, { sourceId, capabilities: KEYLESS, budgetMs: 60_000 });

        expect(r.skipped.map(s => s.reason)).not.toContain('links_timeline_error');
        expect(r.timelineExtracted).toBe(1);
        expect(r.linksExtracted).toBeGreaterThanOrEqual(1);
        const tl = await engine.executeRaw<{ summary: string }>(
          `SELECT summary FROM timeline_entries WHERE page_id=$1 AND date='2026-01-02'`, [meeting.id]);
        expect(tl.map(t => t.summary)).toEqual(['Kickoff meeting with alice-example']);
        const links = await engine.executeRaw<{ slug: string }>(
          `SELECT pt.slug FROM links l JOIN pages pt ON pt.id=l.to_page_id WHERE l.from_page_id=$1`, [meeting.id]);
        expect(links.map(l => l.slug)).toContain('people/alice-example');
        const [stamp] = await engine.executeRaw<{ stamped: boolean }>(
          'SELECT links_extracted_at IS NOT NULL AS stamped FROM pages WHERE id=$1', [meeting.id]);
        expect(stamp.stamped).toBe(true);

        // Idempotent: a second sweep finds nothing stale and adds nothing.
        const again = await runMaintenanceSweep(engine, { sourceId, capabilities: KEYLESS, budgetMs: 60_000 });
        expect(again.timelineExtracted).toBe(0);
        expect(again.skipped.map(s => s.reason)).not.toContain('links_timeline_error');
      });
    } finally {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      rmSync(dir, { recursive: true, force: true });
    }
  }
}, 180_000);
