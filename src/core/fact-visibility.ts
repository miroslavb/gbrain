/**
 * Fork-local (2026-08-04): configurable default visibility for facts.
 *
 * Upstream hard-codes `visibility ?? 'private'` at every fact-insert site,
 * and both MCP transports (stdio AND http) dispatch with `remote: true`,
 * so remote-filtered `recall` returns ONLY visibility=world rows. On a
 * single-operator brain that combination hides the entire hot-memory layer
 * from every agent. This helper lets the operator flip the DEFAULT for
 * newly-extracted facts via the file-plane config:
 *
 *   ~/.gbrain/config.json → { "facts": { "default_visibility": "world" } }
 *
 * File plane deliberately (same rationale as provider_base_urls / api-key
 * folds): long-lived daemons read loadConfig() at insert time without a DB
 * round-trip, and the DB config plane is not visible to every caller.
 * Validated to 'private' | 'world'; anything else (or any error) falls back
 * to upstream's 'private', so a missing/corrupt config never widens
 * visibility by accident. Memoized per process — restart workers/serve
 * after changing the config value.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadConfig } from './config.ts';
import type { FactVisibility } from './engine.ts';

let cached: FactVisibility | null = null;

export function defaultFactVisibility(): FactVisibility {
  if (cached !== null) return cached;
  let v: FactVisibility = 'private';
  try {
    const c = loadConfig() as unknown as { facts?: { default_visibility?: unknown } } | null;
    if (c?.facts?.default_visibility === 'world') v = 'world';
  } catch {
    // fall through to 'private'
  }
  // Secondary knob: a secret-free one-word flag file, for operators whose
  // config.json is credential-bearing and locked down. Content 'world' wins.
  if (v === 'private') {
    try {
      const flag = readFileSync(join(homedir(), '.gbrain', 'facts-default-visibility'), 'utf-8').trim();
      if (flag === 'world') v = 'world';
    } catch {
      // absent file → keep 'private'
    }
  }
  cached = v;
  return v;
}

/** @internal test seam */
export function __resetFactVisibilityCacheForTests(): void {
  cached = null;
}
