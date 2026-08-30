/** World-only host visibility contract plus legacy-row compatibility. */

import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import {
  resolveDefaultVisibility,
  resolveVisibilityParam,
  FACTS_DEFAULT_VISIBILITY_KEY,
} from '../src/core/facts/visibility.ts';
import { runFactsBackstop } from '../src/core/facts/backstop.ts';
import { __setChatTransportForTests } from '../src/core/ai/gateway.ts';
import {
  markShortLivedCliProcess,
  __resetShortLivedCliForTests,
} from '../src/core/facts/cli-process-mode.ts';
import type { BrainEngine } from '../src/core/engine.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.insertFact(
    { fact: 'world-visible', kind: 'fact', entity_slug: 'vis-test', source: 'test', visibility: 'world' },
    { source_id: 'default' },
  );
  const legacy = await engine.insertFact(
    { fact: 'private-only', kind: 'fact', entity_slug: 'vis-test', source: 'test', visibility: 'private' },
    { source_id: 'default' },
  );
  // The writer above normalizes to world. Recreate one legacy row directly so
  // reads prove convergence does not hide pre-policy material.
  await engine.executeRaw(`UPDATE facts SET visibility = 'private' WHERE id = $1`, [legacy.id]);
});

afterAll(async () => {
  await engine.disconnect();
});

describe('visibility column', () => {
  test('insertFact normalizes even an explicit private input to world', async () => {
    await engine.insertFact(
      { fact: 'writer-normalized', kind: 'fact', entity_slug: 'write-policy', source: 'test', visibility: 'private' },
      { source_id: 'default' },
    );
    const rows = await engine.executeRaw<{ visibility: string }>(
      `SELECT visibility FROM facts WHERE entity_slug = 'write-policy'`,
    );
    expect(rows.map(r => r.visibility)).toEqual(['world']);
  });

  test('listFactsByEntity with visibility=[world] returns only world rows', async () => {
    const rows = await engine.listFactsByEntity('default', 'vis-test', { visibility: ['world'] });
    expect(rows.length).toBe(1);
    expect(rows[0].fact).toBe('world-visible');
    expect(rows[0].visibility).toBe('world');
  });

  test('listFactsByEntity with visibility=[private,world] returns both', async () => {
    const rows = await engine.listFactsByEntity('default', 'vis-test', { visibility: ['private', 'world'] });
    expect(rows.length).toBe(2);
  });

  test('listFactsByEntity with no visibility filter returns all', async () => {
    const rows = await engine.listFactsByEntity('default', 'vis-test');
    expect(rows.length).toBe(2);
  });
});

describe('recall op world-only projection', () => {
  test('remote=true sees legacy private material and projects it as world', async () => {
    const result = await dispatchToolCall(engine, 'recall', { entity: 'vis-test' }, {
      remote: true,
      sourceId: 'default',
    });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.facts.length).toBe(2);
    expect(payload.facts.map((f: { fact: string }) => f.fact).sort()).toEqual(['private-only', 'world-visible']);
    expect(payload.facts.every((f: { visibility: string }) => f.visibility === 'world')).toBe(true);
  });

  test('remote=false uses the same world-only projection', async () => {
    const result = await dispatchToolCall(engine, 'recall', { entity: 'vis-test' }, {
      remote: false,
      sourceId: 'default',
    });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.facts.length).toBe(2);
    expect(payload.facts.every((f: { visibility: string }) => f.visibility === 'world')).toBe(true);
  });
});

// ── [ENG-8] facts.default_visibility — the ONE resolver helper ──────────────

describe('resolveDefaultVisibility [ENG-8]', () => {
  afterEach(async () => {
    await engine.unsetConfig(FACTS_DEFAULT_VISIBILITY_KEY);
  });

  test('unset config → world', async () => {
    expect(await resolveDefaultVisibility(engine)).toBe('world');
  });

  test('world opt-in resolves world (whitespace/case tolerant)', async () => {
    await engine.setConfig(FACTS_DEFAULT_VISIBILITY_KEY, 'world');
    expect(await resolveDefaultVisibility(engine)).toBe('world');
    await engine.setConfig(FACTS_DEFAULT_VISIBILITY_KEY, '  WORLD ');
    expect(await resolveDefaultVisibility(engine)).toBe('world');
  });

  test('invalid config value cannot change the host invariant', async () => {
    await engine.setConfig(FACTS_DEFAULT_VISIBILITY_KEY, 'everyone');
    expect(await resolveDefaultVisibility(engine)).toBe('world');
  });

  test('config read failure cannot change the host invariant', async () => {
    const broken = { getConfig: async () => { throw new Error('db down'); } } as unknown as BrainEngine;
    expect(await resolveDefaultVisibility(broken)).toBe('world');
  });
});

describe('resolveVisibilityParam — world is the only result', () => {
  afterEach(async () => {
    await engine.unsetConfig(FACTS_DEFAULT_VISIBILITY_KEY);
  });

  test("legacy explicit 'private' is normalized", async () => {
    await engine.setConfig(FACTS_DEFAULT_VISIBILITY_KEY, 'world');
    expect(await resolveVisibilityParam(engine, 'private')).toBe('world');
  });

  test("explicit 'world' stays world", async () => {
    expect(await resolveVisibilityParam(engine, 'world')).toBe('world');
  });

  test('unset is world regardless of config', async () => {
    await engine.setConfig(FACTS_DEFAULT_VISIBILITY_KEY, 'world');
    expect(await resolveVisibilityParam(engine, undefined)).toBe('world');
    expect(await resolveVisibilityParam(engine, null)).toBe('world');
  });

  test('unset with no config → world', async () => {
    expect(await resolveVisibilityParam(engine, undefined)).toBe('world');
  });

  test('legacy garbage cannot create a hidden tier', async () => {
    await engine.setConfig(FACTS_DEFAULT_VISIBILITY_KEY, 'world');
    expect(await resolveVisibilityParam(engine, 'banana')).toBe('world');
    expect(await resolveVisibilityParam(engine, 42)).toBe('world');
  });
});

describe('ontology_propose visibility site (operations.ts ~:5812) [ENG-8]', () => {
  afterEach(async () => {
    await engine.unsetConfig(FACTS_DEFAULT_VISIBILITY_KEY);
  });

  async function propose(entity: string, value: string, visibility?: string) {
    const result = await dispatchToolCall(engine, 'ontology_propose', {
      entity,
      dimension: 'role',
      value,
      ...(visibility ? { visibility } : {}),
    }, { remote: false, sourceId: 'default' });
    expect(result.isError).toBeFalsy();
    const rows = await engine.executeRaw<{ visibility: string }>(
      `SELECT visibility FROM facts WHERE entity_slug = $1 AND dimension = 'role' AND value = $2`,
      [entity, value],
    );
    expect(rows.length).toBe(1);
    return rows[0].visibility;
  }

  test('unset + no config → world', async () => {
    expect(await propose('people/ont-a', 'advisor')).toBe('world');
  });

  test('unset + world config → world (the config default finally reaches the op)', async () => {
    await engine.setConfig(FACTS_DEFAULT_VISIBILITY_KEY, 'world');
    expect(await propose('people/ont-b', 'advisor')).toBe('world');
  });

  test('explicit private is rejected by the public schema', async () => {
    const result = await dispatchToolCall(engine, 'ontology_propose', {
      entity: 'people/ont-c', dimension: 'role', value: 'advisor', visibility: 'private',
    }, { remote: false, sourceId: 'default' });
    expect(result.isError).toBe(true);
  });

  test('explicit world wins over the private floor', async () => {
    expect(await propose('people/ont-d', 'advisor', 'world')).toBe('world');
  });
});

describe('backstop minion-payload visibility site (backstop.ts queue mode) [ENG-8]', () => {
  // The backstop gates on extraction availability before enqueueing; this
  // block asserts the minion PAYLOAD, not availability — stub the chat
  // transport so the gate passes regardless of shard env keys.
  beforeAll(() => {
    __setChatTransportForTests(async () => ({
      text: '[]',
      blocks: [{ type: 'text', text: '[]' }],
      stopReason: 'end' as const,
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-sonnet-4-6',
      providerId: 'anthropic',
    }));
  });
  afterAll(() => { __setChatTransportForTests(null); });
  afterEach(async () => {
    __resetShortLivedCliForTests();
    await engine.unsetConfig(FACTS_DEFAULT_VISIBILITY_KEY);
    await engine.executeRaw(`DELETE FROM minion_jobs WHERE name = 'facts-absorb'`).catch(() => {});
  });

  async function submitAndReadPayload(slug: string, visibility?: 'world') {
    markShortLivedCliProcess(); // route queue mode through the durable minion job
    const r = await runFactsBackstop(
      {
        slug,
        type: 'note',
        compiled_truth: `An eligible note body for ${slug}. ${'Enough prose to clear the minimum body length gate. '.repeat(3)}`,
        frontmatter: {},
      },
      {
        engine,
        sourceId: 'default',
        sessionId: null,
        source: 'mcp:put_page',
        mode: 'queue',
        ...(visibility ? { visibility } : {}),
      },
    );
    expect(r.mode).toBe('queue');
    expect((r as { enqueued: boolean }).enqueued).toBe(true);
    const rows = await engine.executeRaw<{ data: unknown }>(
      `SELECT data FROM minion_jobs WHERE name = 'facts-absorb'`,
    );
    const payloads = rows.map((row) =>
      (typeof row.data === 'string' ? JSON.parse(row.data) : row.data) as { slug: string; visibility: string },
    );
    const mine = payloads.find((p) => p.slug === slug);
    expect(mine).toBeDefined();
    return mine!.visibility;
  }

  test('caller-unset visibility resolves the world config default at submit time', async () => {
    await engine.setConfig(FACTS_DEFAULT_VISIBILITY_KEY, 'world');
    expect(await submitAndReadPayload('wiki/notes/vis-default-world')).toBe('world');
  });

  test('explicit world remains world', async () => {
    expect(await submitAndReadPayload('wiki/notes/vis-explicit-world', 'world')).toBe('world');
  });

  test('caller-unset + no config → world', async () => {
    expect(await submitAndReadPayload('wiki/notes/vis-floor')).toBe('world');
  });
});
