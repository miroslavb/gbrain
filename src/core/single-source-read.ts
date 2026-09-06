/** Select one read source without widening past the operation's grant. */
import type { OperationContext } from './ops/contract.ts';
import { sourceScopeOpts } from './ops/context.ts';

/**
 * Ambient cursors and hot-memory metadata have a single-source shape.
 * Null means a multi-source grant has no valid bound source: the caller
 * must refuse the operation or omit optional metadata before any cache/IO.
 */
export function selectSingleReadSource(ctx: OperationContext): string | null {
  const { sourceIds } = sourceScopeOpts(ctx);
  // Keep legacy []/scalar/default/sentinel behavior exactly as it was.
  if (!sourceIds) return ctx.sourceId ?? 'default';
  if (sourceIds.length === 1) return sourceIds[0];
  return ctx.sourceId && sourceIds.includes(ctx.sourceId) ? ctx.sourceId : null;
}
