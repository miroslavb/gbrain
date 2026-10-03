/** Priceability preflight. An unenforceable cap blocks extraction; it never invents a $0 route. */
import { isAvailable, getEmbeddingModel } from '../ai/gateway.ts';
import { isModelPriceable, type PricingOverrides } from '../budget/budget-tracker.ts';

export interface ExtractAtomsCostGate {
  enforceCap: boolean;
  unpricedModel?: string;
  unpricedKind?: 'chat' | 'embed';
}

/** Both default and explicit budgets require known prices for every billed route. */
export function resolveExtractAtomsCostGate(
  extractModel: string,
  embedModel: string | null,
  overrides?: PricingOverrides,
  _opts: { explicitBudget?: boolean } = {},
): ExtractAtomsCostGate {
  if (!isModelPriceable(extractModel, 'chat', overrides)) {
    return { enforceCap: false, unpricedModel: extractModel, unpricedKind: 'chat' };
  }
  if (embedModel !== null && !isModelPriceable(embedModel, 'embed', overrides)) {
    return { enforceCap: false, unpricedModel: embedModel, unpricedKind: 'embed' };
  }
  return { enforceCap: true };
}

/** Mirrors the import site's availability check; no price is needed when no embedding call runs. */
export function resolveEmbedModelForCostGate(): string | null {
  try { return isAvailable('embedding') ? getEmbeddingModel() : null; }
  catch { return null; }
}
