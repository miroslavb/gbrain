// Managed atom extraction must not re-spend or starve on items that cannot
// finish: (A) a batch whose candidates all fail the quality gates closes like a
// zero-yield scan instead of being re-extracted on every run, and (B) a page
// whose current content already has a FAILED batch leaves discovery and the
// backlog (it waits for an explicit retry or an edit) instead of filling the
// bounded discovery window with replays.
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import type { ChatResult } from '../src/core/ai/gateway.ts';
import type { AtomSemanticValidator } from '../src/core/cycle/atom-safety.ts';
import { countExtractAtomsBacklog, discoverExtractablePages, runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import { countManagedAtomFailures } from '../src/core/persistence/atom-maintenance.ts';
import { stopPersistenceConsumer } from '../src/core/persistence/service.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { GROUNDED_ATOM_EVIDENCE } from './helpers/fork-grounded-atoms.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
beforeEach(async () => { await stopPersistenceConsumer(engine); await resetPgliteState(engine); });
afterAll(async () => { await engine.disconnect(); resetGateway(); });

const ATOM = '[{"title":"Measured progress","atom_type":"insight","body":"Measure progress against clear exit criteria.","source_quote":"Measure progress against clear exit criteria."}]';
const reply = (text: string): ChatResult => ({ text, blocks: [], stopReason: 'end',
  usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' });
const rejectAtomicity: AtomSemanticValidator = async ({ candidates }) => ({ verdicts: candidates.map((_, index) => ({ index,
  scores: { source_support: 1, exactly_one_claim: 0, self_contained: 1, no_hidden_causation_or_overgeneralization: 1, no_sensitive_content: 1 } })) });

async function managedPage(home: string, body: string) {
  await engine.putPage('notes/example', { type: 'note', title: 'Example', compiled_truth: body, frontmatter: { atom_extract: true } });
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return (await engine.getPage('notes/example', { sourceId: 'default' }))!;
}

function inManagedHome(fn: (home: string) => Promise<void>) {
  return async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-managed-starvation-'));
    try { await withEnv({ GBRAIN_HOME: home }, () => fn(home)); }
    finally { await stopPersistenceConsumer(engine); rmSync(home, { recursive: true, force: true }); }
  };
}

test('a managed batch whose candidates all fail the quality gates closes instead of re-extracting every run', inManagedHome(async home => {
  const page = await managedPage(home, 'A project record. '.repeat(40) + GROUNDED_ATOM_EVIDENCE);
  let calls = 0;
  const opts = { _transcripts: [], _pages: [{ slug: page.slug, content: page.compiled_truth, contentHash: page.content_hash! }],
    _chat: async () => { calls++; return reply(ATOM); }, _semanticValidator: rejectAtomicity };
  const first = await runPhaseExtractAtoms(engine, opts);
  expect(first.details?.atoms_extracted).toBe(0);
  expect(first.details?.rejected_by_reason).toEqual({ semantic_atomicity: 1 });
  expect(first.details?.tombstoned_for_quality_rejections).toEqual([page.slug]);
  await runPhaseExtractAtoms(engine, opts);
  expect(calls).toBe(1);
  expect(await discoverExtractablePages(engine, 'default')).toEqual([]);
  expect(await countManagedAtomFailures(engine, 'default')).toBe(0);
}), 60_000);

test('a page whose current content has a failed managed batch leaves discovery and the backlog until it is edited', inManagedHome(async home => {
  const page = await managedPage(home, 'A project record. '.repeat(40) + GROUNDED_ATOM_EVIDENCE);
  expect((await discoverExtractablePages(engine, 'default')).map(p => p.slug)).toEqual([page.slug]);
  const failed = await runPhaseExtractAtoms(engine, { _transcripts: [], _pages: [{ slug: page.slug, content: page.compiled_truth, contentHash: page.content_hash! }],
    _chat: async () => reply('["a","b"]') });
  expect(failed.details?.malformed_outputs).toBe(1);
  expect(failed.details?.managed_failures_awaiting_retry).toBe(1);
  expect(await discoverExtractablePages(engine, 'default')).toEqual([]);
  expect(await countExtractAtomsBacklog(engine, 'default')).toBe(0);
  expect(await countManagedAtomFailures(engine, 'default')).toBe(1);

  // Fixture edit: the writer guard refuses raw page writes while managed persistence is on.
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.putPage('notes/example', { type: 'note', title: 'Example', compiled_truth: 'An edited project record. '.repeat(40) + GROUNDED_ATOM_EVIDENCE, frontmatter: { atom_extract: true } });
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  expect((await discoverExtractablePages(engine, 'default')).map(p => p.slug)).toEqual([page.slug]);
  expect(await countManagedAtomFailures(engine, 'default')).toBe(0);
}), 60_000);
