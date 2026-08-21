import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';

let engine: PGLiteEngine;

const content = `---
type: conversation
title: Migration Repair
message_count: 120
---

${'A substantive historical session statement with enough content. '.repeat(20)}`;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

beforeEach(async () => {
  resetGateway();
  await engine.executeRaw('DELETE FROM minion_jobs');
  await engine.setConfig('auto_chronicle', 'true');
});

afterAll(async () => {
  await engine.disconnect();
});

async function jobCount(): Promise<number> {
  const rows = await engine.executeRaw<{ count: number | string }>(
    `SELECT COUNT(*) AS count FROM minion_jobs
      WHERE name IN ('facts-absorb', 'chronicle_extract')`,
  );
  return Number(rows[0]?.count ?? 0);
}

describe('put_page trusted-local migration mode', () => {
  test('persists the page while suppressing both generative backstops', async () => {
    const response = await dispatchToolCall(engine, 'put_page', {
      slug: 'sessions/codex/migration-local',
      content,
      migration_mode: true,
      source_kind: 'migration-repair',
      ingested_via: 'session-ingest-collision-repair',
    }, { remote: false, sourceId: 'default' });

    expect(response.isError).toBeFalsy();
    const payload = JSON.parse(response.content[0].text);
    expect(payload).toMatchObject({
      status: 'created_or_updated',
      backstops_skipped: 'migration',
      facts_backstop: { skipped: 'migration' },
      chronicle_backstop: { skipped: 'migration' },
    });
    expect(await engine.getPage('sessions/codex/migration-local', { sourceId: 'default' })).not.toBeNull();
    expect(await jobCount()).toBe(0);
  });

  test('remote callers cannot request migration mode', async () => {
    const response = await dispatchToolCall(engine, 'put_page', {
      slug: 'sessions/codex/migration-remote-denied',
      content,
      migration_mode: true,
    }, { remote: true, sourceId: 'default' });

    expect(response.isError).toBe(true);
    const payload = JSON.parse(response.content[0].text);
    expect(payload.error).toBe('permission_denied');
    expect(await engine.getPage('sessions/codex/migration-remote-denied', { sourceId: 'default' })).toBeNull();
    expect(await jobCount()).toBe(0);
  });

  test('ordinary local put keeps the existing Chronicle backstop path', async () => {
    const response = await dispatchToolCall(engine, 'put_page', {
      slug: 'sessions/codex/ordinary-put',
      content,
    }, { remote: false, sourceId: 'default' });

    expect(response.isError).toBeFalsy();
    const payload = JSON.parse(response.content[0].text);
    expect(payload.backstops_skipped).toBeUndefined();
    expect(payload.facts_backstop).not.toEqual({ skipped: 'migration' });
    expect(payload.chronicle_backstop).toEqual({ queued: true });
    expect(await jobCount()).toBeGreaterThanOrEqual(1);
  });
});
