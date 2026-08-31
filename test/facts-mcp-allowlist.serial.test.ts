/**
 * v0.31 Phase 6 — MCP scope correctness on facts ops.
 *
 * Pins:
 *   - extract_facts → write scope
 *   - recall → read scope
 *   - forget_fact → write scope
 *   - All three present in operations[]
 *   - param shapes match the documented contract
 *
 * Serial test (mutates module-scoped engine state via dispatchToolCall +
 * subsequent reads).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations } from '../src/core/operations.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

describe('facts MCP ops registration + scope', () => {
  test('extract_facts is registered with write scope', () => {
    const op = operations.find(o => o.name === 'extract_facts');
    expect(op).toBeDefined();
    expect(op!.scope).toBe('write');
    expect(op!.mutating).toBe(true);
    expect(op!.params.turn_text?.required).toBe(true);
    expect(op!.params.session_id).toBeDefined();
  });

  test('recall is registered with read scope', () => {
    const op = operations.find(o => o.name === 'recall');
    expect(op).toBeDefined();
    expect(op!.scope).toBe('read');
    // recall should not be mutating.
    expect(op!.mutating).toBeFalsy();
    expect(op!.params.entity).toBeDefined();
    expect(op!.params.since).toBeDefined();
    expect(op!.params.session_id).toBeDefined();
  });

  test('forget_fact is registered with write scope', () => {
    const op = operations.find(o => o.name === 'forget_fact');
    expect(op).toBeDefined();
    expect(op!.scope).toBe('write');
    expect(op!.mutating).toBe(true);
    expect(op!.params.id?.required).toBe(true);
  });
});

describe('forget_fact dispatch', () => {
  test('forget_fact errors with fact_not_found on unknown id', async () => {
    const r = await dispatchToolCall(engine, 'forget_fact', { id: 99999 }, {
      remote: true, sourceId: 'default',
    });
    expect(r.isError).toBe(true);
    const payload = JSON.parse(r.content[0].text);
    expect(payload.error).toBe('fact_not_found');
  });

  test('forget_fact succeeds on valid id, then becomes idempotent-as-error', async () => {
    const inserted = await engine.insertFact(
      { fact: 'will be forgotten', kind: 'fact', source: 'test' },
      { source_id: 'default' },
    );
    const r1 = await dispatchToolCall(engine, 'forget_fact', { id: inserted.id }, {
      remote: true, sourceId: 'default',
    });
    expect(r1.isError).toBeFalsy();

    const r2 = await dispatchToolCall(engine, 'forget_fact', { id: inserted.id }, {
      remote: true, sourceId: 'default',
    });
    expect(r2.isError).toBe(true);
    const payload = JSON.parse(r2.content[0].text);
    // v0.32.2: more precise discriminator. The first call expires the fact;
    // the second call sees expired_at IS NOT NULL and surfaces
    // `fact_already_expired` instead of the older opaque `fact_not_found`.
    expect(payload.error).toBe('fact_already_expired');
  });

  test('forget_fact is scoped to the caller source: cross-source id reads as fact_not_found', async () => {
    await engine.executeRaw(
      "INSERT INTO sources (id, name) VALUES ('other-source', 'other-source') ON CONFLICT (id) DO NOTHING",
    );
    const inserted = await engine.insertFact(
      { fact: 'lives in another source', kind: 'fact', source: 'test' },
      { source_id: 'other-source' },
    );
    const r = await dispatchToolCall(engine, 'forget_fact', { id: inserted.id }, {
      remote: true, sourceId: 'default',
    });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).error).toBe('fact_not_found');
    const rows = await engine.executeRaw<{ expired_at: string | null }>(
      'SELECT expired_at FROM facts WHERE id = $1', [inserted.id],
    );
    expect(rows[0].expired_at).toBeNull();

    const r2 = await dispatchToolCall(engine, 'forget_fact', { id: inserted.id }, {
      remote: true, sourceId: 'other-source',
    });
    expect(r2.isError).toBeFalsy();
  });

  test('forget_fact: remote caller cannot expire a legacy private fact; local caller can', async () => {
    const inserted = await engine.insertFact(
      { fact: 'legacy private row', kind: 'fact', source: 'test' },
      { source_id: 'default' },
    );
    // insertFact is world-only by construction; simulate a pre-migration
    // legacy row the way it still exists in old brains.
    await engine.executeRaw("UPDATE facts SET visibility='private' WHERE id = $1", [inserted.id]);

    const r = await dispatchToolCall(engine, 'forget_fact', { id: inserted.id }, {
      remote: true, sourceId: 'default',
    });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).error).toBe('fact_not_found');

    const r2 = await dispatchToolCall(engine, 'forget_fact', { id: inserted.id }, {
      remote: false, sourceId: 'default',
    });
    expect(r2.isError).toBeFalsy();
  });
});

describe('extract_facts dispatch (no API key)', () => {
  test('returns inserted=0 / duplicate=0 / superseded=0 when chat gateway unavailable', async () => {
    const r = await dispatchToolCall(engine, 'extract_facts', {
      turn_text: 'I am flying to Tokyo Tuesday.',
    }, { remote: true, sourceId: 'default' });
    expect(r.isError).toBeFalsy();
    const payload = JSON.parse(r.content[0].text);
    expect(payload.inserted).toBe(0);
    expect(payload.duplicate).toBe(0);
    expect(payload.superseded).toBe(0);
    expect(Array.isArray(payload.fact_ids)).toBe(true);
  });
});
