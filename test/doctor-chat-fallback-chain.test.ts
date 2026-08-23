import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { checkChatFallbackChainInert } from '../src/commands/doctor.ts';

function engineWithDbValue(value: string | null): BrainEngine {
  return {
    getConfig: async (key: string) => key === 'chat_fallback_chain' ? value : null,
  } as unknown as BrainEngine;
}

describe('chat_fallback_chain doctor compatibility check', () => {
  test('configured fallback chain is live and no longer emits an inert warning', async () => {
    expect(await checkChatFallbackChainInert(
      engineWithDbValue('["openai:gpt-5.2"]'),
      { chat_fallback_chain: ['anthropic:claude-sonnet-4-6'] },
    )).toBeNull();
  });

  test('unset or empty values remain silent', async () => {
    expect(await checkChatFallbackChainInert(engineWithDbValue(null), null)).toBeNull();
    expect(await checkChatFallbackChainInert(
      engineWithDbValue('[]'),
      { chat_fallback_chain: [] },
    )).toBeNull();
  });
});
