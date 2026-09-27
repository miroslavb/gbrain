# Memory fork contracts (host-specific key files)

This page covers files and behavior that exist only in the patched memory fork
deployed on this host. Upstream subsystem pages remain authoritative for
everything else; read the matching upstream entry together with any fork delta
listed here.

## Host visibility invariant

This deployment is single-principal and world-only. Fact writers accept only
`world`; legacy private fact rows and page frontmatter are readable by every
connected agent and normalized by fork migration 147
(`world_only_host_visibility`) plus its convergence guard (migration 152).
`src/core/facts/visibility.ts` implements the policy. Entries elsewhere that
describe private-fact filtering for remote callers do not apply to this host;
source grants and document ACLs still apply.

## Source-scoped ambient reads

`src/core/single-source-read.ts` resolves an allowed source for ambient fact and
metadata reads before lookup; its callers in `src/core/ops/facts.ts` and
`src/core/facts/meta-hook.ts` must preserve explicit source grants.

## Fork-only files

- `src/core/sync-strategy.ts` — validated sync scope precedence: explicit argument,
  selected source's `config.strategy`, legacy `markdown`. `performSync` resolves
  this before imports, cleanup, full-walk fallback and lock writes, including
  delegated/library callers. The CLI parser rejects a bare/invalid `--strategy`;
  `--all` and `syncOneSource` use the same selector. Invalid saved settings fail
  closed when selected; a valid explicit override remains usable. String/object
  JSON configs use `parseSourceConfig`, preserving nested-string/array-fragment
  recovery and scalar/null heal-on-write; only an actual invalid strategy is
  rejected. Source lookup is parameter-bound. This prevents an
  omitted flag from soft-deleting modified code in a saved `auto` source, while
  retaining explicit narrowing and source isolation. Regression coverage:
  `test/sync-source-strategy.serial.test.ts` (real disposable Git/PGLite) and
  `test/sync-strategy-selection.test.ts` (boundary/precedence controls).
- `src/core/cycle/atom-safety.ts` + `src/core/cycle/extract-atoms.ts` — pre-write atom safety and shared phase budget policy. The extractor and semantic-validator routes are priced together, including operator `pricing.overrides`; a cap is enforced only when both routes are priceable. `BudgetExhausted` remains a typed phase stop instead of being rewritten as a semantic rejection. Before the semantic batch, exact-quote atoms fail closed on multilingual compound joins, spaced slashes, parenthetical/list enumerations, and vague/deictic fragments; the semantic rubric treats the body itself (not a reparative title) as the standalone claim surface. Pinned by `test/cycle/atom-safety.test.ts` and `test/extract-atoms-unpriced-model.test.ts`.
- `src/core/cycle/atom-processing.ts` — opt-in, epoch-fenced aggregate processing ledger in one config row. Counts only real page dispatches/attempts and terminal successes (including empty or quality-rejected results), failures and completed atom publications; transcripts are excluded. The operator initializes the epoch; no helper enables extraction. Atomic increments serialize writers, and an old epoch cannot overwrite a reset. No source text or page coordinates are stored. A failed observation write fails the phase instead of silently certifying incomplete counters.
- `src/core/facts/page-projection.ts` — source-scoped body-only page projection inside fact transactions; keeps the last indexed content_hash unchanged so sync still rechunks. `file-rollback.ts` compensates only the writer’s own atomic rename on a DB failure. `FactBatchInsertOpts.pageProjection` shares the fact insert transaction in both engines. Fence supersession uses durable row coordinates and atomically retires the old DB row.
- `src/core/timeline-write-through.ts` — Locked canonical timeline insertion; projects the parsed final file timeline so trailing fact/take fences retain identical placement in the file and page API. Tests: `test/timeline-write-through.test.ts` and the both-engine `test/helpers/fact-page-contract.ts` timeline-tail case.
- `src/core/code-page-type.ts` — source-scoped taxonomy read inside code import transactions; preserves a classified code page during sync and repair.
- `src/commands/integrations-file-helpers.ts` — pure file hashing and static manifest target checks used by integrations; kept separate to preserve the command module size ceiling.
- `src/core/facts/fence-exact-dedup.ts` — under-lock exact replay selection for fence-write. Requires matching active file/DB coordinates, no typed metrics/dimensions; preserves sources, days, kind, confidence, notability, context/session and input ID order. Events/commitments and supersession bypass it. `backstop.ts` supplies the originating page slug and holds ambiguous extracted entities unresolved. Tested by the shared fact-quality contract on both engines.

## Fork deltas on upstream entries

These paragraphs extend the upstream bullet for the same path (kept as prose so
each file keeps exactly one reference bullet).

Fork delta — `src/core/chunkers/` — 3-tier chunking (recursive, semantic, LLM-guided). `code.ts` (CHUNKER_VERSION 7: retain large-function declarations/decorators in the first contiguous AST split range) is a tree-sitter-based semantic chunker for 30 languages (plus SQL via DerekStride/tree-sitter-sql) with embedded-asset WASMs (`src/assets/wasm/`), `@dqbd/tiktoken` cl100k_base tokenizer, small-sibling merging. `CHUNKER_VERSION` is folded into `importCodeFile`'s `content_hash` so chunker shape changes force clean re-chunks across releases. `extractSymbolName` has an inline SQL branch (`extractSqlSymbolName`) diving through DerekStride's `statement` wrapper into the inner DDL child (`create_table`/`create_function`/`create_view`/`create_index`/`create_procedure`/`create_type`/`create_schema`/`create_database`/`create_trigger`/`alter_table`/`alter_view`) and extracting the target identifier via the `name` field with identifier-shaped fallback; DML kinds (`select`/`insert`/`update`/`delete`/`merge`/`with`) deliberately return null so chunks emit unnamed (code-def is a DDL signal). `normalizeSymbolType` has parallel SQL branches mapping `create_table → 'table'`, `create_view → 'view'`, etc. `DEF_TYPES` (owned by `src/core/chunkers/def-types.ts`, re-exported by `src/commands/code-def.ts` — see that entry) carries the SQL kinds (`'table' | 'view' | 'index' | 'procedure' | 'schema' | 'database' | 'trigger'`) so the new chunks surface in `gbrain code-def <name>` queries.

Fork delta — `src/commands/code-def.ts` + `src/commands/code-refs.ts` — symbol definition + references lookup. Query `content_chunks.symbol_name` or chunk_text ILIKE with `page_kind='code'` filter. Auto-JSON when stdout is not a TTY (gh-CLI convention). Bypass the standard `searchKeyword` `DISTINCT ON (slug)` collapse so multiple call-sites from the same file surface. The JSON envelope (CLI + the `code_def`/`code_refs` MCP ops) carries `status` + `ready` from `src/core/code-graph-readiness.ts` so a `count:0` result is distinguishable as `not_built` (no code indexed) vs `ready` (genuinely no match); human output prints a one-line hint when not ready. The source recovery floor remains at the separately admitted AUTOMATIC_CODE_CHUNKER_VERSION; per-file code_chunker_version proves newer finite imports. References accept an exact `file` (CLI `--file`) predicate before LIMIT. Both commands resolve `--source <id>` (space or inline `=` spelling) and the ambient source scope through the shared `code-scope.ts` resolver, matching `code-callers`/`code-callees`; `--all-sources` restores the brain-wide read. The `AND p.source_id = $N` fragment comes from `code-scope.ts`'s `pushSourcePredicate(params, opts)` (numbered off `params.length` so it composes with `--lang` and any other optional predicate; `''` when spanning every source) — code-def's lookup, its filtered-types probe, and code-refs all use it.

Fork delta — `src/core/entities/resolve.ts` — Free-form entity name → canonical slug resolution. `resolveEntitySlug(engine, source_id, raw)`: qualified exact slug → alias-exact (curated aliases outrank root stubs; live collisions throw instead of fuzzy guessing) (an unambiguous `page_aliases` hit via `resolveAliases`, verified against LIVE pages since `page_aliases` has no FK — a stale alias row can never point at a deleted page; fail-open on pre-v110 brains missing the table; `ResolutionSource` reports `alias_exact`) → exact root slug → unambiguous bare-name prefix expansion across `people/<token>-%` + `companies/<token>-%` → high-specificity fuzzy match for multi-token input (pg_trgm @ 0.7 threshold) → deterministic `slugify` holding fallback. Bare-name collisions never use popularity as confidence; shared-token company names below the threshold remain unresolved. Two helpers for the phantom-redirect pass: `resolvePhantomCanonical(engine, sourceId, phantomSlug)` SKIPS the exact-slug step (a phantom slug `'alice'` would exact-match itself and no-op the redirect); returns the canonical only when non-null AND contains `/`. `findPrefixCandidates(engine, sourceId, token)` is a standalone SQL query returning ALL candidates across `PREFIX_EXPANSION_DIRS` (hardcoded `['people', 'companies']`) via `slug LIKE ANY($N::text[])` over patterns `dir/token` + `dir/token-%`, cap of 10 ordered by `connection_count DESC, slug ASC`. Pinned by `test/entity-resolve.test.ts` (explicit, unique, ambiguous-person, and shared-token-company cases) plus `test/phantom-redirect.test.ts` (resolvePhantomCanonical 3 cases + findPrefixCandidates 6 cases incl. multi-dir ambiguity and the `people/aliceberg`-doesn't-match-`alice` false-positive guard).

Fork delta — `src/core/config.ts` — `KNOWN_CONFIG_KEYS` contains each accepted exact key once; deduplicating a repeated entry must not change the key set or any config value. `src/core/cli-flag-registry.generated.ts` is rebuilt from the current handlers; keep existing enrichment language flags admitted without hand-editing output.

Fork delta — `src/core/facts/delta.ts` — the facts backstop extracts only new content. `computeFactsDelta` compares the previous body with the new one sentence by sentence (table rows whole, facts/takes fences ignored) and returns `none` (nothing new or under 30 chars: no LLM call), `delta` (new sentences with heading, table header and line lead-in as context) or `full` (new page or more than 60% new). Sync diffs against the snapshot its import just wrote (`readLastSnapshotBody`) and the durable job carries the delta as `extract_text`; a persistence put_page job, pinned to its revision by `readFactsBackstopJobPage`, diffs against the latest `page_versions` snapshot. A failed read falls back to whole-page extraction. `resolve.ts` adds an unambiguous `<people|companies|hosts|projects>/<last-segment>` step before minting a page-less slug. Tests: `test/fork-facts-backstop-delta.test.ts`.

Fork delta — `src/core/ai/gateway.ts` `embed()` — `embedding_query_prefix` (config file key, env `GBRAIN_EMBEDDING_QUERY_PREFIX`) is prepended to query-side inputs only (`inputType: 'query'`, configured model) for instruction-tuned embedders such as Giga-Embeddings; documents and per-column model overrides stay unprefixed. Tests: `test/fork-embedding-query-prefix.test.ts`.
