import { beforeEach, describe, expect, test } from 'bun:test';
import {
  configureGateway,
  resetGateway,
  type ChatResult,
} from '../src/core/ai/gateway.ts';
import { probeChainViability, probeModel } from '../src/commands/models.ts';

const codex = 'openai:gpt-5.6-terra';
const claude = 'anthropic:claude-sonnet-5';
const ollama = 'together:deepseek-v4-flash:0731';

function success(model: string): ChatResult {
  return {
    text: 'ok',
    blocks: [],
    stopReason: 'end',
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    },
    model,
    providerId: model.split(':', 1)[0],
  };
}

describe('models doctor — chain viability', () => {
  beforeEach(() => {
    resetGateway();
    configureGateway({
      chat_model: claude,
      expansion_model: codex,
      chat_fallback_chain: [codex, claude, ollama],
      env: {
        OPENAI_API_KEY: 'fake',
        ANTHROPIC_API_KEY: 'fake',
        TOGETHER_API_KEY: 'fake',
      },
    });
  });

  test('reports fallback-selected model without masking the primary route', async () => {
    const calls: Array<{ model?: string; maxTokens?: number; hasSignal: boolean }> = [];
    const result = await probeChainViability({
      chat: async (opts) => {
        calls.push({ model: opts.model, maxTokens: opts.maxTokens, hasSignal: !!opts.abortSignal });
        return success(codex);
      },
    }, 1_000);

    expect(calls).toEqual([{ model: claude, maxTokens: 1, hasSignal: true }]);
    expect(result).toMatchObject({
      model: claude,
      touchpoint: 'chain',
      status: 'ok',
      selected_model: codex,
      degraded: true,
      route: [claude, codex, ollama],
    });
    expect(result.message).toContain(`fallback ${codex}`);
  });

  test('reports a healthy primary without degradation', async () => {
    const result = await probeChainViability({
      chat: async () => success(claude),
    }, 1_000);

    expect(result).toMatchObject({
      touchpoint: 'chain',
      status: 'ok',
      selected_model: claude,
      degraded: false,
      route: [claude, codex, ollama],
    });
    expect(result.message).toContain('primary reachable');
  });

  test('classifies an exhausted chain and preserves route metadata', async () => {
    const result = await probeChainViability({
      chat: async () => {
        throw new Error('429 all subscription lanes exhausted');
      },
    }, 1_000);

    expect(result).toMatchObject({
      touchpoint: 'chain',
      status: 'rate_limit',
      degraded: true,
      route: [claude, codex, ollama],
    });
    expect(result.selected_model).toBeUndefined();
  });

  test('individual provider probe explicitly disables configured fallback', async () => {
    const calls: Array<{ model?: string; fallbackPolicy?: string }> = [];
    const result = await probeModel(claude, 'chat', {
      chat: async (opts) => {
        calls.push({ model: opts.model, fallbackPolicy: opts.fallbackPolicy });
        throw new Error('429 primary exhausted');
      },
    });

    expect(calls).toEqual([{ model: claude, fallbackPolicy: 'none' }]);
    expect(result).toMatchObject({ model: claude, touchpoint: 'chat', status: 'rate_limit' });
  });

  test('individual provider probe refuses a response from a different model', async () => {
    const result = await probeModel(claude, 'chat', {
      chat: async () => success(codex),
    });

    expect(result).toMatchObject({ model: claude, touchpoint: 'chat', status: 'unknown' });
    expect(result.message).toContain(`returned ${codex}`);
    expect(result.message).toContain(`requested ${claude}`);
  });
});
