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
- `src/core/cycle/atom-safety.ts` + `src/core/cycle/extract-atoms.ts` — pre-write atom safety and shared phase budget policy. Extractor, semantic-validator and embedding routes must all have known prices, including operator `pricing.overrides`, before the first chargeable request; unknown prices fail closed and never remove the shared cap. Parsing and exact-quote helpers live in `extract-atoms-output.ts`. `BudgetExhausted` remains a typed phase stop instead of being rewritten as a semantic rejection. Before the semantic batch, exact-quote atoms fail closed on multilingual compound joins, spaced slashes, parenthetical/list enumerations, and vague/deictic fragments; the semantic rubric treats the body itself (not a reparative title) as the standalone claim surface. Pinned by `test/cycle/atom-safety.test.ts` and `test/extract-atoms-unpriced-model.test.ts`.
- `src/core/cycle/atom-processing.ts` — opt-in, epoch-fenced aggregate processing ledger in one config row. Counts only real page dispatches/attempts and terminal successes (including empty or quality-rejected results), failures and completed atom publications; transcripts are excluded. The operator initializes the epoch; no helper enables extraction. Atomic increments serialize writers, and an old epoch cannot overwrite a reset. No source text or page coordinates are stored. A failed observation write fails the phase instead of silently certifying incomplete counters.
- `src/core/facts/page-projection.ts` — source-scoped body-only page projection inside fact transactions; keeps the last indexed content_hash unchanged so sync still rechunks. `file-rollback.ts` compensates only the writer’s own atomic rename on a DB failure. `FactBatchInsertOpts.pageProjection` shares the fact insert transaction in both engines. Fence supersession uses durable row coordinates and atomically retires the old DB row.
- `src/core/timeline-write-through.ts` — Locked canonical timeline insertion; projects the parsed final file timeline so trailing fact/take fences retain identical placement in the file and page API. Tests: `test/timeline-write-through.test.ts` and the both-engine `test/helpers/fact-page-contract.ts` timeline-tail case.
- `src/core/code-page-type.ts` — source-scoped taxonomy read inside code import transactions; preserves a classified code page during sync and repair.
- `src/commands/integrations-file-helpers.ts` — pure file hashing and static manifest target checks used by integrations; kept separate to preserve the command module size ceiling.
- `src/core/code-chunks.ts` `isFiniteLexicalSymbols` — code pages the host code index marks `embed_skip: {reason: 'finite_lexical_symbols'}` keep their chunks (upstream empties every embed_skip page). The importer preserves existing frontmatter and the projection rebuild re-chunks every page, so without this the lexical-symbol pages would lose the chunks keyword search and `code_def`/`code_refs` read. They stay vector-free: the stale-chunk selectors exclude embed_skip pages. Other embed_skip reasons and quarantined pages still get no chunks. Tests: `test/fork-code-chunks-lexical-skip.test.ts`.
- `src/core/facts/known-facts.ts` — facts a page-sourced backstop run must not extract again. `knownFactsForPage` returns the page entity's active facts plus facts from the last 7 days on entities the new text links to (`[[dir/slug]]` or bare `dir/slug` tokens, `mentionedSlugs`), newest first, capped at 40 facts / 8000 chars; a lookup failure returns what it has. `backstop.ts` passes them as `knownFacts`, and `extract.ts` `knownFactsBlock` appends a sanitized `<known_facts>` block that tells the extractor to skip claims that restate, paraphrase, translate, summarize or are part of a known fact (embedding dedup cannot: fragments of a long fact score 0.48-0.81 cosine against it, like new facts). The originating page remains provenance; unresolved/ambiguous subjects stay unparented unless upstream verified inference resolves them. A meeting page must not become the subject of every extracted claim. Tests: `test/fork-facts-backstop-known-facts.test.ts`.
- `src/core/facts/fence-exact-dedup.ts` — under-lock exact replay selection for fence-write. Requires matching active file/DB coordinates, no typed metrics/dimensions; preserves sources, days, kind, confidence, notability, context/session and input ID order. Events/commitments and supersession bypass it. `backstop.ts` supplies the originating page slug; page-sourced runs retain it as provenance without inventing a subject (see `known-facts.ts`). Tested by the shared fact-quality contract on both engines.

## Fork deltas on upstream entries

These paragraphs extend the upstream bullet for the same path (kept as prose so
each file keeps exactly one reference bullet).

Fork delta — `src/core/chunkers/` — 3-tier chunking (recursive, semantic, LLM-guided). `code.ts` (CHUNKER_VERSION 8: retain large-function declarations/decorators in the first contiguous AST split range) is a tree-sitter-based semantic chunker for 30 languages (plus SQL via DerekStride/tree-sitter-sql) with embedded-asset WASMs (`src/assets/wasm/`), `@dqbd/tiktoken` cl100k_base tokenizer, small-sibling merging. `CHUNKER_VERSION` is folded into `importCodeFile`'s `content_hash` so chunker shape changes force clean re-chunks across releases. `extractSymbolName` has an inline SQL branch (`extractSqlSymbolName`) diving through DerekStride's `statement` wrapper into the inner DDL child (`create_table`/`create_function`/`create_view`/`create_index`/`create_procedure`/`create_type`/`create_schema`/`create_database`/`create_trigger`/`alter_table`/`alter_view`) and extracting the target identifier via the `name` field with identifier-shaped fallback; DML kinds (`select`/`insert`/`update`/`delete`/`merge`/`with`) deliberately return null so chunks emit unnamed (code-def is a DDL signal). `normalizeSymbolType` has parallel SQL branches mapping `create_table → 'table'`, `create_view → 'view'`, etc. `DEF_TYPES` (owned by `src/core/chunkers/def-types.ts`, re-exported by `src/commands/code-def.ts` — see that entry) carries the SQL kinds (`'table' | 'view' | 'index' | 'procedure' | 'schema' | 'database' | 'trigger'`) so the new chunks surface in `gbrain code-def <name>` queries.

Fork delta — `src/commands/code-def.ts` + `src/commands/code-refs.ts` — symbol definition + references lookup. Query `content_chunks.symbol_name` or chunk_text ILIKE with `page_kind='code'` filter. Auto-JSON when stdout is not a TTY (gh-CLI convention). Bypass the standard `searchKeyword` `DISTINCT ON (slug)` collapse so multiple call-sites from the same file surface. The JSON envelope (CLI + the `code_def`/`code_refs` MCP ops) carries `status` + `ready` from `src/core/code-graph-readiness.ts` so a `count:0` result is distinguishable as `not_built` (no code indexed) vs `ready` (genuinely no match); human output prints a one-line hint when not ready. The source recovery floor remains at the separately admitted AUTOMATIC_CODE_CHUNKER_VERSION; per-file code_chunker_version proves newer finite imports. References accept an exact `file` (CLI `--file`) predicate before LIMIT. Both commands resolve `--source <id>` (space or inline `=` spelling) and the ambient source scope through the shared `code-scope.ts` resolver, matching `code-callers`/`code-callees`; `--all-sources` restores the brain-wide read. The `AND p.source_id = $N` fragment comes from `code-scope.ts`'s `pushSourcePredicate(params, opts)` (numbered off `params.length` so it composes with `--lang` and any other optional predicate; `''` when spanning every source) — code-def's lookup, its filtered-types probe, and code-refs all use it.

Fork delta — `src/core/entities/resolve.ts` — Free-form entity name → canonical slug resolution. `resolveEntitySlug(engine, source_id, raw)`: qualified exact slug → unique multi-token entity basename → alias-exact (curated aliases outrank root stubs; live collisions throw instead of fuzzy guessing) (an unambiguous `page_aliases` hit via `resolveAliases`, verified against LIVE pages since `page_aliases` has no FK — a stale alias row can never point at a deleted page; fail-open on pre-v110 brains missing the table; `ResolutionSource` reports `alias_exact`) → exact root slug → unambiguous bare-name prefix expansion across `people/<token>-%` + `companies/<token>-%` → high-specificity fuzzy match for multi-token input (pg_trgm @ 0.7 threshold) → deterministic `slugify` holding fallback. Bare-name collisions never use popularity as confidence; shared-token company names below the threshold remain unresolved. Two helpers for the phantom-redirect pass: `resolvePhantomCanonical(engine, sourceId, phantomSlug)` SKIPS the exact-slug step (a phantom slug `'alice'` would exact-match itself and no-op the redirect); returns the canonical only when non-null AND contains `/`. `findPrefixCandidates(engine, sourceId, token)` is a standalone SQL query returning ALL candidates across `PREFIX_EXPANSION_DIRS` (hardcoded `['people', 'companies']`) via `slug LIKE ANY($N::text[])` over patterns `dir/token` + `dir/token-%`, cap of 10 ordered by `connection_count DESC, slug ASC`. Pinned by `test/entity-resolve.test.ts` (explicit, unique, ambiguous-person, and shared-token-company cases) plus `test/phantom-redirect.test.ts` (resolvePhantomCanonical 3 cases + findPrefixCandidates 6 cases incl. multi-dir ambiguity and the `people/aliceberg`-doesn't-match-`alice` false-positive guard).

Fork delta — `src/core/config.ts` — `KNOWN_CONFIG_KEYS` contains each accepted exact key once; deduplicating a repeated entry must not change the key set or any config value. `src/core/cli-flag-registry.generated.ts` is rebuilt from the current handlers; keep existing enrichment language flags admitted without hand-editing output.

Fork delta — `src/core/facts/delta.ts` — the facts backstop extracts only new content. `computeFactsDelta` compares the previous body with the new one sentence by sentence (table rows whole, facts/takes fences ignored) and returns `none` (nothing new or under 30 chars: no LLM call), `delta` (only the new sentences, plus the header row of a table that gained rows; headings and unchanged lead-ins are not sent because the extractor turns every line it receives into facts) or `full` (new page or more than 60% new). Sync diffs against the snapshot its import just wrote (`readLastSnapshotBody`) and the durable job carries the delta as `extract_text`; a persistence put_page job, pinned to its revision by `readFactsBackstopJobPage`, diffs against the latest `page_versions` snapshot. A failed read falls back to whole-page extraction. `resolve.ts` adds an unambiguous `<people|companies|hosts|projects>/<last-segment>` step before minting a page-less slug. Tests: `test/fork-facts-backstop-delta.test.ts`.

Fork delta — `src/core/ai/gateway.ts` `embed()` — `embedding_query_prefix` (config file key, env `GBRAIN_EMBEDDING_QUERY_PREFIX`) is prepended to query-side inputs only (`inputType: 'query'`, configured model) for instruction-tuned embedders such as Giga-Embeddings; documents and per-column model overrides stay unprefixed. Tests: `test/fork-embedding-query-prefix.test.ts`.

Fork delta — stale-chunk selectors (`buildStaleChunkWhere` for `countStaleChunks`/`sumStaleChunkChars`, and every `listStaleChunks` variant in both engines) exclude soft-deleted pages: the embed path cannot load a deleted page, so counting its NULL-vector chunks kept `migrate embeddings` incomplete forever. A restored page is stale again and the next run embeds it. Upstream health now excludes deleted pages. `verifyMigrationComplete` reports their residue as `details.deleted_page_null_chunks` without subtracting it from the live missing count a second time; the live blocker remains intact. Tests: `test/fork-stale-excludes-deleted.test.ts`.

## v0.60.31 port and verification

The pinned base is upstream `2d8801b4eb5e21125d53999799ca267b5a1e587d`,
merged onto the prior reviewed fork candidate `e2cbb245`. Production remains
`92e06c6c` / schema157 until a separate activation decision. The numbered
migration map preserves existing fork IDs by migration name, keeps all eight
fork-only migrations, and appends new upstream migrations through197. The
migration-order guard must compare against the installed fork, not upstream's
different historical numbering. Bun1.4.0 is the minimum runtime.

| Contract | Port decision and verification surface |
| --- | --- |
| World-only host + source grants | Retained visibility policy and migrations147/152; remote source/document authorization remains independent. |
| Atomic fact fences, rollback, supersession | Moved SQL into shared engine-sql; retain pageProjection, requiredRows, exact replay and literal extraction-owner prefixes. Test both engines. |
| Scoped vector neighbours | Retain exact source/entity bucket before k; add upstream model/text-hash/dimension checks. Adversarial ANN tests retain the failing legacy control. |
| Withdrawal | Adopt normalized, subject-scoped upstream ledger; materialize each active claim fingerprint once before the migration join (the raw plan recomputed it per source-bucket pair); retain atomic projection and already-expired no-op. Supersession must not create a withdrawal. |
| Conversation epochs | Retain old-or-new epoch publication, pre/post source checks and manual-row ownership; use upstream managed derived-fact capability. |
| Atom safety and progress | Retain exact quoted single claims, semantic gate, shared price cap and epoch counters. Adopt source identity guard and stable undated/source-specific slug identity; preserve final content hash. |
| Proposal acceptance | Retain successful extraction receipt, literal whole-claim evidence and source revision. Adopt durable upstream request journal: a committed-but-unreported write retains its claim and retry settles the same request. |
| Code indexing | Retain finite lexical chunks, type-independent page_kind, exact file/source filtering, declaration preservation and automatic chunker floor6. New explicit imports use chunker8. |
| Search and embedding | Retain query prefix and host mode settings. Use upstream embedding-input provenance; no manufactured hashes or implicit reuse of contextual vectors. Deleted residue is reported separately from live missing vectors. |
| Sync and jobs | Retain per-source strategy, facts delta/known facts, bounded prune status/age filters, background facts embedding flag and global maintenance progress. |

TODO: FORK-20261002 tracks decomposition of pre-existing fork additions during
this merge. The function/module ratchets explicitly record their exact combined
sizes rather than deleting behavioral guards to satisfy an upstream-only size
baseline. Conversation extraction carries epoch ownership and snapshot checks;
atom extraction carries safety/progress and completion receipts; proposals carry
evidence receipts and source checks; fence writes carry atomic projection and
exact dedup; search/engines carry scoped candidates and host visibility; doctor
carries source-aware census; sync/extract/import carry source strategy/type and
facts-delta wiring; embed/migration carry fact embeddings and residue reporting;
the gateway's former chat body is now chatOnce behind fallback routing. Smaller
functions lower their baselines and obsolete entries are removed. The concrete
size deltas are retained in the staging execution receipts. These structural
exceptions do not relax behavioral, schema, security or retrieval gates.

Current execution evidence: `/root/gbrain-maintenance/2026-10-02-v06031/`.
This paragraph describes port decisions, not a completed acceptance result.

### Integration checks, 2026-10-03

Catalog snapshots intentionally include the retained fork tables `extract_health_state` and
`proposal_page_runs`, evidence/source-hash proposal columns, and the world-only default.
Review catalog diffs against those contracts; retrieval gold and thresholds are unchanged.
Managed-atom fixtures use upstream source-identity slugs and exact grounded evidence.
Withdrawal side-effect tests retain unrelated sentinels with distinct claims because private
fact fences become world on this host. A fact-vector guard test now attempts an actual claim
mutation; assigning world to an already-world fact is correctly a no-op.
Atom progress emits exactly one tick for every attempted work item, including rejected,
malformed or failed outputs, from the existing finally block; publication gates are unchanged.


### Integration decisions, 2026-10-03 01:45 UTC

This is an unaccepted staging checkpoint. The full unit and PostgreSQL runs have
unresolved failures; targeted PASS does not close those gates. Production stays
on schema157 and old code until separate operator approval.

- Remote safe-chunk admission now follows upstream independently of the host
  world-only page policy. The older legacy-chunk exemption is retired in this
  candidate; a complete stage projection rebuild is therefore required before
  search acceptance. Source grants and document ACLs remain mandatory.
- Context packs use the configured legacy/private compatibility resolver; the
  world-only host remains shared, while legacy profiles retain private filtering.
- Transcript extraction adopts source/path/hash tombstones, bounded deterministic
  failure counts and surfaced state-write errors. The fork still rejects publication
  without an exact single-claim quotation. `locateQuote` retains the upstream API;
  accepting a normalized span there does not authorize a non-exact publication.
- Reconciliation compares file content after the canonical world-fence and durable
  withdrawal overlays, while retaining raw preimages and raw-file CAS. This prevents
  false conflicts without reviving withdrawn facts. `mirror_read_only` sources stay
  read-only when shared-skills evaluates source policy.
- The PGlite upgrade replay fixture was built by production fork92e06c6c at schema157,
  not by current code. Its full catalogs remain pinned; fresh-vs-upgrade semantic
  comparison ignores physical column ordinals only. See its FORK-PROVENANCE.md.
- Structural golden changes reflect fork migration IDs/tables, source-aware SQL,
  world-only API descriptors and bounded maintenance flags. Retrieval gold and
  quality thresholds are unchanged. Restored upstream tests stay in the suite.

### PostgreSQL partial-result recovery

All three vendored PostgreSQL driver builds reset their row index at
`ReadyForQuery`. A server error or cancellation after `DataRow` can skip
`CommandComplete`; keeping the old index made the next result sparse and
produced false source/writer authorization failures. The guard itself is
unchanged. Real PostgreSQL tests exercise errors and cancellation after partial
rows through ESM and CJS imports and require a dense successor result on the
same backend connection. Reproduction before the fix and readback after it are
retained in the stage receipts.

### Explicit fact replacement and acceptance fixtures

Managed fence writes retain an explicit supersedesFactId in their frozen intent
and request identity. Publication rechecks the old row's source, subject,
visibility and live state, rejects ambiguous batch targets, and commits the
retired fence plus index together. Ordinary request identities remain unchanged;
restart replay returns the original result. The isolated PostgreSQL operation
chain exposed this lost-field bug; PGlite/PG tests exercise replacement and
cross-scope refusal. Gate results remain in the staging receipts.

Test fixtures now separate a fact's unresolved subject from its page origin,
provide grounded/opted-in atom inputs and explicit prices for synthetic fallback
models, and retain remote safe-chunk admission on the world-only host. Doctor
structural goldens normalize only recognized clean/dirty Git-drift messages as
volatile developer state, preserving probe errors and the rest of the report.
This does not change retrieval labels, thresholds, or runtime search results.


The host finite code writer is now an explicit managed maintenance intent,
not a legacy direct importer transaction. See `finite-code-maintenance.ts` and
the seven-case PGLite/PostgreSQL contract above. The external host adapter also
seals page projections after unmanaged metadata writes on newer cores. Host
manifest8 admission is limited to the existing13files; runtime-specific Bun
launchers are staged outside this core repository. Neither this commit nor a
code canary activates production or closes ordinary-answer quality audits.

## v0.60.45 port (acceptance pending)

Production activation was authorized on2026-10-04 after cleanup. Ten new
upstream migrations190..199 append as fork198..207; existing IDs and all eight
fork migrations remain immutable. This is schema207, not upstream199.

- `src/core/engine-sql/health-curated.ts` — shared fork curated graph counters;
  source scope and both endpoint liveness preserve existing host score semantics
  while shared health keeps upstream planner-safe embedding counters.

Chronicle now uses the upstream persistent ledger, shared eligibility with the
100-message conversation floor, and bounded max_total compatibility. Default
automatic Chronicle must be explicitly off in deployed config. Paid atom and
Chronicle routes remain fail-closed when a price is unknown; atoms retain the
semantic validator under the same attempt-wide cap. Global maintenance adopts
upstream durable phase resume and retains aggregate job progress.

TODO: FORK-20261004 carries forward the prior fork decomposition exception.
The v45 port retains epoch/source guards in conversation backfill, facts/takes
embedding paths, shared validator budgets, managed sync and scoped search.
Exact combined function/module bounds are recorded in the staging size-inventory
receipt; obsolete chat/upgrade/oauth baselines are removed and both engines'
ceilings shrink after health extraction. Runtime behavior gates are unchanged.
