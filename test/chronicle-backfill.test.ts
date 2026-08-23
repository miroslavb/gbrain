/**
 * v0.42.x — Life Chronicle (#2390) backfill op (Phase A.8).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;
const mkCtx = (): OperationContext => ({ engine, remote: false, sourceId: 'default' } as unknown as OperationContext);
const LONG = 'B'.repeat(120);

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await engine.executeRaw(`DELETE FROM minion_jobs WHERE name = 'chronicle_extract'`);
  await engine.executeRaw(`DELETE FROM pages
    WHERE type IN ('meeting','conversation','calendar-event','diary')
       OR slug LIKE 'conversations/rescue-%'`);
});

describe('chronicle_backfill op', () => {
  test('dry-run counts eligible meetings without enqueuing', async () => {
    await engine.putPage('meetings/m1', { type: 'meeting', title: 'm1', compiled_truth: LONG });
    await engine.putPage('meetings/m2', { type: 'meeting', title: 'm2', compiled_truth: LONG });
    await engine.putPage('life/diary/d1', { type: 'diary', title: 'd1', compiled_truth: LONG }); // excluded
    const r = await operationsByName.chronicle_backfill.handler(mkCtx(), { dry_run: true }) as { eligible: number; enqueued: number };
    expect(r.eligible).toBe(2);
    expect(r.enqueued).toBe(0);
    const jobs = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM minion_jobs WHERE name='chronicle_extract'`);
    expect(Number(jobs[0].n)).toBe(0);
  });

  test('enqueues one chronicle_extract per eligible meeting', async () => {
    await engine.putPage('meetings/m1', { type: 'meeting', title: 'm1', compiled_truth: LONG });
    await engine.putPage('meetings/m2', { type: 'meeting', title: 'm2', compiled_truth: LONG });
    const r = await operationsByName.chronicle_backfill.handler(mkCtx(), {}) as { eligible: number; enqueued: number; errors: unknown[] };
    expect(r.eligible).toBe(2);
    expect(r.enqueued).toBe(2);
    expect(r.errors).toHaveLength(0);
    const jobs = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM minion_jobs WHERE name='chronicle_extract'`);
    expect(Number(jobs[0].n)).toBe(2);
  });

  test('unscoped backfill enqueues each page under its own source', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('other-src', 'other-src') ON CONFLICT (id) DO NOTHING`);
    await engine.putPage('meetings/default-src', { type: 'meeting', title: 'default', compiled_truth: LONG });
    await engine.putPage('meetings/other-src', { type: 'meeting', title: 'other', compiled_truth: LONG }, { sourceId: 'other-src' });
    const ctx = { engine, remote: false } as unknown as OperationContext;

    const r = await operationsByName.chronicle_backfill.handler(ctx, {}) as { eligible: number; enqueued: number; errors: unknown[] };

    expect(r.eligible).toBe(2);
    expect(r.enqueued).toBe(2);
    expect(r.errors).toHaveLength(0);
    const jobs = await engine.executeRaw<{ data: { slug: string; sourceId: string } }>(
      `SELECT data FROM minion_jobs WHERE name='chronicle_extract' ORDER BY data->>'slug'`
    );
    expect(jobs.map((j) => j.data)).toEqual([
      { slug: 'meetings/default-src', sourceId: 'default' },
      { slug: 'meetings/other-src', sourceId: 'other-src' },
    ]);
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
});
