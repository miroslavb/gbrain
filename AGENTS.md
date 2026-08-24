# Agents working on GBrain

This is your install + operating protocol. Claude Code reads `./CLAUDE.md` automatically.
Everyone else (Codex, Cursor, OpenClaw, Aider, Continue, or an LLM fetching via URL):
start here.

> **Becoming someone's persistent personal agent** (identity + memory + private repo)?
> Follow [`BOOTSTRAP_FOR_AGENTS.md`](./BOOTSTRAP_FOR_AGENTS.md) — the `gbrain bootstrap`
> flow — instead of the plain install below, then come back here for the operating
> protocol. Connecting to an EXISTING remote brain from a laptop agent?
> `gbrain connect https://your-host/mcp --token gbrain_xxx --install` (see the MCP
> table in [`README.md`](./README.md)).

## Install (5 min)

<!-- npm-trap + #218 recovery: canonical copy lives in README.md ("Install" warning) — sync edits. -->
1. Install gbrain via Bun (the canonical path):
   ```bash
   curl -fsSL https://bun.sh/install | bash
   export PATH="$HOME/.bun/bin:$PATH"
   bun install -g github:garrytan/gbrain
   ```
   If `bun install -g` aborts or `gbrain doctor` reports `schema_version: 0`,
   the CLI prints a recovery hint pointing at [#218](https://github.com/garrytan/gbrain/issues/218).
   Run `gbrain apply-migrations --yes` to recover, or fall back to the
   deterministic install: `git clone https://github.com/garrytan/gbrain.git ~/gbrain && cd ~/gbrain && bun install && bun link`.
2. Init the brain: `gbrain init` (defaults to PGLite, zero-config). For 1000+ files or
   multi-machine sync, init suggests Postgres + pgvector via Supabase.
3. **STOP — ask the user about search mode.** `gbrain init` auto-applied a
   default but printed a 9-cell cost matrix (mode × downstream model)
   preceded by `[AGENT]` markers. You MUST relay the matrix to the operator
   and confirm their choice before continuing. Cost spread between corners
   is 25x — silent acceptance is the wrong default. See
   [`./INSTALL_FOR_AGENTS.md`](./INSTALL_FOR_AGENTS.md) Step 3.5 for the
   exact ask-the-user protocol. Same banner fires on `gbrain post-upgrade`
   for existing users (search modes were added in v0.32.3).
4. Read [`./INSTALL_FOR_AGENTS.md`](./INSTALL_FOR_AGENTS.md) for the full step-by-step
   flow (API keys, identity, cron, verification).

## Read this order

1. `./AGENTS.md` (this file) — install + operating protocol.
2. [`./CLAUDE.md`](./CLAUDE.md) — orientation + resolver: architecture, cross-cutting
   invariants, the reference map, inline ship rules. It routes to on-demand detail docs:
   [`./docs/architecture/KEY_FILES.md`](./docs/architecture/KEY_FILES.md) (per-file index —
   read a file's entry before editing it), [`./docs/TESTING.md`](./docs/TESTING.md) (test
   tiers + isolation lint + E2E lifecycle), and
   [`./docs/architecture/thin-client.md`](./docs/architecture/thin-client.md) (remote-MCP seam).
3. [`./docs/architecture/brains-and-sources.md`](./docs/architecture/brains-and-sources.md)
   — the two-axis mental model (brain = which DB, source = which repo in the DB). Every
   query routes on both axes. Read before writing anything that touches brain ops.
4. [`./skills/conventions/brain-routing.md`](./skills/conventions/brain-routing.md) —
   agent-facing decision table: when to switch brain, when to switch source, how
   cross-brain federation works (latent-space only; the agent decides).
5. [`./skills/RESOLVER.md`](./skills/RESOLVER.md) — skill dispatcher. Read before any task.

## Trust boundary (critical)

GBrain distinguishes **trusted local CLI callers** (`OperationContext.remote = false`,
set by `src/cli.ts`) from **untrusted agent-facing callers** (`remote = true`, set by
`src/mcp/server.ts`). Security-sensitive operations like `file_upload` tighten filesystem
confinement when `remote = true` and default to strict behavior when unset. If you are
writing or reviewing an operation, consult `src/core/operations.ts` for the contract.

## Common tasks

- **Verification hygiene:** generated skill/plugin gates describe the committed
  tree. Do not make them green by staging or deleting unrelated local reference
  packs; reproduce branch health in a clean clone. Pay module-size ratchets down
  by compacting or peeling code instead of silently raising their ceilings.
- **Autopilot install-test isolation:** tests that call `writeWrapperScript()`
  must keep the preload's per-run `GBRAIN_HOME` or replace it with another
  explicit scratch root. Changing `HOME` alone is insufficient under Bun because
  `os.homedir()` can remain cached. Never let an install test resolve
  `$GBRAIN_HOME/.gbrain/autopilot-run.sh` to the operator's live wrapper.
- **Global-maintenance observability:** the brain-wide maintenance job owns a
  60-minute aggregate deadline (distinct from a 30-minute source cycle) and
  persists canonical `current/last-completed` phase progress at every phase
  boundary. Keep progress aggregate-only and best-effort so diagnostics never
  become a new cycle failure mode.
- **Conversation-facts epoch safety:** stage every page in bounded memory and
  publish extractor-owned rows plus the terminal marker in one reconcile
  transaction. Lock/recheck page identity; for `raw_transcript`, use the
  symlink-safe bounded reader and run the sidecar digest check both before and
  after row mutations. Any failure preserves the previous completed epoch.
- **Interrupted transcript quarantine:** the exact Hermes
  `Operation interrupted: waiting for model response (...)` transport status
  is not conversation content. Drop it before conversation-facts segmentation,
  so a request with no completed reply becomes a durable non-extractable
  outcome instead of publishing requested work as fact.
- **Indexed-session parser coverage:** generated Hermes previews use closed-role
  `**User|Assistant|System|Tool|Human** (YYYY-MM-DD): text` anchors. Keep the
  date-only parser role-enumerated, continuation-aware, and day-accurate at
  midnight UTC; arbitrary dated bold labels must not become speakers.
  Conversation-format coverage and facts extraction must distinguish true parser
  gaps (canonical session/conversation slugs, transcript metadata, or repeated
  speaker anchors) from narrative meetings and code/docs accidentally typed as
  `email`; definitive non-transcripts receive a durable non-extractable outcome.
- **MDX route slugs:** slash-prefixed `slug:` values in `.mdx` are external
  website routes (for example Docusaurus `slug: /`), not GBrain identities.
  Ignore the route during file import and retain the path-derived DB slug;
  non-route mismatches must still fail as page-hijack attempts.
- **Drift parity:** `multi_source_drift` must use the same file-admission
  boundary as source sync. In particular, markdown symlinks are not pages and
  must never create a false misroute warning.
- **Graph denominators:** brain-score graph components cover canonical
  concept/project/analysis/guide/person/company/entity/organization pages.
  Report session/archive isolation separately, including parent-session entity
  links; never improve the score by hiding the curated island backlog.
- **Take proposals:** legacy rows without exact evidence, source hashes, and a
  matching successful `proposal_page_runs` receipt are audit history, never an
  acceptance queue. New producer canaries stay page-bounded; proposal rows and
  their per-page terminal receipt publish in one transaction. Migration 142
  must also converge the briefly shipped v127 `outcome`/four-column-PK layout;
  its sequential handler makes each ALTER visible before dependent SQL because
  `CREATE TABLE IF NOT EXISTS` alone is not a schema migration. Producer
  selection is restricted in SQL (before `LIMIT`) to durable concept/atom/lore/
  briefing/writing/originals pages and also denies operational slug contours
  (`projects/`, `infra/`, `infrastructure/`, `features/`, generated `*/skill`)
  plus generic Jira and Confluence import contours (`*/jira/*`, `*/cf/*`)
  because production type metadata is not authoritative. Conversations,
  sessions, projects, companies, imported system records, and operational pages
  are out of scope. The production selector also requires at least 800
  characters of compiled prose
  before `LIMIT`; short factual stubs must not consume bounded canary slots.
  Every selected page passes the shared deterministic full-source sensitivity
  scanner before any external LLM call. A hit writes only a
  `quality_rejected/sensitive_source` receipt with deterministic scanner model
  provenance—never the matched value—and sends no page content externally. The
  production parser accepts only prediction/judgment/bet outputs whose claim
  text is itself an exact contiguous substring of the evidence span and carries
  a deterministic multilingual kind signal (forward/uncertainty for predictions
  and bets; opinion/evaluation/recommendation for judgments). Bare KPIs, ETAs,
  historical measurements, procedural facts and headings fail closed even when
  quoted exactly. Markdown hard-wrap whitespace may be canonicalized only by an
  exact non-whitespace-character match; persist the recovered source bytes and
  never use fuzzy/paraphrase grounding. Explicit holders must match the prompt's closed
  world/brain/people/company forms and explicit weights must be finite in
  `[0,1]`; do not silently normalize malformed model output. Migration 143 adds
  aggregate-only first-failure reason histograms to page receipts. These counts
  and phase details use stable codes only and must never persist source or
  candidate text. Receipts record the
  provider/model that actually answered after fallback. Empty outcomes live only
  in `proposal_page_runs`, dry-run writes nothing, and pending-list reads hide
  proposals whose source snapshot or evidence is no longer current.
- **Extraction quality gates:** conversation facts and atoms must pass the
  deterministic sensitive scanner and the batched semantic support/atomicity
  gate before any write. Gate failure is fail-closed; receipts contain counts,
  stable reason codes, and actual route/model only—never source or candidate text.
  Bind receipt histograms as raw JSON objects through `executeRawJsonb`; migration
  144 repairs double-encoded JSONB strings and enforces object-shaped histograms.
  The conversation extractor prompt must also exclude IP/email/phone values,
  credentials, private paths, and secret-bearing URLs before candidates reach
  the gate. Redact those values plus configured sensitive literals before the
  LLM call; deterministic post-LLM rejection remains mandatory defense in depth.
  Atom budget accounting must load `pricing.overrides` for both the extractor
  and semantic-validator routes; preserve typed `BudgetExhausted` stops instead
  of folding them into semantic rejection counts.
  Exact-quote atoms also fail closed on multilingual compound/list evidence
  (including spaced slashes and parenthetical enumerations) and vague/deictic
  fragments before the semantic batch.
- **Chronicle yield gate:** explicit conversation `message_count < 100` is
  ineligible, including note-typed `conversations/` rescue pages. Meetings and
  calendar events are unaffected; missing metadata keeps legacy eligibility.
  Backstop, backfill, and advisor must call the same predicate. Bounded
  backfill canaries must set `--max-total`; it is a hard cross-type admission
  cap and selects newest eligible pages globally after per-type discovery.
- **Drain containment:** `cycle.propose_takes.enabled` is default-off; only an
  explicit true value or trusted one-shot `--once` runs it. Keep atom auto-drain
  and conversation-facts bulk drain disabled until bounded quality canaries pass.
- **Atom population containment:** pack-extractable `note` and `conversation`
  pages require frontmatter `atom_extract: true`; `atom_extract: false` denies
  any otherwise extractable page. Discovery, backlog/doctor, drain, and
  autopilot must share this predicate. Do not broaden these high-volume types
  back to implicit eligibility without a measured, privacy-safe corpus canary.
- **Value-ordered reindex:** markdown queue work must be bounded and scoped with
  `--source` / `--type` / `--prefix` / `--retrieved-since`, then ordered with
  `--hot-first`. Benchmark 100 representative pages with four workers before
  any broader tranche; JSON output must echo the resolved scope.
- **Bounded stale extraction:** link/timeline backlog canaries must set
  `extract --stale --max-pages N`; the exact cross-batch cap wins over
  `--catch-up`. Validate page freshness plus link/timeline graph integrity after
  the 100-page tranche before admitting the 500-page tranche.
  The link identity constraint must be `UNIQUE NULLS NOT DISTINCT` over
  `(from_page_id,to_page_id,link_type,link_source,origin_page_id)`; migration
  v141 repairs legacy `*_key` constraints and retains the earliest duplicate.
- **Private documents:** ordinary search excludes `docs/inbox/`; uploaded
  documents are read only through the caller-aware document ACL surface.

- **Configure:** [`docs/ENGINES.md`](./docs/ENGINES.md),
  [`docs/guides/live-sync.md`](./docs/guides/live-sync.md),
  [`docs/mcp/DEPLOY.md`](./docs/mcp/DEPLOY.md).
- **Debug:** [`docs/GBRAIN_VERIFY.md`](./docs/GBRAIN_VERIFY.md),
  [`docs/guides/minions-fix.md`](./docs/guides/minions-fix.md), `gbrain doctor --fix`.
- **Migrate / upgrade:** `gbrain upgrade` (binary self-update + schema migrations + post-upgrade prompts),
  [`docs/UPGRADING_DOWNSTREAM_AGENTS.md`](./docs/UPGRADING_DOWNSTREAM_AGENTS.md),
  [`skills/migrations/`](./skills/migrations/), `gbrain apply-migrations --yes` (manual schema-only).
- **Eval retrieval changes:** capture is off by default. To benchmark a
  retrieval change against real captured queries, set
  `GBRAIN_CONTRIBUTOR_MODE=1`, then `gbrain eval export --since 7d > base.ndjson`
  and `gbrain eval replay --against base.ndjson`. For public benchmark
  coverage (LongMemEval, ground-truth scoring), `gbrain eval longmemeval
  <dataset.jsonl>` runs against an isolated in-memory PGLite
  per question — your `~/.gbrain` is never opened. Full guide:
  [`docs/eval-bench.md`](./docs/eval-bench.md).
- **Drive the brain to a target health score:** the one-command
  loop. `gbrain doctor --remediation-plan --json` previews what would be
  fixed; `gbrain doctor --remediate --yes --target-score 90 --max-usd 5`
  walks a dependency-ordered plan (sync before extract, embed after
  consolidate), re-checking score between every step, refusing to spend
  past the cost cap. Empty brains (no entity pages) or unconfigured embedding
  keys hit a `max_reachable_score` ceiling and bail with what's missing.
  Three phase handlers (synthesize / patterns / consolidate) are
  PROTECTED — only trusted local callers can submit them; MCP cannot.
  Reference: [`docs/architecture/topologies.md`](./docs/architecture/topologies.md).
- **Track a founder/company over time:** when an entity has
  typed metric claims in its `## Facts` fence (`metric: mrr`, `value: 50000`,
  `unit: USD`, `period: monthly` columns), run
  `gbrain eval trajectory <entity-slug>` for the chronological history
  with regressions auto-flagged, or `gbrain founder scorecard <entity-slug>`
  for a four-signal JSON rollup (claim_accuracy / consistency /
  growth_trajectory / red_flags). MCP op `find_trajectory` exposes the
  same data — read scope, visibility-filtered for remote callers.
  `gbrain think` uses this substrate automatically on temporal /
  knowledge_update intent (default ON; flip `think.trajectory_enabled=false`
  to opt out). Non-metric event rows (`meeting`, `job_change`,
  `location_change`) ride through the same pipeline via `facts.event_type`;
  pass `kind: 'event'` or `'all'` to `find_trajectory` to query them.
- **Everything else:** [`./llms.txt`](./llms.txt) is the full documentation map.
  [`./llms-full.txt`](./llms-full.txt) is the same map with core docs inlined for
  single-fetch ingestion.

## Before shipping

Easiest path: `bun run ci:local` runs the full CI gate inside Docker (gitleaks,
guards + typecheck, then 4-shard parallel unit + E2E against four pgvector
containers plus a transaction-mode PgBouncer; unit phase keeps `DATABASE_URL`
unset) and tears down. Use `bun run ci:local:diff` for the
diff-aware subset during fast iteration on a focused branch. Requires Docker
(Docker Desktop / OrbStack / Colima) and `gitleaks` (`brew install gitleaks`).

Manual path: `bun test` plus the E2E lifecycle described in `./CLAUDE.md` (spin
up the test Postgres container, run `bun run test:e2e`, tear it down).

Ship via the `/ship` skill, not by hand. The full release + contributor process
(CHANGELOG voice, version-locations sync, PR conventions, community-PR-wave) lives in
[`./docs/RELEASING.md`](./docs/RELEASING.md); read it before shipping.

## Privacy

Never commit real names of people, companies, or funds into public artifacts. See the
Privacy rule in `./CLAUDE.md`. GBrain pages reference real contacts; public docs must
use generic placeholders (`alice-example`, `acme-example`, `fund-a`).

## Forks

If you are a fork, regenerate `llms.txt` + `llms-full.txt` with your own URL base before
publishing: `LLMS_REPO_BASE=https://raw.githubusercontent.com/your-org/your-fork/main bun run build:llms`.
