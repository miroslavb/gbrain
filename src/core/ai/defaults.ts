/**
 * Leaf module holding the default embedding model + dimensions.
 *
 * Extracted so schema helpers (pglite-schema.ts, postgres-engine.ts) +
 * registry helpers (search/embedding-column.ts) can import the constants
 * without pulling the full AI gateway (which loads every provider SDK).
 *
 * gateway.ts re-exports these so existing import sites keep working.
 *
 * Single source of truth for "what does a fresh brain look like when the
 * user passes zero flags?" Touching these defaults touches every fresh
 * install AND every doctor consistency check.
 */

// LOCAL INSTALL OVERRIDE (hermes NUC, 2026-07-18) — re-apply after any upstream
// reset. Upstream v0.36.0 made ZeroEntropy (zeroentropyai:zembed-1 / 1280d) the
// system default, but THIS brain runs a fully local bge-m3 stack (llama-server
// :9390 embed-proxy → Hive t07, bge-reranker-v2-m3, no ZEROENTROPY_API_KEY).
// The write path stamps `chunk.model || DEFAULT_EMBEDDING_MODEL`
// (postgres-engine.ts) — so with the upstream default, every `gbrain put` that
// didn't set chunk.model mislabeled/mis-embedded chunks as zembed-1, degrading
// the single-model bge-m3 index (surfaced by hermes housekeeping's model-mix
// check after the 2026-07-17 session-ingest pipeline drove put volume up).
// Aligning the compiled default with the configured model (config.embedding_model
// = llama-server:bge-m3, 1024d) makes the fallback correct too.
// NB: bare 'bge-m3' (no provider prefix) to MATCH the canonical chunk label used
// by the existing 86k chunks + reembed_finish.py (MODEL='bge-m3'), so the whole
// index carries ONE label and the housekeeping model-mix check reads 100%.
// Routing is unaffected: the embed call resolves the model via
// getEmbeddingModel() = config.embedding_model ('llama-server:bge-m3'); this
// constant is only the fallback used to STAMP chunk.model when the write path
// leaves it unset (postgres-engine.ts `chunk.model || DEFAULT_EMBEDDING_MODEL`).
export const DEFAULT_EMBEDDING_MODEL = 'bge-m3';
export const DEFAULT_EMBEDDING_DIMENSIONS = 1024;
