/** Fail-safe model fallback walker for gateway chat calls. */

function fallbackEligible(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 6 && current; depth++) {
    const rec = current as {
      name?: unknown;
      message?: unknown;
      cause?: unknown;
      constructor?: { name?: string };
    };
    const name = `${typeof rec.name === 'string' ? rec.name : ''} ${rec.constructor?.name ?? ''}`.toLowerCase();
    const message = typeof rec.message === 'string' ? rec.message.toLowerCase() : '';
    if (name.includes('abort') || name.includes('budgetexhausted')) return false;
    if (name.includes('guardrail') || message.includes('guardrail')) return false;
    current = rec.cause;
  }
  return true;
}

export async function runChatFallback<T, O extends { model?: string }>(
  opts: O,
  requested: string,
  chain: readonly string[],
  attempt: (opts: O) => Promise<T>,
): Promise<T> {
  try {
    return await attempt(opts);
  } catch (err) {
    if (!fallbackEligible(err)) throw err;
    const attempted = new Set([requested]);
    let lastError: unknown = err;
    for (const fallbackModel of chain) {
      if (!fallbackModel || attempted.has(fallbackModel)) continue;
      attempted.add(fallbackModel);
      console.warn(`[gateway.chat] model "${requested}" failed; trying fallback "${fallbackModel}"`);
      try {
        return await attempt({ ...opts, model: fallbackModel });
      } catch (fallbackError) {
        if (!fallbackEligible(fallbackError)) throw fallbackError;
        lastError = fallbackError;
      }
    }
    throw lastError;
  }
}
