/**
 * Fork patch 2026-09-27 — facts backstop extracts only new content, and the
 * entity resolver maps page-less slugs onto an unambiguous `<dir>/<token>` page.
 *
 * Regression: infra/host-map (a large living page) was re-extracted in full on
 * every write; paraphrased copies of the same claims passed the 0.95-cosine
 * dedup and piled up on entities such as `plutosky-websdr` or
 * `projects/ren5000` that have no page.
 *
 * Real PGLite engine (in-memory); the LLM is stubbed and its prompt captured.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { computeFactsDelta, MIN_DELTA_CHARS } from '../src/core/facts/delta.ts';
import { runFactsBackstop } from '../src/core/facts/backstop.ts';
import { resolveEntitySlug, resolveEntitySlugWithSource } from '../src/core/entities/resolve.ts';
import { __setChatTransportForTests, resetGateway, type ChatResult } from '../src/core/ai/gateway.ts';
import { __resetFactsQueueForTests } from '../src/core/facts/queue.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import type { MinionJobContext } from '../src/core/minions/types.ts';
import { registerBuiltinHandlers } from '../src/commands/jobs.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const slug of ['hosts/alpha-node', 'projects/beta-station', 'projects/gamma-tool', 'hosts/gamma-tool']) {
    await engine.putPage(slug, {
      type: 'note', title: slug, compiled_truth: `# ${slug}`,
      frontmatter: { type: 'note', title: slug, slug },
    }, { sourceId: 'default' });
  }
});

afterAll(async () => {
  await engine.disconnect();
});

afterEach(() => {
  __setChatTransportForTests(null);
  resetGateway();
  __resetFactsQueueForTests();
});

const prompts: string[] = [];
function capturingStub(facts: Array<{ fact: string; entity?: string | null }> = []) {
  prompts.length = 0;
  __setChatTransportForTests(async (args: unknown): Promise<ChatResult> => {
    prompts.push(JSON.stringify(args));
    return {
      text: JSON.stringify({ facts: facts.map((f) => ({ fact: f.fact, kind: 'fact', entity: f.entity ?? null, confidence: 1, notability: 'high' })) }),
      blocks: [], stopReason: 'end',
      usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'test:stub', providerId: 'test',
    };
  });
}

const OLD = [
  '# Example map',
  '',
  '## Receivers',
  '',
  '- **Station beta** — runs image v11 since 2026-09-24. Decoders run only while someone listens. Rollback file kept.',
  '',
  '| host | role |',
  '|---|---|',
  '| alpha | gateway |',
  '',
  '<!--- gbrain:facts:begin -->',
  '| 1 | old fence row | fact |',
  '<!--- gbrain:facts:end -->',
].join('\n');

describe('computeFactsDelta', () => {
  test('a new page (no previous body) extracts the whole body', () => {
    expect(computeFactsDelta(null, OLD).mode).toBe('full');
  });

  test('an identical write, a whitespace/case-only edit or a fence-only change extracts nothing', () => {
    expect(computeFactsDelta(OLD, OLD).mode).toBe('none');
    expect(computeFactsDelta(OLD, OLD.replace('runs image v11', 'runs  image   V11')).mode).toBe('none');
    const fenceOnly = OLD.replace('| 1 | old fence row | fact |', '| 1 | old fence row | fact |\n| 2 | brand new fence row with a long claim | fact |');
    expect(computeFactsDelta(OLD, fenceOnly).mode).toBe('none');
  });

  test('one sentence appended to a long bullet yields only that sentence, without heading or lead-in', () => {
    const next = OLD.replace('Rollback file kept.', 'Rollback file kept. Since 2026-09-26 the station runs image v13 with native decoders.');
    const d = computeFactsDelta(OLD, next);
    expect(d.mode).toBe('delta');
    expect(d.text).toBe('Since 2026-09-26 the station runs image v13 with native decoders.');
    // Headings and unchanged lead-ins were extracted as facts of their own (2026-09-27).
    expect(d.text).not.toContain('## Receivers');
    expect(d.text).not.toContain('Station beta');
    expect(d.text).not.toContain('Decoders run only while someone listens');
    expect(d.text).not.toContain('old fence row');
    expect(d.newUnits).toBe(1);
  });

  test('a new table row carries its header, not the old rows', () => {
    const next = OLD.replace('| alpha | gateway |', '| alpha | gateway |\n| gamma | build worker with sixteen cores |');
    const d = computeFactsDelta(OLD, next);
    expect(d.mode).toBe('delta');
    expect(d.text).toContain('| host | role |');
    expect(d.text).toContain('| gamma | build worker with sixteen cores |');
    expect(d.text).not.toContain('| alpha | gateway |');
  });

  test(`new text shorter than ${MIN_DELTA_CHARS} chars is cosmetic`, () => {
    expect(computeFactsDelta(OLD, OLD + '\n\nOK.').mode).toBe('none');
  });

  test('a rewrite of most sentences falls back to the full body', () => {
    const next = '# Example map\n\n' + Array.from({ length: 10 }, (_, i) => `Completely new sentence number ${i} about the map.`).join(' ');
    expect(computeFactsDelta(OLD, next).mode).toBe('full');
  });
});

describe('runFactsBackstop with previous_compiled_truth', () => {
  const page = (body: string, previous?: string | null) => ({
    slug: 'infra/example-map', type: 'note' as const, compiled_truth: body,
    frontmatter: {} as Record<string, unknown>,
    ...(previous !== undefined ? { previous_compiled_truth: previous } : {}),
  });
  const ctx = { engine: undefined as unknown as PGLiteEngine, sourceId: 'default', sessionId: null, source: 'mcp:put_page' as const, mode: 'inline' as const };

  test('no new sentences: skipped before any LLM call', async () => {
    capturingStub();
    const r = await runFactsBackstop(page(OLD, OLD), { ...ctx, engine });
    expect(r.mode).toBe('inline');
    if (r.mode === 'inline') expect(r.skipped).toBe('eligibility_failed:no_new_content');
    expect(prompts.length).toBe(0);
  });

  test('only the new sentence reaches the extractor', async () => {
    capturingStub();
    const next = OLD.replace('Rollback file kept.', 'Rollback file kept. Since 2026-09-26 the station runs image v13 with native decoders.');
    await runFactsBackstop(page(next, OLD), { ...ctx, engine });
    expect(prompts.length).toBe(1);
    expect(prompts[0]).toContain('runs image v13 with native decoders');
    expect(prompts[0]).not.toContain('Decoders run only while someone listens');
  });

  test('legacy callers without previous_compiled_truth still extract the whole page', async () => {
    capturingStub();
    await runFactsBackstop(page(OLD), { ...ctx, engine });
    expect(prompts.length).toBe(1);
    expect(prompts[0]).toContain('Decoders run only while someone listens');
  });
});

describe('facts-absorb handler uses the payload delta', () => {
  test('extract_text from the job is what the extractor sees', async () => {
    const worker = new MinionWorker(engine, { queue: 'test' });
    await registerBuiltinHandlers(worker, engine, { quiet: true });
    const handler = worker.getHandler('facts-absorb');
    await engine.executeRaw(
      `INSERT INTO pages (slug, source_id, type, title, compiled_truth) VALUES ($1, 'default', 'note', $1, $2)`,
      ['infra/delta-job-map', OLD],
    );
    capturingStub();
    const job: MinionJobContext = {
      id: 1, name: 'facts-absorb',
      data: { slug: 'infra/delta-job-map', sourceId: 'default', source: 'mcp:put_page', extract_text: '## Receivers\nThe delta-only sentence about station beta moving to v13.' },
      attempts_made: 0, signal: new AbortController().signal, deadlineAtMs: null,
      shutdownSignal: new AbortController().signal, updateProgress: async () => {}, updateTokens: async () => {},
      log: async () => {}, isActive: async () => true, readInbox: async () => [],
    };
    await handler!(job);
    expect(prompts.length).toBe(1);
    expect(prompts[0]).toContain('delta-only sentence about station beta');
    expect(prompts[0]).not.toContain('Decoders run only while someone listens');
  });
});

describe('entity resolver: unambiguous <dir>/<token> before a page-less slug', () => {
  test('a hyphenated bare slug resolves to its only directory page', async () => {
    expect(await resolveEntitySlug(engine, 'default', 'beta-station')).toBe('projects/beta-station');
    expect(await resolveEntitySlugWithSource(engine, 'default', 'beta-station'))
      .toEqual({ slug: 'projects/beta-station', source: 'exact_page' });
  });

  test('a wrong-directory slug moves to the directory that has the page', async () => {
    expect(await resolveEntitySlug(engine, 'default', 'projects/alpha-node')).toBe('hosts/alpha-node');
  });

  test('two directory pages for the same token stay unresolved (no guess)', async () => {
    expect(await resolveEntitySlug(engine, 'default', 'people/gamma-tool')).toBe('people/gamma-tool');
  });

  test('an exact existing slug is untouched', async () => {
    expect(await resolveEntitySlug(engine, 'default', 'projects/gamma-tool')).toBe('projects/gamma-tool');
  });
});

describe('entity resolver: bare-token ambiguity is preserved', () => {
  test('a bare token with an exact page and a prefix sibling is not guessed', async () => {
    await engine.putPage('people/delta-person', {
      type: 'person', title: 'Delta Person', compiled_truth: '# Delta Person',
      frontmatter: { type: 'person', title: 'Delta Person', slug: 'people/delta-person' },
    }, { sourceId: 'default' });
    await engine.putPage('hosts/delta', {
      type: 'note', title: 'delta', compiled_truth: '# delta',
      frontmatter: { type: 'note', title: 'delta', slug: 'hosts/delta' },
    }, { sourceId: 'default' });
    expect(await resolveEntitySlug(engine, 'default', 'delta')).toBe('delta');
  });

  test('a bare token with only an exact directory page resolves to it', async () => {
    expect(await resolveEntitySlug(engine, 'default', 'alpha-node')).toBe('hosts/alpha-node');
  });
});
