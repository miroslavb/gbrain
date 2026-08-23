import { describe, expect, test } from 'bun:test';
import { isModelPriceable } from '../src/core/budget/budget-tracker.ts';
import { resolveExtractAtomsBudgetPricingPolicy } from '../src/core/cycle/extract-atoms.ts';

// Regression: extract_atoms applied its DEFAULT cost cap unconditionally.
// BudgetTracker.reserve() hard-fails with BudgetExhausted(reason:'no_pricing')
// when a model is absent from the pricing maps AND a cap is set, so the first
// work item threw, `budgetExhausted` latched, and every remaining item was
// skipped — while the phase still reported status 'ok' with an empty failures[].
// Anthropic users never saw it; every Groq / local-llama / OpenRouter user did.
describe('isModelPriceable', () => {
  test('priced Anthropic chat models are priceable', () => {
    expect(isModelPriceable('claude-haiku-4-5-20251001', 'chat')).toBe(true);
  });

  // NOTE: the examples here must be providers with genuinely unknown pricing.
  // `ollama` and `llama-server` are NOT: they price at $0 via
  // FREE_LOCAL_CHAT_PROVIDERS (local inference costs electricity, not tokens),
  // so a cap against them is enforceable and must not be skipped. `litellm` is
  // deliberately excluded from that set — a LiteLLM proxy can front a paid
  // provider — and `groq` is the paid-but-unpriced case this regression bit.
  test('unknown providers are not priceable, so a default cap must be skipped', () => {
    expect(isModelPriceable('litellm:gemma4-12b', 'chat')).toBe(false);
    expect(isModelPriceable('groq:llama-3.3-70b', 'chat')).toBe(false);
  });

  test('free local providers ARE priceable at $0, so their cap stays enforced', () => {
    expect(isModelPriceable('ollama:gemma3:27b', 'chat')).toBe(true);
    expect(isModelPriceable('llama-server:local-model', 'chat')).toBe(true);
  });

  test('is a pure predicate — no throw on unusual model ids', () => {
    expect(() => isModelPriceable('', 'chat')).not.toThrow();
    expect(() => isModelPriceable('provider-with-no-colon', 'chat')).not.toThrow();
  });
});

describe('extract_atoms shared extractor/validator budget policy', () => {
  test('operator pricing.overrides keeps the cap enforceable for the validator route', async () => {
    const engine = {
      getConfig: async (key: string) => key === 'pricing.overrides'
        ? '{"together:glm-5.2":{"input":0.6,"output":2.2}}'
        : null,
    };
    const policy = await resolveExtractAtomsBudgetPricingPolicy(
      engine as never,
      'openai:gpt-5.6-terra',
      'together:glm-5.2',
    );
    expect(policy.enforceCostCap).toBe(true);
    expect(policy.unpricedModels).toEqual([]);
    expect(policy.pricingOverrides?.['together:glm-5.2']).toEqual({ input: 0.6, output: 2.2 });
  });

  test('an unpriced validator disables the default cap instead of failing mid-phase', async () => {
    const engine = { getConfig: async () => null };
    const policy = await resolveExtractAtomsBudgetPricingPolicy(
      engine as never,
      'openai:gpt-5.6-terra',
      'together:unknown-validator',
    );
    expect(policy.enforceCostCap).toBe(false);
    expect(policy.unpricedModels).toEqual(['together:unknown-validator']);
  });
});
