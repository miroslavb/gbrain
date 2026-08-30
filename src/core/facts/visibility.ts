/**
 * Host-wide fact visibility policy.
 *
 * This deployment is single-principal: every agent connected to the host is
 * allowed to read every gbrain fact. `world` is therefore the only writable
 * visibility. The database and fence parsers still understand legacy
 * `private` rows so old material can be read and normalized, but no write
 * resolver may create another one.
 */

import type { BrainEngine } from '../engine.ts';

export type FactVisibility = 'private' | 'world';
export type WritableFactVisibility = 'world';

export const WORLD_VISIBILITY: WritableFactVisibility = 'world';

export const FACTS_DEFAULT_VISIBILITY_KEY = 'facts.default_visibility';

/** Resolve an omitted write visibility under the host's world-only policy. */
export async function resolveDefaultVisibility(_engine: BrainEngine): Promise<WritableFactVisibility> {
  return WORLD_VISIBILITY;
}

/**
 * Op-layer normalization shared by extract_facts and ontology_propose.
 * Public schemas accept only `world`; this runtime seam also coerces legacy
 * callers and durable pre-policy payloads to `world` so a stale worker cannot
 * reintroduce inaccessible material.
 */
export async function resolveVisibilityParam(
  _engine: BrainEngine,
  _value: unknown,
): Promise<WritableFactVisibility> {
  return WORLD_VISIBILITY;
}
