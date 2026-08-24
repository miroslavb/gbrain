/** Bounded whole-provider outage circuit for corpus-wide embedding drains. */

import { AITransientError } from './ai/errors.ts';
import { anySignal } from './abort-check.ts';
import { serr } from './console-prefix.ts';
import { isEmbedRetriableError, isTransientNetworkEmbedError } from './embed-retry.ts';

export const PROVIDER_FAILURE_HALT_STREAK = 3;

const PHYSICAL_BATCH_INPUT_TOO_LARGE_RE =
  /input \(\d+ tokens\) is too large to process|increase the physical batch size|current batch size:\s*\d+/i;

export function isPhysicalBatchInputTooLargeError(e: unknown): boolean {
  let cur: unknown = e;
  for (let depth = 0; depth < 5 && cur !== undefined && cur !== null; depth++) {
    const obj = cur as { message?: unknown; cause?: unknown };
    if (typeof obj.message === 'string' && PHYSICAL_BATCH_INPUT_TOO_LARGE_RE.test(obj.message)) return true;
    cur = obj.cause;
  }
  return false;
}

function statusFromCause(e: unknown): number | undefined {
  let cur: unknown = e;
  for (let depth = 0; depth < 5 && cur !== undefined && cur !== null; depth++) {
    const obj = cur as { status?: unknown; statusCode?: unknown; cause?: unknown };
    if (typeof obj.status === 'number') return obj.status;
    if (typeof obj.statusCode === 'number') return obj.statusCode;
    cur = obj.cause;
  }
  return undefined;
}

export function isProviderWideEmbedFailure(e: unknown): boolean {
  if (isPhysicalBatchInputTooLargeError(e)) return false;
  const status = statusFromCause(e);
  return e instanceof AITransientError
    || isEmbedRetriableError(e)
    || isTransientNetworkEmbedError(e)
    || status === 401
    || status === 403;
}

export class EmbedProviderFailureCircuit {
  private readonly controller = new AbortController();
  private streak = 0;
  readonly signal: AbortSignal;

  constructor(baseSignal: AbortSignal) {
    this.signal = anySignal(baseSignal, this.controller.signal);
  }

  get opened(): boolean { return this.controller.signal.aborted; }
  get abortLabel(): string | null {
    return this.opened ? 'provider-wide failure circuit opened' : null;
  }

  recordSuccess(): void { this.streak = 0; }

  recordFailure(error: unknown): void {
    if (!isProviderWideEmbedFailure(error)) {
      this.streak = 0;
      return;
    }
    this.streak++;
    if (this.streak < PROVIDER_FAILURE_HALT_STREAK || this.opened) return;
    this.controller.abort(new Error('provider-wide embedding outage'));
    serr(
      `\n  [embed] provider-wide failure circuit opened after ${this.streak} ` +
      'consecutive page failures; stopping this pass with its checkpoint intact.',
    );
  }
}
