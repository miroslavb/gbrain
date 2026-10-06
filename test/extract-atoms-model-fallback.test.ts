// Atom extraction can be pinned to its configured model: with
// cycle.extract_atoms.model_fallback = 'false' the extractor passes an empty
// per-call fallback chain, so a provider overload surfaces as a retryable
// error instead of another model (the global chat_fallback_chain) answering.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPhaseWithStoredPageFixtures as runPhaseExtractAtoms } from './helpers/extract-atoms-page-fixtures.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { __setChatTransportForTests, chat, configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import type { ChatOpts, ChatResult } from '../src/core/ai/gateway.ts';

function ok(text: string, model = 'anthropic:claude-haiku-4-5'): ChatResult {
  return { text, blocks: [{ type: 'text', text }], stopReason: 'end',
    usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 }, model, providerId: model.split(':')[0] } as ChatResult;
}

describe('gateway chat: per-call fallback chain', () => {
  afterEach(() => { __setChatTransportForTests(null); resetGateway(); });

  async function overloadedPrimary(fallbackChain?: readonly string[]) {
    configureGateway({ chat_fallback_chain: ['openai:fallback-model'], env: {} });
    const models: string[] = [];
    __setChatTransportForTests(async (opts: ChatOpts) => {
      models.push(opts.model ?? '');
      if (opts.model === 'anthropic:primary-model') throw new Error('upstream 529: overloaded');
      return ok('answer', opts.model);
    });
    const call = chat({ model: 'anthropic:primary-model', messages: [{ role: 'user', content: 'hi' }], ...(fallbackChain ? { fallbackChain } : {}) });
    return { call, models };
  }

  test('without an override the configured chain answers an overloaded primary', async () => {
    const { call, models } = await overloadedPrimary();
    expect((await call).model).toBe('openai:fallback-model');
    expect(models).toEqual(['anthropic:primary-model', 'openai:fallback-model']);
  });

  test('an empty per-call chain lets no other model answer', async () => {
    const { call, models } = await overloadedPrimary([]);
    await expect(call).rejects.toThrow('overloaded');
    expect(models).toEqual(['anthropic:primary-model']);
  });
});

describe('extract_atoms: cycle.extract_atoms.model_fallback', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
  afterAll(async () => { await engine.disconnect(); });
  beforeEach(async () => { await resetPgliteState(engine); });

  async function chainSeen(setting?: string): Promise<Array<readonly string[] | undefined>> {
    if (setting !== undefined) await engine.setConfig('cycle.extract_atoms.model_fallback', setting);
    await engine.putPage('note/pinned', { title: 'pinned', type: 'note', compiled_truth: 'seed body prose' } as never, { sourceId: 'default' });
    const seen: Array<readonly string[] | undefined> = [];
    await runPhaseExtractAtoms(engine, { sourceId: 'default', _transcripts: [],
      _pages: [{ slug: 'note/pinned', content: 'The insight body prose is a durable observation.', contentHash: 'b'.repeat(16) }],
      _chat: async (opts: ChatOpts) => { seen.push(opts.fallbackChain); return ok('[]'); } });
    return seen;
  }

  test("'false' passes an empty fallback chain to the extractor call", async () => {
    expect(await chainSeen('false')).toEqual([[]]);
  });

  test('unset keeps the configured chain (no per-call override)', async () => {
    expect(await chainSeen()).toEqual([undefined]);
  });
});
