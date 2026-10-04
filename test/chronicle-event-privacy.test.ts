/**
 * #5876 (C4/E7) — Life Chronicle events inherit their origin's privacy.
 *
 * Host policy: agent-facing remote and local operations both include legacy
 * private material. New events retain their origin metadata, and explicit
 * engine visibility filters remain available. Source grants and document ACLs
 * are separate boundaries exercised by their own conformance suites.
 * Seams: none; in-memory PGLite (unmanaged, so legacy event rows can be seeded directly).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { requirePostgresTestDatabase } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { runChronicleExtract } from '../src/core/chronicle/extract-events.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';

let engine: BrainEngine;
let closeEngine: () => Promise<void>;
const now = new Date();
const day = now.toISOString().slice(0, 10);
const lastYearDay = `${now.getUTCFullYear() - 1}${day.slice(4)}`;
const BODY = 'Alice and Bob reviewed the launch plan and agreed on the next steps for the beta. '.repeat(3);
const ctx = (remote: boolean) => ({ engine, remote, sourceId: 'default', config: { engine: 'pglite', embedding_disabled: true },
  dryRun: false, logger: { info() {}, warn() {}, error() {} } }) as unknown as OperationContext;

/** A legacy (pre-rule) event: no visibility of its own, only `event.depth`. */
async function legacyEvent(slug: string, depth: string, what: string, date = day) {
  const content = `---\ntype: event\ntitle: ${what}\ncaptured_via: life-chronicle:auto\nevent:\n  when: '${date}'\n  who: []\n  what: ${what}\n  kind: meeting\n  depth: ${depth}\n---\n\n${what} — see [[${depth}]].\n`;
  await importFromContent(engine, slug, content, { noEmbed: true });
  await engine.upsertEventProjection({ depthSlug: depth, eventSlug: slug, date, summary: what, sourceId: 'default' });
}

beforeAll(async () => {
  if (process.env.GBRAIN_TEST_BACKEND === 'postgres') {
    const pg = await isolatedPersistencePostgres(requirePostgresTestDatabase());
    engine = pg.engine; closeEngine = pg.close;
  } else {
    const pglite = new PGLiteEngine();
    await pglite.connect({}); await pglite.initSchema();
    engine = pglite; closeEngine = () => pglite.disconnect();
  }
  __resetPrivateVisibilityCacheForTests();
  await engine.putPage('meetings/world', { type: 'meeting', title: 'World', compiled_truth: BODY });
  await engine.putPage('meetings/private', { type: 'meeting', title: 'Private', compiled_truth: BODY, frontmatter: { visibility: 'private' } });
  await engine.putPage('notes/secret', { type: 'note', title: 'Secret', compiled_truth: BODY, frontmatter: { visibility: 'private' } });
  await engine.putPage('meetings/derived', { type: 'meeting', title: 'Derived', compiled_truth: BODY, frontmatter: { derived_from: ['notes/secret'] } });
  await legacyEvent('life/events/world-1', 'meetings/world', 'Worldwide launch sync');
  await legacyEvent('life/events/private-1', 'meetings/private', 'Confidential launch sync');
  await legacyEvent('life/events/private-2', 'meetings/private', 'Confidential anniversary launch', lastYearDay);
  await legacyEvent('life/events/derived-1', 'meetings/derived', 'Lineage launch sync');
  // The origin page was renamed after extraction: the event now points at nothing.
  await engine.putPage('meetings/renamed', { type: 'meeting', title: 'Renamed', compiled_truth: BODY });
  await legacyEvent('life/events/orphan-1', 'meetings/renamed', 'Orphaned launch sync');
  await engine.executeRaw("UPDATE pages SET slug='meetings/renamed-later' WHERE slug='meetings/renamed'");
  await legacyEvent('life/events/world-2', 'meetings/world', 'Worldwide anniversary launch', lastYearDay);
}, 120_000);
afterAll(async () => { await closeEngine(); });

const LEGACY = ['life/events/private-1', 'life/events/private-2', 'life/events/derived-1', 'life/events/orphan-1'];

describe('remote callers', () => {
  test('world-only get_page includes legacy-lineage and orphaned events', async () => {
    for (const slug of LEGACY) {
      const got = await operationsByName.get_page.handler(ctx(true), { slug }).then((p) => p, (e: unknown) => e);
      expect(got).toMatchObject({ slug });
    }
    expect(await operationsByName.get_page.handler(ctx(true), { slug: 'life/events/world-1' })).toMatchObject({ slug: 'life/events/world-1' });
  });

  test('world-only search includes legacy events', async () => {
    const hits = await operationsByName.search.handler(ctx(true), { query: 'launch', limit: 50 }) as Array<{ slug: string }>;
    const slugs = hits.map((h) => h.slug);
    expect(slugs).toContain('life/events/world-1');
    for (const slug of LEGACY) expect(slugs).toContain(slug);
  });

  test('world-only Chronicle reads include the same legacy projections as local reads', async () => {
    const summaries = (rows: unknown) => (rows as Array<{ summary: string }>).map((r) => r.summary).sort();
    expect(summaries(await operationsByName.chronicle_day.handler(ctx(true), { date: day }))).toEqual(['Confidential launch sync', 'Lineage launch sync', 'Orphaned launch sync', 'Worldwide launch sync']);
    expect(summaries(await operationsByName.chronicle_since.handler(ctx(true), { date: lastYearDay })))
      .toEqual(['Confidential anniversary launch', 'Confidential launch sync', 'Lineage launch sync', 'Orphaned launch sync', 'Worldwide anniversary launch', 'Worldwide launch sync']);
    expect(summaries(await operationsByName.chronicle_on_this_day.handler(ctx(true), { date: day }))).toEqual(['Confidential anniversary launch', 'Worldwide anniversary launch']);
  });
});

describe('trusted local callers', () => {
  test('see every event', async () => {
    for (const slug of LEGACY) expect(await operationsByName.get_page.handler(ctx(false), { slug })).toMatchObject({ slug });
    expect((await operationsByName.chronicle_day.handler(ctx(false), { date: day }) as unknown[]).length).toBe(4);
  });
});

describe('new events carry the origin visibility (C4b)', () => {
  test('an extraction from a private meeting writes a private event', async () => {
    const r = await runChronicleExtract(engine, { slug: 'meetings/private', judge: async () => ({ events: [{ when: day, who: [], what: 'Fresh private decision', kind: 'decision' }] }) });
    expect(r.status).toBe('extracted');
    const [row] = await engine.executeRaw<{ visibility: string }>(
      "SELECT frontmatter->>'visibility' AS visibility FROM pages WHERE type='event' AND frontmatter->'event'->>'what'='Fresh private decision'");
    expect(row.visibility).toBe('private');
  });
});
