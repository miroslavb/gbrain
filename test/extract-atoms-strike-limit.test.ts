// Atom items that cannot finish must close instead of waiting forever:
//  - a failed managed batch adds a strike to the page state, and the strike that reaches
//    MAX_DETERMINISTIC_FAILURES closes the page (writeAtomPageState maxFailures), as unmanaged runs did;
//  - a provider content filter (empty reply, stopReason content_filter) is reported as such,
//    not as "no JSON array in response";
//  - prose after the JSON that itself holds `]` (a `[Source: …]` note) no longer makes a valid
//    atoms array "unparseable".
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MAX_DETERMINISTIC_FAILURES, readAtomPageIdentity, writeAtomPageState } from '../src/core/cycle/extract-atoms-page-state.ts';
import { parseAtomsOutcome } from '../src/core/cycle/extract-atoms-output.ts';
import { runPhaseWithStoredPageFixtures as runPhaseExtractAtoms } from './helpers/extract-atoms-page-fixtures.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import type { ChatResult } from '../src/core/ai/gateway.ts';

const QUOTE = 'Measure progress against clear exit criteria.';
const SOURCE = 'A project record. '.repeat(40) + QUOTE;

describe('atoms parser: trailing prose', () => {
  test('a valid atoms object followed by a note that holds `]` still parses', () => {
    const reply = JSON.stringify({ atoms: [{ title: 'Exit criteria', atom_type: 'insight', body: QUOTE, source_quote: QUOTE }] })
      + '\n\nNote: body equals the quote [Source: the page above]; nothing else changed.';
    const out = parseAtomsOutcome(reply, SOURCE);
    expect(out.ok && out.atoms.map(a => a.source_quote)).toEqual([QUOTE]);
  });
});

describe('atom page state and provider blocks', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
  afterAll(async () => { await engine.disconnect(); });
  beforeEach(async () => { await resetPgliteState(engine); });

  async function pinned(slug: string) {
    await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: SOURCE } as never, { sourceId: 'default' });
    const [page] = await engine.executeRaw<{ content_hash: string }>("SELECT content_hash FROM pages WHERE source_id='default' AND slug=$1", [slug]);
    const item = { slug, content: SOURCE, contentHash: page!.content_hash };
    return { ...item, identity: await readAtomPageIdentity(engine, 'default', item) };
  }
  const state = async (slug: string) => (await engine.executeRaw<{ fail_count: number; tombstoned: boolean }>(
    "SELECT s.fail_count, s.tombstoned FROM extract_atoms_page_state s JOIN pages p ON p.id=s.page_id WHERE p.slug=$1", [slug]))[0];

  test(`the failure strike that reaches MAX_DETERMINISTIC_FAILURES (${MAX_DETERMINISTIC_FAILURES}) closes the page`, async () => {
    const item = await pinned('notes/strikes');
    for (let i = 1; i < MAX_DETERMINISTIC_FAILURES; i++) {
      await writeAtomPageState(engine, 'default', item, 'failure', MAX_DETERMINISTIC_FAILURES);
      expect(await state('notes/strikes')).toEqual({ fail_count: i, tombstoned: false });
    }
    await writeAtomPageState(engine, 'default', item, 'failure', MAX_DETERMINISTIC_FAILURES);
    expect(await state('notes/strikes')).toEqual({ fail_count: MAX_DETERMINISTIC_FAILURES, tombstoned: true });
  });

  test('without a limit failures only count (unchanged contract)', async () => {
    const item = await pinned('notes/count-only');
    for (let i = 0; i < MAX_DETERMINISTIC_FAILURES + 1; i++) await writeAtomPageState(engine, 'default', item, 'failure');
    expect(await state('notes/count-only')).toEqual({ fail_count: MAX_DETERMINISTIC_FAILURES + 1, tombstoned: false });
  });

  test('an empty content-filtered reply is reported as a provider content filter', async () => {
    await engine.putPage('notes/filtered', { type: 'note', title: 'f', compiled_truth: SOURCE } as never, { sourceId: 'default' });
    const filtered = async (): Promise<ChatResult> => ({ text: '', blocks: [], stopReason: 'content_filter',
      usage: { input_tokens: 10, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' }) as ChatResult;
    const result = await runPhaseExtractAtoms(engine, { sourceId: 'default', _transcripts: [],
      _pages: [{ slug: 'notes/filtered', content: SOURCE, contentHash: 'c'.repeat(16) }], _chat: filtered });
    const errors = (result.details?.failures as Array<{ error: string }>).map(f => f.error).join(' | ');
    expect(errors).toContain('provider content filter');
    expect(errors).not.toContain('no JSON array in response');
  });
});
