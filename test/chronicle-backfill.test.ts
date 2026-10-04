/**
 * v0.42.x — Life Chronicle (#2390) backfill op (Phase A.8); #5876 ledger semantics.
 *
 * Protects: backfill queues ledger rows (trigger 'backfill') the `chronicle`
 * phase executes; it needs explicit consent (--yes) and a dry run changes
 * nothing; discovery finds rescue-prefix pages of any type; --limit is one
 * global cap; --since filters on the update date and --dated-since on the
 * page's own date; --recent applies the recency window; the dry run reports
 * an estimated cost and skip reasons; repeat runs progress through every page
 * (#5329) and never re-queue content already extracted or queued.
 * Seams: none; in-memory PGLite.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { runChronicleBackfill } from '../src/core/chronicle/backfill.ts';

let engine: PGLiteEngine;
const mkCtx = (): OperationContext => ({ engine, remote: false, sourceId: 'default' } as unknown as OperationContext);
const LONG = 'B'.repeat(120);
type R = { queued: number; already_done: number; eligible: number; skipped: Record<string, number>; estimated_usd: number | 'unpriced';
  next_command: string; ask_user: boolean; dry_run: boolean; limit_reached: boolean; message: string };
const run = async (p: Record<string, unknown>, ctx = mkCtx()) => await operationsByName.chronicle_backfill.handler(ctx, p) as R;
async function queued() {
  return (await engine.executeRaw<{ slug: string; source_id: string }>(
    "SELECT slug, source_id FROM chronicle_page_state WHERE trigger='backfill' AND state='pending' ORDER BY slug")).map((r) => `${r.source_id}:${r.slug}`);
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await engine.executeRaw('DELETE FROM chronicle_page_state');
  await engine.executeRaw(`DELETE FROM pages WHERE slug LIKE 'meetings/%' OR slug LIKE 'conversations/%' OR slug LIKE 'life/%'`);
});

describe('chronicle_backfill op', () => {
  test('dry-run counts eligible meetings without queuing; a live run without --yes queues nothing and asks', async () => {
    await engine.putPage('meetings/m1', { type: 'meeting', title: 'm1', compiled_truth: LONG });
    await engine.putPage('meetings/m2', { type: 'meeting', title: 'm2', compiled_truth: LONG });
    await engine.putPage('life/diary/d1', { type: 'diary', title: 'd1', compiled_truth: LONG }); // excluded
    const dry = await run({ dry_run: true });
    expect(dry).toMatchObject({ eligible: 2, queued: 2, dry_run: true, ask_user: true, next_command: 'gbrain chronicle-backfill --limit 1000 --yes' });
    const unconsented = await run({});
    expect(unconsented).toMatchObject({ queued: 2, dry_run: true, ask_user: true });
    expect(unconsented.message).toContain('needs --yes; nothing was queued');
    expect(await queued()).toEqual([]);
  });

  test('--yes queues one backfill row per eligible meeting and names the run command', async () => {
    await engine.putPage('meetings/m1', { type: 'meeting', title: 'm1', compiled_truth: LONG });
    await engine.putPage('meetings/m2', { type: 'meeting', title: 'm2', compiled_truth: LONG });
    const r = await run({ yes: true });
    expect(r).toMatchObject({ eligible: 2, queued: 2, dry_run: false, ask_user: false, next_command: 'gbrain dream --phase chronicle' });
    expect(await queued()).toEqual(['default:meetings/m1', 'default:meetings/m2']);
  });

  test('unscoped backfill queues each page under its own source', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('other-src', 'other-src') ON CONFLICT (id) DO NOTHING`);
    await engine.putPage('meetings/default-src', { type: 'meeting', title: 'default', compiled_truth: LONG });
    await engine.putPage('meetings/other-src', { type: 'meeting', title: 'other', compiled_truth: LONG }, { sourceId: 'other-src' });
    const r = await run({ yes: true }, { engine, remote: false } as unknown as OperationContext);
    expect(r.queued).toBe(2);
    expect(await queued()).toEqual(['default:meetings/default-src', 'other-src:meetings/other-src']);
  });

  // #5329: repeat runs used to enqueue the same head pages forever.
  test('#5329: repeat runs with a small limit progress through every page, then queue nothing', async () => {
    for (const n of [1, 2, 3]) await engine.putPage(`meetings/m${n}`, { type: 'meeting', title: `m${n}`, compiled_truth: LONG });
    for (let i = 0; i < 3; i++) expect((await run({ limit: 1, yes: true })).queued).toBe(1);
    await engine.executeRaw(`UPDATE chronicle_page_state SET state = 'extracted'`);
    const again = await run({ limit: 1, yes: true });
    expect(again).toMatchObject({ queued: 0, already_done: 3 });
    expect((await engine.executeRaw('SELECT 1 FROM chronicle_page_state')).length).toBe(3);
  });

  test('#5329: an edited page is swept again; a row that exhausted its attempts does not block a retry', async () => {
    await engine.putPage('meetings/m1', { type: 'meeting', title: 'm1', compiled_truth: LONG });
    await engine.putPage('meetings/m2', { type: 'meeting', title: 'm2', compiled_truth: LONG });
    await run({ yes: true });
    await engine.executeRaw(`UPDATE chronicle_page_state SET state = 'extracted' WHERE slug = 'meetings/m1'`);
    await engine.putPage('meetings/m1', { type: 'meeting', title: 'm1', compiled_truth: LONG + ' edited' });
    await engine.executeRaw(`UPDATE chronicle_page_state SET state = 'failed', attempts = 5 WHERE slug = 'meetings/m2'`);
    const r = await run({ yes: true });
    expect(r).toMatchObject({ queued: 2, already_done: 0 });
  });
});

describe('#5876 discovery and filters (D6/E10)', () => {
  test('a note-typed page under meetings/ is found (rescue prefix)', async () => {
    await engine.putPage('meetings/typed-note', { type: 'note', title: 'n', compiled_truth: LONG });
    expect((await run({ dry_run: true })).eligible).toBe(1);
  });

  test('--limit is one global cap across types', async () => {
    await engine.putPage('meetings/m1', { type: 'meeting', title: 'm1', compiled_truth: LONG });
    await engine.putPage('conversations/c1', { type: 'conversation', title: 'c1', compiled_truth: LONG });
    const r = await run({ limit: 1, yes: true });
    expect(r).toMatchObject({ queued: 1, limit_reached: true });
    expect(await queued()).toHaveLength(1);
  });

  test('--dated-since filters on the page date; --since on the update date; --recent applies the window', async () => {
    await engine.putPage('meetings/old', { type: 'meeting', title: 'old', compiled_truth: LONG, frontmatter: { date: '2024-01-05' } });
    await engine.putPage('meetings/new', { type: 'meeting', title: 'new', compiled_truth: LONG, frontmatter: { date: new Date().toISOString().slice(0, 10) } });
    expect((await run({ dry_run: true, dated_since: '2025-01-01' }))).toMatchObject({ queued: 1, skipped: { before_dated_since: 1 } });
    expect((await run({ dry_run: true, since: '2020-01-01' })).queued).toBe(2); // both were updated today
    expect((await run({ dry_run: true, recent: true }))).toMatchObject({ queued: 1, skipped: { history: 1 } });
    expect((await run({ dry_run: true })).queued).toBe(2); // backfill is the history path: no recency by default
  });

  test('a dry run estimates USD at the model price, or says unpriced', async () => {
    await engine.putPage('meetings/m1', { type: 'meeting', title: 'm1', compiled_truth: LONG });
    const priced = await runChronicleBackfill(engine, { dryRun: true, model: 'anthropic:claude-sonnet-4-6' });
    expect(typeof priced.estimated_usd).toBe('number');
    expect(priced.estimated_usd as number).toBeGreaterThan(0);
    expect(priced.estimated_usd as number).toBeLessThanOrEqual(0.25);
    expect(priced.message).toContain('Ask the user before running');
    expect((await runChronicleBackfill(engine, { dryRun: true, model: 'openai:gpt-unpriced-example' })).estimated_usd).toBe('unpriced');
  });

  test('a future invite is skipped as not_yet_happened', async () => {
    const end = new Date(Date.now() + 86_400_000).toISOString();
    await engine.putPage('meetings/invite', { type: 'meeting', title: 'i', compiled_truth: LONG, frontmatter: { start: end, end } });
    expect(await run({ dry_run: true })).toMatchObject({ queued: 0, skipped: { not_yet_happened: 1 } });
  });

  test('uses the shared message_count gate for dry-run and queue admission', async () => {
    await engine.putPage('conversations/short', {
      type: 'conversation', title: 'short', compiled_truth: LONG,
      frontmatter: { message_count: 99 },
    });
    await engine.putPage('conversations/threshold', {
      type: 'conversation', title: 'threshold', compiled_truth: LONG,
      frontmatter: { message_count: 100 },
    });
    await engine.putPage('conversations/legacy', {
      type: 'conversation', title: 'legacy', compiled_truth: LONG,
      frontmatter: {},
    });
    await engine.putPage('conversations/rescue-short', {
      type: 'note', title: 'rescue short', compiled_truth: LONG,
      frontmatter: { message_count: 99 },
    });
    await engine.putPage('conversations/rescue-threshold', {
      type: 'note', title: 'rescue threshold', compiled_truth: LONG,
      frontmatter: { message_count: 100 },
    });
    await engine.putPage('meetings/tiny', {
      type: 'meeting', title: 'tiny', compiled_truth: LONG,
      frontmatter: { message_count: 1 },
    });
    await engine.putPage('calendar/tiny', {
      type: 'calendar-event', title: 'calendar tiny', compiled_truth: LONG,
      frontmatter: { message_count: 1 },
    });

    const preview = await operationsByName.chronicle_backfill.handler(mkCtx(), { dry_run: true }) as {
      scanned: number; eligible: number; enqueued: number;
    };
    expect(preview.scanned).toBe(7);
    expect(preview.eligible).toBe(5);
    expect(preview.enqueued).toBe(0);

    const applied = await operationsByName.chronicle_backfill.handler(mkCtx(), {}) as {
      eligible: number; enqueued: number; errors: unknown[];
    };
    expect(applied.eligible).toBe(5);
    expect(applied.enqueued).toBe(5);
    expect(applied.errors).toHaveLength(0);
    const jobs = await engine.executeRaw<{ data: { slug: string } }>(
      `SELECT data FROM minion_jobs WHERE name='chronicle_extract' ORDER BY data->>'slug'`,
    );
    expect(jobs.map((j) => j.data.slug)).toEqual([
      'calendar/tiny',
      'conversations/legacy',
      'conversations/rescue-threshold',
      'conversations/threshold',
      'meetings/tiny',
    ]);
  });

  test('max_total is a hot-first global cap across page types', async () => {
    await engine.putPage('meetings/old', {
      type: 'meeting', title: 'old meeting', compiled_truth: LONG,
    });
    await engine.putPage('conversations/new', {
      type: 'conversation', title: 'new conversation', compiled_truth: LONG,
      frontmatter: { message_count: 100 },
    });
    await engine.putPage('calendar/middle', {
      type: 'calendar-event', title: 'middle calendar event', compiled_truth: LONG,
    });
    await engine.executeRaw(`UPDATE pages SET updated_at = '2026-01-01T00:00:00Z' WHERE slug = 'meetings/old'`);
    await engine.executeRaw(`UPDATE pages SET updated_at = '2026-01-02T00:00:00Z' WHERE slug = 'calendar/middle'`);
    await engine.executeRaw(`UPDATE pages SET updated_at = '2026-01-03T00:00:00Z' WHERE slug = 'conversations/new'`);

    const preview = await operationsByName.chronicle_backfill.handler(mkCtx(), {
      dry_run: true, limit: 1, max_total: 2,
    }) as { scanned: number; eligible: number; enqueued: number; limit_reached: boolean };
    expect(preview).toMatchObject({ scanned: 2, eligible: 2, enqueued: 0, limit_reached: true });

    const applied = await operationsByName.chronicle_backfill.handler(mkCtx(), {
      limit: 1, max_total: 2,
    }) as { scanned: number; eligible: number; enqueued: number; limit_reached: boolean; errors: unknown[] };
    expect(applied).toMatchObject({ scanned: 2, eligible: 2, enqueued: 2, limit_reached: true });
    expect(applied.errors).toHaveLength(0);
    const jobs = await engine.executeRaw<{ data: { slug: string } }>(
      `SELECT data FROM minion_jobs WHERE name='chronicle_extract'`,
    );
    expect(jobs.map((j) => j.data.slug).sort()).toEqual([
      'calendar/middle',
      'conversations/new',
    ]);
  });
});


describe('host bounded hot-first Chronicle admission', () => {
  test('shared metadata threshold and zero/invalid caps fail closed', async () => {
    await engine.putPage('conversations/short', { type: 'conversation', title: 'short', compiled_truth: LONG, frontmatter: { message_count: 99 } });
    await engine.putPage('conversations/long', { type: 'conversation', title: 'long', compiled_truth: LONG, frontmatter: { message_count: 100 } });
    expect((await run({ dry_run: true })).skipped.short_conversation).toBe(1);
    for (const max_total of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect((await run({ max_total, yes: true })).queued).toBe(0);
      expect(await queued()).toEqual([]);
    }
  });

  test('max_total chooses newest content globally rather than first page ID', async () => {
    await engine.putPage('meetings/older', { type: 'meeting', title: 'older', compiled_truth: LONG });
    await engine.putPage('conversations/newer', { type: 'conversation', title: 'newer', compiled_truth: LONG, frontmatter: { message_count: 100 } });
    await engine.executeRaw("UPDATE pages SET updated_at=now()-interval '2 days' WHERE slug='meetings/older'");
    expect((await run({ yes: true, max_total: 1 })).queued).toBe(1);
    expect(await queued()).toEqual(['default:conversations/newer']);
  });
});
