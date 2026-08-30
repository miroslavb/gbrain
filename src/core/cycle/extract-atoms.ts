// v0.41.2.1 — extract_atoms cycle phase, post-fix-wave rebuild.
//
// Sequencing per cycle:
//   1. Discover transcripts via discoverTranscripts() AND brain pages
//      via a single raw SQL query (NOT EXISTS subquery filters out
//      pages already extracted by content hash — see "Idempotency" below).
//   2. Dedup by content_hash; transcripts win on collision.
//   3. Per work-item, ask the configured extract_atoms model (key-aware
//      utility-tier default, see resolveExtractAtomsModel below) for 1-3 atoms.
//   4. Write each atom via importFromContent(slug, markdown, {sourceId})
//      with sourceId threaded so federated brains route correctly. The
//      canonical import path (not engine.putPage) is what chunks and embeds
//      the page — see the write site below and #2163.
//
// Idempotency (per-atom, via deterministic slug):
//   Each atom's slug is `atoms/<source-date>/<stem>-<title-hash>` — built from
//   the SOURCE date (the transcript's own date / the page slug), NOT the run
//   date, plus a 6-char hash of the title. Re-extracting the same atom resolves
//   to the SAME slug, so the import upserts in place instead of minting a
//   duplicate. This closes three bugs in one scheme:
//     - PR #1414's page-side re-extraction.
//     - The cross-day transcript duplicate: append-only transcripts grow daily,
//       so a run-date prefix (`atoms/<today>/…`) used to re-mint the same atom
//       under a new date every day. A source-date prefix is stable, so it now
//       upserts.
//     - The "trailing-dash twin": the stem routes through slugifySegment (the
//       FS-import normalizer) and re-strips a trailing dash after the 60-char
//       truncation, so the two write paths can no longer disagree on `…would`
//       vs `…would-` and persist the same atom twice.
//
//   The source_hash batch check (atomsExistingForHashes) is retained ONLY as a
//   cost fast-path — it skips re-running Haiku on a transcript whose whole-file
//   hash is unchanged. On append-only sources that hash changes daily so the
//   fast-path won't skip, but the deterministic slug makes the re-run upsert
//   rather than duplicate, so correctness no longer depends on it.
//
// Config:
//   Reads dream.synthesize.session_corpus_dir + meeting_transcripts_dir
//   via loadConfigWithEngine() (D9 #10: precedence is file > DB > defaults;
//   no GBRAIN_DREAM_* env vars exist). Closes PR #1416's silent-config bug
//   for this caller.
//
// Budget: $0.30/source/run, key `cycle.extract_atoms.budget_usd`.
// Exceeded budget halts with PhaseStatus='warn' + partial result.
//
// Source-scoped: opts.sourceId gates brain-global transcript discovery,
// the discovery SQL (source_id = $1), the NOT EXISTS idempotency
// subquery (atom.source_id = $1), AND every putPage write
// ({sourceId} third arg). Pre-fix the putPage call was missing the
// sourceId arg — atoms always wrote to 'default' regardless of source,
// which made the NOT EXISTS guard ineffective on federated brains.

import type { BrainEngine, LinkBatchInput } from '../engine.ts';
import { stripReasoningBlocks } from '../llm-json.ts';
import type { PhaseResult } from '../cycle.ts';
import type { GBrainConfig } from '../config.ts';
import { isConfigTruthy } from '../config.ts';
import type { ProgressReporter } from '../progress.ts';
import { chat as gatewayChat, withBudgetTracker, isAvailable } from '../ai/gateway.ts';
import { createGlobalLlmHaltTracker, haltedClassOf, type GlobalLlmErrorClass } from '../ai/errors.ts';
import { importFromContent } from '../import-file.ts';
import { serializeMarkdown } from '../markdown.ts';
import { truncateUtf8 } from '../text-safe.ts';
import {
  BudgetExhausted,
  BudgetTracker,
  isModelPriceable,
  loadPricingOverrides,
  type PricingOverrides,
} from '../budget/budget-tracker.ts';
import { writeReceipt } from '../extract/receipt-writer.ts';
import { updateExtractHealthState, upsertExtractRollup } from '../extract/rollup-writer.ts';
import { randomUUID } from 'crypto';
import { atomSlug } from './atom-slug.ts';
import {
  AtomSemanticValidationError,
  createGatewayAtomSemanticValidator,
  parseAtomSemanticResponse,
  parseConfiguredSensitivePatterns,
  scanAtomCandidate,
  semanticRejectionReasons,
  type AtomSemanticBatchResult,
  type AtomSemanticValidator,
} from './atom-safety.ts';
import { resolveTierDefault } from '../model-config.ts';

const DEFAULT_BUDGET_USD = 0.3;
// Fork's DEFAULT_EXTRACT_ATOMS_MODEL is intentionally gone: upstream #3813
// replaces its only use with a key-aware tier default, so an install with no
// Anthropic key no longer routes atom extraction to an unservable provider.
const DEFAULT_ATOM_VALIDATOR_MODEL = 'anthropic:claude-haiku-4-5';
const DEFAULT_ATOM_VALIDATOR_TIMEOUT_MS = 30_000;
const MAX_DRY_RUN_WORK_ITEMS = 10;
// #4529 + #4540: per-item extractor caps, overridable via
// cycle.extract_atoms.* config keys (max_input_chars — with the #4529
// legacy alias max_source_chars — plus max_output_tokens / pacing_ms).
// Exported so tests pin the defaults instead of re-hardcoding the literals.
export const DEFAULT_EXTRACT_MAX_INPUT_CHARS = 50_000;
export const DEFAULT_EXTRACT_MAX_OUTPUT_TOKENS = 4096;

/**
 * gbrain#4148: consecutive same-content failures of a content-deterministic
 * class (malformed model output or an all-quality-rejected candidate batch)
 * before the page is tombstoned so the backlog floor can clear. A content
 * edit resets the streak. Provider/validator operational failures never
 * consume this retry allowance.
 */
export const MAX_DETERMINISTIC_FAILURES = 3;

/**
 * Transient provider/infra failure shapes — retryable, never counted.
 * Numeric codes are word-bounded so a 3-digit run inside prose or a larger
 * number ("chunk 1500", "$1.512") doesn't read as an HTTP 5xx/429.
 */
const TRANSIENT_EXTRACT_ERROR_RE =
  /timeout|timed out|\b429\b|rate.?limit|\b5\d\d\b|ECONN|ETIMEDOUT|EPIPE|ENOTFOUND|fetch failed|\bnetwork\b|socket|overloaded/i;

// v0.42+ TODO: read atom_type enum from active pack manifest at runtime.
const ATOM_TYPES = [
  'insight', 'anecdote', 'quote', 'framework', 'statistic',
  'story_angle', 'strategy_angle', 'strategy', 'endorsement',
  'critique', 'collection',
] as const;

// v0.41.2.1 (D2): brain-page discovery constants.
//
// Legacy floor: the pre-pack hardcoded atom-extraction types. Retained as a
// back-compat union member so a gbrain-base brain never loses an extraction
// target when we begin honoring the pack manifest's `extractable` flags.
const LEGACY_EXTRACTABLE_TYPES = [
  'meeting', 'source', 'article', 'video', 'book', 'original',
] as const;

// Synthesis outputs are never extraction inputs: extracting atoms from atoms or
// concepts would loop (concepts are synthesized FROM atoms). Mirrors
// facts/eligibility.ts, which likewise excludes `concept` despite its
// extractable:true flag being a documented forward-compat marker.
const SYNTHESIS_OUTPUT_TYPES = new Set<string>(['atom', 'concept']);

// `note` is the schema catch-all and `conversation` is the high-volume archive
// surface. Treating either pack-level `extractable:true` bit as blanket consent
// makes a federated brain spend its atom budget on source code, skills, session
// archives, and raw operator transcripts. These broad types therefore require
// an explicit per-page `atom_extract: true` frontmatter opt-in. Curated legacy
// and media types retain their pack-driven behavior. Any page type can opt out
// explicitly with `atom_extract: false`.
export const ATOM_EXPLICIT_OPT_IN_TYPES = ['note', 'conversation'] as const;
const ATOM_EXPLICIT_OPT_IN_TYPES_SQL = ATOM_EXPLICIT_OPT_IN_TYPES
  .map((type) => `'${type}'`)
  .join(', ');

// Shared by discovery and backlog counting. Keep this as one SQL fragment so
// doctor/autopilot never advertise work that the phase itself will refuse.
//
// STRICT (default): broad catch-all types need an explicit per-page
// `atom_extract: true`. OPEN: only an explicit `atom_extract: false` denies —
// the operator has decided to mine the whole corpus. Both honor the opt-OUT,
// so a page marked false is never extracted under either policy.
const ATOM_PAGE_OPT_IN_POLICY_SQL_STRICT = `
      AND lower(COALESCE(p.frontmatter->>'atom_extract', '')) <> 'false'
      AND (
        NOT (p.type = ANY(ARRAY[${ATOM_EXPLICIT_OPT_IN_TYPES_SQL}]::text[]))
        OR lower(COALESCE(p.frontmatter->>'atom_extract', '')) = 'true'
      )`;

const ATOM_PAGE_OPT_IN_POLICY_SQL_OPEN = `
      AND lower(COALESCE(p.frontmatter->>'atom_extract', '')) <> 'false'`;

/**
 * `cycle.extract_atoms.broad_types_require_opt_in` (default TRUE = strict).
 * Set it false to mine broad types corpus-wide. Fails CLOSED: an unset key, a
 * read error, or any non-falsy value keeps the strict policy, so the expensive
 * posture is never entered by accident. Resolved per call (not cached) so the
 * operator can close the gate again without a restart — discovery and the
 * doctor backlog count then agree on the very next cycle.
 */
async function resolveAtomOptInPolicySql(engine: BrainEngine): Promise<string> {
  try {
    const raw = await engine.getConfig('cycle.extract_atoms.broad_types_require_opt_in');
    if (raw != null && !isConfigTruthy(raw)) return ATOM_PAGE_OPT_IN_POLICY_SQL_OPEN;
  } catch { /* fail closed to strict */ }
  return ATOM_PAGE_OPT_IN_POLICY_SQL_STRICT;
}

const PAGE_DISCOVERY_BUDGET = 50;
const MIN_PAGE_CHARS_FOR_EXTRACTION = 500;
// Source pages whose frontmatter declares a `raw` payload pointer hold raw
// import data, not extractable prose. Extraction on them yields zero atoms,
// so no atom row is ever written and they re-enter discovery + the doctor
// backlog count on every cycle — a permanent no-progress loop. Shared by
// discoverExtractablePages and countExtractAtomsBacklog so the phase and the
// doctor check can't drift.
const RAW_SOURCE_HOLDER_EXCLUSION_SQL =
  `AND NOT (p.type = 'source' AND COALESCE(p.frontmatter ? 'raw', false))`;

/**
 * Pure allowlist policy: the legacy floor UNION the pack's `extractable: true`
 * types, MINUS synthesis outputs. Exported for unit tests; keep I/O-free.
 */
export function unionExtractableTypes(packExtractable: Iterable<string>): string[] {
  const types = new Set<string>(LEGACY_EXTRACTABLE_TYPES);
  for (const t of packExtractable) types.add(t);
  for (const t of SYNTHESIS_OUTPUT_TYPES) types.delete(t);
  return [...types];
}

/**
 * Resolve the atom-extraction type allowlist from the active schema pack.
 * Closes the D2 TODO of honoring the pack manifest (so a type declared
 * extractable — e.g. `note` — actually extracts) while preserving behavior for
 * gbrain-base via the legacy-floor union. Fail-soft: any pack-load error falls
 * back to the legacy floor.
 */
async function resolveExtractableTypes(): Promise<string[]> {
  let packExtractable: Iterable<string> = [];
  try {
    const { loadConfig } = await import('../config.ts');
    const { loadActivePack } = await import('../schema-pack/load-active.ts');
    const { extractableTypesFromPack } = await import('../schema-pack/extractable.ts');
    const resolved = await loadActivePack({ cfg: loadConfig(), remote: false });
    packExtractable = extractableTypesFromPack(resolved.manifest);
  } catch {
    // Pack unavailable (test seams, bootstrap) — legacy floor only.
  }
  return unionExtractableTypes(packExtractable);
}

export interface ExtractAtomsOpts {
  brainDir?: string;
  sourceId?: string;
  dryRun?: boolean;
  affectedSlugs?: string[];
  /** Test seam: alternative chat function (bypasses real LLM calls). */
  _chat?: typeof gatewayChat;
  /** Test seam: batched semantic pre-write validator. Production uses gatewayChat. */
  _semanticValidator?: AtomSemanticValidator;
  /** Test seam for the fail-closed wall-clock wrapper around injected validators. */
  _semanticTimeoutMs?: number;
  /**
   * Test seam: alternative config loader. Sync OR async — extended in
   * v0.41.2.1 to allow loadConfigWithEngine() (async) to be the default.
   */
  _loadConfig?: () => GBrainConfig | Promise<GBrainConfig | null> | null;
  /** Test seam: skip transcript discovery; use these transcripts directly. */
  _transcripts?: Array<{ filePath: string; content: string; contentHash: string }>;
  /**
   * Test seam (v0.41.2.1): skip page discovery; use these pages directly.
   * Mirrors _transcripts shape. `undefined` triggers discovery; `[]`
   * explicitly suppresses page discovery (for transcript-only tests).
   */
  _pages?: Array<{ slug: string; content: string; contentHash: string }>;
  /**
   * v0.41.19.0 (T3): cooperative yield hook fired from inside the work
   * loop on a 30s throttle AND immediately after every `await chat()`
   * LLM call. Cycle.ts threads `buildYieldDuringPhase(lock, outer)` so
   * each fire refreshes the cycle DB lock + the existing external hook
   * (Minion job-lock renewal). Without it a long phase loses the lock
   * after the v0.41.19.0 TTL drop 30→5min.
   */
  yieldDuringPhase?: () => Promise<void>;
  /**
   * v0.41.19.0 (T4): progress reporter for in-phase ticks. Cycle.ts
   * passes the SAME reporter (not a child — codex caught the path-
   * collision bug where `progress.child('extract_atoms')` under parent
   * state `cycle.extract_atoms` would produce
   * `cycle.extract_atoms.extract_atoms.work`). Cycle.ts owns the
   * phase-level start/finish; phases only call `tick()` and
   * `heartbeat()` on the passed reporter.
   */
  progress?: ProgressReporter;
}

export interface ExtractAtomsBudgetPricingPolicy {
  pricingOverrides?: PricingOverrides;
  unpricedModels: string[];
  enforceCostCap: boolean;
}

/**
 * Resolve one shared budget policy for BOTH LLM calls in the phase: extractor
 * and semantic validator. Operator pricing.overrides must price either route
 * before a cap is enforceable.
 */
export async function resolveExtractAtomsBudgetPricingPolicy(
  engine: Pick<BrainEngine, 'getConfig'>,
  extractModel: string,
  validatorModel: string,
): Promise<ExtractAtomsBudgetPricingPolicy> {
  const pricingOverrides = await loadPricingOverrides(engine);
  const unpricedModels = [...new Set([extractModel, validatorModel])]
    .filter((model) => !isModelPriceable(model, 'chat', pricingOverrides));
  return {
    pricingOverrides,
    unpricedModels,
    enforceCostCap: unpricedModels.length === 0,
  };
}

interface ExtractedAtom {
  title: string;
  atom_type: typeof ATOM_TYPES[number];
  body: string;
  source_quote?: string;
  lesson?: string;
  /**
   * 1-3 kebab-case topic labels for concept clustering. Consumed by
   * synthesize_concepts (groups atoms by `frontmatter.concepts`; only
   * labels shared by >=2 atoms materialize a concept page, so the prompt
   * biases reuse-over-coinage). #2123.
   */
  concepts?: string[];
  virality_score?: number;
  emotional_register?: string;
}

/** kebab-case validator for concept labels ("captive-portal", "channel-pricing"). */
const CONCEPT_LABEL_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_GROUNDED_BODY_CHARS = 280;
const COMPOUND_CLAIM_JOIN_RE = /(?:\b(?:and|but|while|whereas|therefore|so)\b|(?:^|[\s,])(?:и|но|а также|тогда как|поэтому)(?=$|[\s,]))/iu;
const DEICTIC_START_RE = /^(?:this|that|it|they|these|those|such)\b/i;
const RU_DEICTIC_OR_VAGUE_START_RE = /^(?:это|этот|эта|эти|он|она|оно|они|такой|такая|такие|значение|значения|параметр|параметры|данные)(?=$|[\s,:;.!?-])/iu;
// A title cannot repair an evidence quote whose grammatical subject is only
// meaningful inside the source page. Production sampling found that the
// semantic validator still accepted bare subjects such as "Buttons ...",
// "Dark theme ...", and a post-comma "the system ...". Keep this fence
// precision-biased: named subjects before these nouns do not match.
const CONTEXTLESS_GENERIC_SUBJECT_RE =
  /(?:^|[,\u2013\u2014]\s+)(?:(?:the|a|an)\s+)?(?:system|site|website|app|application|model|workflow|pipeline|configuration|config|process|phase|buttons?|themes?|endpoints?|hover\s+states?|override|values?|data|operations?|ops|ratios?)\b/iu;
const CONTEXTLESS_MODIFIED_GENERIC_SUBJECT_RE =
  /^(?:(?:current|existing|default|dark|light|different|several|multiple)\s+)(?:buttons?|themes?|operations?|ops|ratios?)\b|^(?:four|\d+)\s+[a-z0-9-]+\s+(?:operations?|ops)\b|^different\s+feed\/kill\s+ratios?\b/iu;
const RU_CONTEXTLESS_GENERIC_SUBJECT_RE =
  /(?:^|[,\u2013\u2014]\s+)(?:(?:эта|этот|эти)\s+)?(?:система|сайт|приложение|проект|репозиторий|сервис|платформа|модель|процесс|этап|кнопки?|тема|эндпоинт|воркфлоу|пайплайн)(?=$|[\s,:;.!?-])/iu;
const INLINE_ENUMERATION_RE = /(?:\s\/\s|\([^)]*(?:,|\/|\b(?:including|included|incl\.?)\b|(?:включая|в\s+т\.?\s*ч\.?)(?=$|[\s,]))[^)]*\))/iu;

function isSingleAtomicSentence(value: string, maxChars: number): boolean {
  const text = value.trim();
  if (!text || text.length > maxChars) return false;
  if (/[\n\r;]/.test(text) || /^[-*]\s/m.test(text)) return false;
  const boundaries = text.match(/[.!?](?=\s|$)/g) ?? [];
  return boundaries.length <= 1;
}

function isSelfContainedAtomicEvidence(value: string): boolean {
  const text = value.trim();
  return !COMPOUND_CLAIM_JOIN_RE.test(text)
    && !DEICTIC_START_RE.test(text)
    && !RU_DEICTIC_OR_VAGUE_START_RE.test(text)
    && !CONTEXTLESS_GENERIC_SUBJECT_RE.test(text)
    && !CONTEXTLESS_MODIFIED_GENERIC_SUBJECT_RE.test(text)
    && !RU_CONTEXTLESS_GENERIC_SUBJECT_RE.test(text)
    && !INLINE_ENUMERATION_RE.test(text);
}

const EXTRACT_PROMPT = `You extract atomic content nuggets from a transcript.

An atom is a single-source, self-contained idea containing exactly one independently checkable claim. Each atom must:
  - Stand alone with enough names/context to understand it (no "as discussed above")
  - Make one clear, specific point; split independent claims into separate atoms
  - Be supported by source_quote, an exact contiguous substring of the source (required, ≤200 chars)
  - body MUST be exactly one sentence (≤200 chars) and body MUST equal source_quote exactly
  - source_quote must name its specific subject; never begin with This, That, It, They, These, Those, or Such
  - source_quote must be a complete standalone sentence, not a fragment such as "values are not logged" or "the override was unrelated"
  - lesson MUST be omitted; it would create a second claim surface
  - Never join independent claims with "and", "but", "while", "и", "но", a slash, a semicolon, parentheses, or a list; split them into separate atoms
  - Do not infer causation, generalize beyond the source, or invent quantities

If the source does not support at least one such atom, Return [] exactly.
Output a JSON array of atoms (1-3 per transcript, never more than 3).
Each atom: {title (≤80 chars; one claim only), atom_type, body (exactly the same text as source_quote),
source_quote (verbatim contiguous single-sentence substring ≤200 chars), concepts
(1-3 topic labels), virality_score (0-100), emotional_register (one of:
shocking, inspiring, funny, sobering, practical, controversial)}.

atom_type MUST be one of: ${ATOM_TYPES.join(', ')}.

concepts are kebab-case English TOPIC labels used to cluster atoms into
concept pages (e.g. "captive-portal", "channel-pricing-strategy") — never
entity or brand names. Use the same label for the same topic across atoms;
prefer a label you already used over coining a near-synonym.

Output ONLY the JSON array, no prose.`;

interface DiscoveredPage {
  slug: string;
  content: string;
  contentHash: string;
}

/**
 * v0.41.2.1 (D2) — single-SQL discovery + idempotency filter for brain
 * pages. Discovers extractable pages whose content_hash has no
 * corresponding atom row yet. One round-trip; replaces the
 * 6-listPages + per-candidate atom-existence-check pattern from PR #1414.
 *
 * Fails soft: any executeRaw error is logged to stderr and returns [].
 * The transcript path still proceeds.
 *
 * D9 fixes incorporated:
 *   #1 sourceId threading on putPage — happens at the caller (this
 *      function returns DiscoveredPage; caller does the writes).
 *   #3 content_hash IS NOT NULL filter — pages without a hash can't
 *      participate in the NOT EXISTS check anyway.
 *   #4 dream_generated exclusion — prevents the phase from chewing
 *      its own output (e.g. dream-generated originals).
 *   #5 raw source-holder exclusion — source pages that only point at a raw
 *      import payload are not extractable prose; counting them creates a
 *      permanent backlog/no-progress loop (see
 *      RAW_SOURCE_HOLDER_EXCLUSION_SQL).
 *   #6 broad catch-all/archive types (`note`, `conversation`) require an
 *      explicit `atom_extract: true`; explicit false denies every type.
 */
export async function discoverExtractablePages(
  engine: BrainEngine,
  sourceId: string,
  affectedSlugs?: string[],
  limit: number = PAGE_DISCOVERY_BUDGET,
): Promise<DiscoveredPage[]> {
  const optInPolicySql = await resolveAtomOptInPolicySql(engine);
  const hasFilter = Array.isArray(affectedSlugs) && affectedSlugs.length > 0;
  const sql = `
    SELECT p.slug,
           p.compiled_truth,
           p.content_hash
    FROM pages p
    WHERE p.source_id = $1
      AND p.type = ANY($2::text[])
      AND p.deleted_at IS NULL
      AND p.content_hash IS NOT NULL
      AND COALESCE(p.frontmatter->>'imported_from',   '') <> 'markdown-greenfield'
      AND COALESCE(p.frontmatter->>'dream_generated', '') <> 'true'
      ${RAW_SOURCE_HOLDER_EXCLUSION_SQL}
      ${optInPolicySql}
      AND length(COALESCE(p.compiled_truth, '')) >= $3
      AND COALESCE(p.frontmatter->>'atoms_scan_hash', '') <> substring(p.content_hash from 1 for 16)
      ${hasFilter ? "AND p.slug = ANY($5::text[])" : ''}
      AND NOT EXISTS (
        SELECT 1
        FROM pages atom
        WHERE atom.type = 'atom'
          AND atom.source_id = $1
          AND atom.frontmatter->>'source_hash' = substring(p.content_hash from 1 for 16)
          AND atom.deleted_at IS NULL
      )
    ORDER BY p.updated_at DESC
    LIMIT $4
  `;
  const params: unknown[] = [
    sourceId,
    await resolveExtractableTypes(),
    MIN_PAGE_CHARS_FOR_EXTRACTION,
    limit,
  ];
  if (hasFilter) params.push(affectedSlugs);

  try {
    const rows = await engine.executeRaw<{
      slug: string;
      compiled_truth: string;
      content_hash: string;
    }>(sql, params);
    return rows.map((r) => ({
      slug: r.slug,
      content: r.compiled_truth,
      contentHash: r.content_hash,
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[extract_atoms] page-discovery query failed: ${msg}`);
    return []; // fail-soft: transcript path still proceeds
  }
}

/**
 * issue #1678 (C4) — count DB pages eligible for atom extraction that have NO
 * atom row yet. Single source of truth for the backlog number: the doctor
 * `extract_atoms_backlog` check calls this so its definition can't drift from
 * what the phase actually processes. Uses the SAME eligibility predicate as
 * `discoverExtractablePages` (minus the LIMIT and affectedSlugs filter) so it
 * rides migration v104's `pages_atom_source_hash_idx` partial index and stays
 * O(log n) on 100K+ brains.
 *
 * PAGE-BACKLOG-ONLY (Codex #11): extract_atoms also discovers transcript files
 * at runtime; this count covers DB pages only. Callers label that caveat.
 *
 * Fail-soft: returns null on error so the doctor check can report a warn
 * (query failed) rather than a misleading 0.
 */
export async function countExtractAtomsBacklog(
  engine: BrainEngine,
  sourceId?: string,
): Promise<number | null> {
  const optInPolicySql = await resolveAtomOptInPolicySql(engine);
  try {
    // Two modes: scoped (the phase's per-source `remaining`) vs brain-wide
    // (doctor — matches the conversation-facts check's cross-source posture).
    // The atom must live in the SAME source as the page either way, so the
    // brain-wide form keys the NOT EXISTS on `atom.source_id = p.source_id`.
    const scoped = sourceId !== undefined;
    const sql = scoped
      ? `SELECT COUNT(*) AS cnt FROM pages p
         WHERE p.source_id = $1
           AND p.type = ANY($2::text[])
           AND p.deleted_at IS NULL
           AND p.content_hash IS NOT NULL
           AND COALESCE(p.frontmatter->>'imported_from',   '') <> 'markdown-greenfield'
           AND COALESCE(p.frontmatter->>'dream_generated', '') <> 'true'
           ${RAW_SOURCE_HOLDER_EXCLUSION_SQL}
           ${optInPolicySql}
           AND length(COALESCE(p.compiled_truth, '')) >= $3
           AND COALESCE(p.frontmatter->>'atoms_scan_hash', '') <> substring(p.content_hash from 1 for 16)
           AND NOT EXISTS (
             SELECT 1 FROM pages atom
             WHERE atom.type = 'atom' AND atom.source_id = $1
               AND atom.frontmatter->>'source_hash' = substring(p.content_hash from 1 for 16)
               AND atom.deleted_at IS NULL
           )`
      : `SELECT COUNT(*) AS cnt FROM pages p
         WHERE p.type = ANY($1::text[])
           AND p.deleted_at IS NULL
           AND p.content_hash IS NOT NULL
           AND COALESCE(p.frontmatter->>'imported_from',   '') <> 'markdown-greenfield'
           AND COALESCE(p.frontmatter->>'dream_generated', '') <> 'true'
           ${RAW_SOURCE_HOLDER_EXCLUSION_SQL}
           ${optInPolicySql}
           AND length(COALESCE(p.compiled_truth, '')) >= $2
           AND COALESCE(p.frontmatter->>'atoms_scan_hash', '') <> substring(p.content_hash from 1 for 16)
           AND NOT EXISTS (
             SELECT 1 FROM pages atom
             WHERE atom.type = 'atom' AND atom.source_id = p.source_id
               AND atom.frontmatter->>'source_hash' = substring(p.content_hash from 1 for 16)
               AND atom.deleted_at IS NULL
           )`;
    const extractableTypes = await resolveExtractableTypes();
    const params = scoped
      ? [sourceId, extractableTypes, MIN_PAGE_CHARS_FOR_EXTRACTION]
      : [extractableTypes, MIN_PAGE_CHARS_FOR_EXTRACTION];
    const rows = await engine.executeRaw<{ cnt: string | number }>(sql, params);
    return Number(rows[0]?.cnt ?? 0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[extract_atoms] backlog count failed: ${msg}`);
    return null;
  }
}

async function resolvePageDiscoveryLimit(engine: BrainEngine): Promise<number> {
  try {
    const configured = await engine.getConfig('cycle.extract_atoms.page_discovery_budget');
    if (configured) {
      const n = Number(configured);
      // Ceiling: discovery selects full compiled_truth bodies per row, so an
      // oversized budget materializes that many pages in one result set.
      if (Number.isFinite(n) && n > 0) return Math.min(Math.floor(n), 10_000);
    }
  } catch { /* keep default */ }
  return PAGE_DISCOVERY_BUDGET;
}

/**
 * Batch source-hash idempotency check. Returns the set of contentHash16
 * values that already have an atom row for this source. One SQL
 * roundtrip; migration v104 adds the partial expression index that
 * keeps this O(log n) on big brains.
 *
 * Replaces the prior per-hash helper (`atomsExistForHash`) — for ~7K
 * conversation transcripts the per-hash loop was 7K round trips before
 * extraction began (~5-10 min of pure overhead on a 322K-page brain).
 *
 * Empty input short-circuits without a query. Fail-open on error so
 * extraction proceeds (same posture as the prior per-hash helper).
 *
 * Exported so the unit test can drive it directly without orchestrating
 * the full phase.
 */
export async function atomsExistingForHashes(
  engine: BrainEngine,
  sourceId: string,
  contentHash16s: string[],
): Promise<Set<string>> {
  if (contentHash16s.length === 0) return new Set();
  try {
    const rows = await engine.executeRaw<{ h: string }>(
      `SELECT frontmatter->>'source_hash' AS h
         FROM pages
        WHERE type = 'atom'
          AND source_id = $1
          AND deleted_at IS NULL
          AND frontmatter->>'source_hash' = ANY($2::text[])`,
      [sourceId, contentHash16s],
    );
    return new Set(rows.map(r => r.h));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[extract_atoms] batch idempotency check failed (assuming none extracted): ${msg}`);
    return new Set();
  }
}

async function runSemanticValidatorBounded(
  validator: AtomSemanticValidator,
  input: Parameters<AtomSemanticValidator>[0],
  timeoutMs: number,
): Promise<AtomSemanticBatchResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      validator(input),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AtomSemanticValidationError('timeout')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The exact two-step model resolution `runPhaseExtractAtoms` uses:
 * `models.dream.extract_atoms` DB config wins if set (same plain-`||`
 * truthiness as always — a whitespace-only value IS "configured"), else the
 * key-aware `resolveTierDefault('utility')`. Deliberately NOT
 * `resolveModel()`'s fuller chain (which also honors `models.tier.utility`,
 * `models.default`, and an env var) — extract_atoms has never read those, and
 * unifying the two behaviors is a separate, larger change. Exported so
 * `gbrain models` can report the actual routing instead of a generic chain
 * that can diverge from it in partially-configured installs; `source` comes
 * from the SAME call as `model` so the report's attribution can never
 * disagree with the resolved value. Fail-soft: a throwing config read routes
 * to the tier default (the same end state runPhaseExtractAtoms's config-read
 * try/catch has always produced).
 */
export async function resolveExtractAtomsModelWithSource(
  engine: BrainEngine,
): Promise<{ model: string; source: 'config' | 'tier_default' }> {
  let configuredModel: string | null = null;
  try {
    configuredModel = await engine.getConfig('models.dream.extract_atoms');
  } catch {
    // Fail-soft — fall through to the tier default.
  }
  return configuredModel
    ? { model: configuredModel, source: 'config' }
    : { model: resolveTierDefault('utility'), source: 'tier_default' };
}

/** String-returning wrapper for runtime callers (`runPhaseExtractAtoms`). */
export async function resolveExtractAtomsModel(engine: BrainEngine): Promise<string> {
  return (await resolveExtractAtomsModelWithSource(engine)).model;
}

/**
 * v0.41 minimal extract_atoms body, rebuilt for v0.41.2.1.
 *
 * Test-driven minimum: takes _transcripts AND _pages directly when set,
 * skipping filesystem + DB discovery. Production path uses
 * discoverTranscripts + discoverExtractablePages (both lazy-imported
 * to avoid circular module loads and to keep PGLite-only tests fast).
 */
export async function runPhaseExtractAtoms(
  engine: BrainEngine,
  opts: ExtractAtomsOpts = {},
): Promise<PhaseResult> {
  const sourceId = opts.sourceId ?? 'default';
  const chat = opts._chat ?? gatewayChat;

  // 1a. Get transcripts (test seam OR production discovery).
  //     v0.41.2.1: config loader switched to loadConfigWithEngine() so the
  //     dream.* DB-plane merge from Phase 1 reaches this phase.
  let transcripts: Array<{ filePath: string; content: string; contentHash: string }> = opts._transcripts ?? [];
  let transcriptDiscoveryFailed = false;
  // Configured transcript corpus paths are brain-global, so only default discovers them.
  if (
    sourceId === 'default'
    && transcripts.length === 0
    && opts.brainDir !== undefined
    && opts._transcripts === undefined
  ) {
    try {
      const { discoverTranscripts } = await import('./transcript-discovery.ts');
      const { loadConfigWithEngine } = await import('../config.ts');
      const cfgRaw = opts._loadConfig
        ? await opts._loadConfig()
        : await loadConfigWithEngine(engine);
      const cfg = (cfgRaw ?? {}) as unknown as Record<string, unknown>;
      const dream = cfg.dream as
        | { synthesize?: { session_corpus_dir?: string; meeting_transcripts_dir?: string } }
        | undefined;
      const corpusDir = dream?.synthesize?.session_corpus_dir;
      const meetingDir = dream?.synthesize?.meeting_transcripts_dir;
      if (corpusDir !== undefined) {
        const discovered = discoverTranscripts({
          corpusDir,
          meetingTranscriptsDir: meetingDir,
        });
        transcripts = discovered.map((d) => ({
          filePath: d.filePath,
          content: d.content,
          contentHash: d.contentHash,
        }));
      }
    } catch {
      // No transcripts available — phase no-ops cleanly.
      transcriptDiscoveryFailed = true;
    }
  }

  // 1b. Get pages (test seam OR production discovery).
  //     _pages === undefined triggers discovery; _pages: [] suppresses it
  //     deliberately (transcript-only regression tests).
  let pages: Array<{ slug: string; content: string; contentHash: string }>;
  if (opts._pages !== undefined) {
    pages = opts._pages;
  } else {
    pages = await discoverExtractablePages(
      engine,
      sourceId,
      opts.affectedSlugs,
      await resolvePageDiscoveryLimit(engine),
    );
  }

  // 2. Apply transcript-side source-hash idempotency in ONE batch query
  //    instead of N per-hash round trips. Page-side idempotency lives in
  //    the discovery SQL's NOT EXISTS subquery (already batched).
  const transcriptsLive: typeof transcripts = [];
  let duplicatesSkipped = 0;
  const allHashes16 = transcripts.map(t => t.contentHash.slice(0, 16));
  // Surface a heartbeat before the batch query so even an instant
  // short-circuit shows a sign of life (closes Issue 2 silent-phase pain).
  opts.progress?.heartbeat(`checking existing atoms for ${allHashes16.length} transcripts`);
  const existingHashes = await atomsExistingForHashes(engine, sourceId, allHashes16);
  for (const t of transcripts) {
    if (existingHashes.has(t.contentHash.slice(0, 16))) {
      duplicatesSkipped++;
      continue;
    }
    transcriptsLive.push(t);
  }

  // 3. Dual-source merge: transcripts + pages, dedup by contentHash.
  //    Transcripts win on COLLISION (origin attribution stays with the raw
  //    transcript file even if the same content was later imported as a
  //    brain page) — that's decided by the two loops below, which register
  //    every transcript hash into `seenHashes` before any page is checked,
  //    same as before this fix. It's independent of the FINAL work-item
  //    ORDER built after them.
  //
  //    Order is page-item-first, interleaved 1-for-1 with transcripts (NOT
  //    concatenated transcripts-then-pages). The per-call budget cap (step
  //    4 below) stops processing `work` in list order once
  //    budgetTracker.totalSpent >= budgetCap, skipping everything after
  //    that point. Two failure modes this avoids:
  //      - Concatenation (old code): a transcript corpus that alone
  //        exceeds the budget cap starves the page pool completely, no
  //        matter how many drain batches run.
  //      - Interleaving with transcripts first: still starves ALL pages
  //        whenever the budget only covers exactly one call (item 0 is a
  //        transcript, item 1 — the first page — never gets attempted).
  //    Pages are the ONLY pool `countExtractAtomsBacklog`/doctor's
  //    extract_atoms_backlog check measures (see that function's
  //    docstring), so page-first guarantees the doctor-visible backlog
  //    makes forward progress on every budget-capped call, however tight
  //    the cap — `--drain` can no longer report the same backlog number
  //    forever while atoms keep getting extracted from transcripts.
  type WorkItem =
    | { kind: 'transcript'; filePath: string; content: string; contentHash: string }
    | { kind: 'page'; slug: string; content: string; contentHash: string };

  const seenHashes = new Set<string>();
  const transcriptItems: WorkItem[] = [];
  for (const t of transcriptsLive) {
    if (seenHashes.has(t.contentHash)) { duplicatesSkipped++; continue; }
    seenHashes.add(t.contentHash);
    transcriptItems.push({ kind: 'transcript', ...t });
  }
  const pageItems: WorkItem[] = [];
  for (const p of pages) {
    if (seenHashes.has(p.contentHash)) { duplicatesSkipped++; continue; }
    seenHashes.add(p.contentHash);
    pageItems.push({ kind: 'page', ...p });
  }
  const work: WorkItem[] = [];
  const maxPoolLen = Math.max(transcriptItems.length, pageItems.length);
  for (let i = 0; i < maxPoolLen; i++) {
    if (i < pageItems.length) work.push(pageItems[i]);
    if (i < transcriptItems.length) work.push(transcriptItems[i]);
  }
  const boundedWork = opts.dryRun ? work.slice(0, MAX_DRY_RUN_WORK_ITEMS) : work;
  const dryRunOmittedItems = work.length - boundedWork.length;

  // Phase-level no-op: nothing to extract today.
  if (work.length === 0 && transcripts.length === 0 && pages.length === 0) {
    // A successful full-source empty scan is a current completion, not a new
    // historical extraction round. Publish only extract_health_state so stale
    // migration-seeded unknown/halt rows can recover without diluting the
    // immutable seven-day rollup. Targeted/test-seam empties prove nothing
    // about the rest of the source and must not update current health.
    const fullSourceScan =
      opts._pages === undefined
      && (!Array.isArray(opts.affectedSlugs) || opts.affectedSlugs.length === 0);
    let currentStateError: string | null = null;
    let currentStateWritten = false;
    if (!opts.dryRun && fullSourceScan) {
      if (transcriptDiscoveryFailed) {
        currentStateError = 'transcript_discovery_failed';
      } else {
        const pageBacklog = await countExtractAtomsBacklog(engine, sourceId);
        if (pageBacklog === null) {
          currentStateError = 'page_backlog_unavailable';
        } else if (pageBacklog === 0) {
          const state = await updateExtractHealthState(engine, {
            kind: 'atoms',
            source_id: sourceId,
            outcome: 'completed',
          });
          currentStateWritten = state.ok;
          if (!state.ok) currentStateError = 'current_state_write_failed';
        } else {
          currentStateError = 'discovery_backlog_mismatch';
        }
      }
    }
    return {
      phase: 'extract_atoms',
      status: currentStateError ? 'warn' : 'skipped',
      duration_ms: 0,
      summary: currentStateError
        ? `extract_atoms: empty scan could not publish current health (${currentStateError})`
        : 'extract_atoms: no transcripts or pages to process',
      details: {
        reason: currentStateError ?? 'no_work',
        source_id: sourceId,
        current_state_written: currentStateWritten,
        atoms_extracted: 0,
        transcripts_processed: 0,
        transcripts_total: 0,
        transcripts_skipped_budget: 0,
        pages_processed: 0,
        pages_total: 0,
        duplicates_skipped: 0,
        candidates: 0,
        accepted: 0,
        rejected: 0,
        rejected_by_reason: {},
        failures: [],
        estimated_spend_usd: 0,
        budget_usd: DEFAULT_BUDGET_USD,
        dry_run: opts.dryRun ?? false,
        dry_run_limit: opts.dryRun ? MAX_DRY_RUN_WORK_ITEMS : null,
        dry_run_omitted_items: 0,
        actual_models: { extraction: [], semantic_validator: [] },
        actual_routes: { extraction: [], semantic_validator: [] },
      },
    };
  }

  // 4. Per work-item: extract atoms via the configured extract_atoms model
  let totalAtomsExtracted = 0;
  let transcriptsProcessed = 0;
  let pagesProcessed = 0;
  let transcriptsSkipped = 0;
  let pagesSkipped = 0;
  const failures: Array<{ source: string; error: string }> = [];
  let candidatesCount = 0;
  let acceptedCount = 0;
  let rejectedCount = 0;
  const rejectedByReason: Record<string, number> = {};
  const extractionActualModels = new Set<string>();
  const extractionActualRoutes = new Set<string>();
  const validatorActualModels = new Set<string>();
  const validatorActualRoutes = new Set<string>();
  let estimatedSpendUsd = 0;
  let budgetExhausted = false;
  // #3813: key-aware tier default, not a hardcoded Anthropic model — an
  // OPENAI_API_KEY-only install must not route to an unservable provider.
  // Pre-computed so a config-read failure inside the try below (caught, see
  // "Keep safe defaults" comment) still leaves extractModel on this default,
  // matching the pre-refactor fail-soft behavior exactly.
  let extractModel = resolveTierDefault('utility');
  let validatorModel = DEFAULT_ATOM_VALIDATOR_MODEL;
  let budgetCap = DEFAULT_BUDGET_USD;
  let sensitivePatternConfig = parseConfiguredSensitivePatterns(null);
  // #4529/#4540: the per-item input/output caps were hardcoded (slice(0, 50_000) +
  // maxTokens: 4096). Operators on small-context or thinking models need to
  // shrink/grow both without a code change; defaults are unchanged.
  let maxInputChars = DEFAULT_EXTRACT_MAX_INPUT_CHARS;
  let maxOutputTokens = DEFAULT_EXTRACT_MAX_OUTPUT_TOKENS;
  let pacingMs = 0;
  try {
    extractModel = await resolveExtractAtomsModel(engine);
    const configuredValidatorModel = await engine.getConfig('models.dream.extract_atoms_validator');
    if (configuredValidatorModel) validatorModel = configuredValidatorModel;
    sensitivePatternConfig = parseConfiguredSensitivePatterns(
      await engine.getConfig('cycle.extract_atoms.sensitive_patterns'),
    );
    const configuredBudget = await engine.getConfig('cycle.extract_atoms.budget_usd');
    if (configuredBudget) {
      const n = Number(configuredBudget);
      if (Number.isFinite(n) && n > 0) budgetCap = n;
    }
    // #4529: legacy input-cap key (its own floor of 500 chars, as landed).
    // Read FIRST so the newer #4540 max_input_chars key below wins when
    // both are set — they name the same knob.
    const configuredMaxSourceChars = await engine.getConfig('cycle.extract_atoms.max_source_chars');
    if (configuredMaxSourceChars) {
      const n = Number(configuredMaxSourceChars);
      if (Number.isFinite(n) && n >= 500) maxInputChars = Math.floor(n);
    }
    const configuredMaxInput = await engine.getConfig('cycle.extract_atoms.max_input_chars');
    if (configuredMaxInput) {
      const n = Number(configuredMaxInput);
      // Floor of 1000 chars: below that the extractor sees a fragment too
      // small to yield atoms and every page burns budget for nothing.
      if (Number.isFinite(n) && n >= 1_000) maxInputChars = Math.floor(n);
    }
    const configuredMaxOutput = await engine.getConfig('cycle.extract_atoms.max_output_tokens');
    if (configuredMaxOutput) {
      const n = Number(configuredMaxOutput);
      // Floor of 256 tokens mirrors dream.triage.max_tokens: a smaller cap
      // truncates every response into the malformed-output failure path.
      if (Number.isFinite(n) && n >= 256) maxOutputTokens = Math.floor(n);
    }
    // Optional per-item pacing sleep (ms) so a large backlog doesn't hammer
    // a local/self-hosted provider back-to-back. 0 (default) = no pacing.
    const configuredPacing = await engine.getConfig('cycle.extract_atoms.pacing_ms');
    if (configuredPacing) {
      const n = Number(configuredPacing);
      if (Number.isFinite(n) && n > 0) pacingMs = Math.min(60_000, Math.floor(n));
    }
  } catch {
    // Keep safe defaults on any config-read failure: key-aware utility-tier
    // model, $0.30 cap, default input cap (max_input_chars).
  }
  let activeExtractModel = extractModel;
  let fallbackLatchedModel: string | null = null;
  // A cost cap is only meaningful when BOTH calls the tracker covers can be
  // priced. #4312 operator overrides are part of that decision and are also
  // passed into the tracker for reserve/record calculations.
  // BudgetTracker.reserve() hard-fails with BudgetExhausted(reason:'no_pricing')
  // when either model is absent from pricing AND a cap is set; with no cap it
  // warns once and proceeds.
  const budgetPricing = await resolveExtractAtomsBudgetPricingPolicy(
    engine,
    extractModel,
    validatorModel,
  );
  if (!budgetPricing.enforceCostCap) {
    console.error(
      `[extract_atoms] model(s) ${budgetPricing.unpricedModels.map((m) => `"${m}"`).join(', ')} ` +
        `are not in the pricing maps; ` +
        `running without a cost gate (a cap cannot be enforced on an unpriced model).`,
    );
  }
  const budgetTracker = new BudgetTracker({
    maxCostUsd: budgetPricing.enforceCostCap ? budgetCap : undefined,
    label: 'cycle.extract_atoms',
    pricingOverrides: budgetPricing.pricingOverrides,
  });
  const semanticTimeoutMs = opts._semanticTimeoutMs ?? DEFAULT_ATOM_VALIDATOR_TIMEOUT_MS;
  const injectedChatPassThrough: AtomSemanticValidator | undefined = opts._chat && !opts._semanticValidator
    ? async ({ candidates }) => ({
        verdicts: candidates.map((_, index) => ({
          index,
          scores: {
            source_support: 1,
            exactly_one_claim: 1,
            self_contained: 1,
            no_hidden_causation_or_overgeneralization: 1,
            no_sensitive_content: 1,
          },
        })),
        actualModel: 'test:injected-chat',
        route: 'test',
      })
    : undefined;
  const semanticValidator = opts._semanticValidator ?? injectedChatPassThrough
    ?? createGatewayAtomSemanticValidator({ chat, model: validatorModel, timeoutMs: semanticTimeoutMs });
  const rejectCandidate = (reasons: readonly string[]): void => {
    rejectedCount++;
    for (const reason of reasons) rejectedByReason[reason] = (rejectedByReason[reason] ?? 0) + 1;
  };

  // v0.41.19.0 (T3): throttled yield helper. Fires `opts.yieldDuringPhase`
  // every 30s. Cycle.ts threads `buildYieldDuringPhase(lock, outer)` so
  // each fire refreshes the cycle DB lock. Combined with TTL=5min: a
  // healthy long phase keeps the lock alive (10× refresh budget before
  // TTL expires); a crash releases the lock within 5min instead of 30.
  //
  // Called both inside the work loop (cheap iterations) AND immediately
  // after every `await chat()` (long LLM await is the main TTL hazard
  // codex flagged).
  let lastYieldMs = Date.now();
  async function maybeYield(): Promise<void> {
    if (!opts.yieldDuringPhase) return;
    const now = Date.now();
    if (now - lastYieldMs < 30_000) return;
    lastYieldMs = now;
    try {
      await opts.yieldDuringPhase();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[extract_atoms] yieldDuringPhase failed (non-fatal): ${msg}`);
    }
  }

  // ── gbrain#4148 helpers ────────────────────────────────────────────
  let malformedOutputs = 0;
  const tombstonedForFailures: string[] = [];
  const tombstonedForQualityRejections: string[] = [];
  // #3044 adoption: shared halt policy — auth/billing halt on the first hit,
  // a rate_limit streak halts after 3 consecutive failures, a successful
  // chat call resets the streak.
  const llmHalt = createGlobalLlmHaltTracker();
  let abortedGlobalError: GlobalLlmErrorClass | null = null;
  // Rollup/doctor-health signal only. `failures` (below) stays inclusive of
  // transient entries for CLI/receipt reporting; this counts everything
  // EXCEPT the ones TRANSIENT_EXTRACT_ERROR_RE + the rate_limit abort class
  // say are "retryable, never counted" — see that regex's doc comment.
  let hardFailureCount = 0;

  /** Stamp the zero-yield/complete tombstone (hash-keyed; edits re-eligibilize). */
  async function stampAtomsScanHash(item: { slug: string; contentHash: string }): Promise<void> {
    try {
      await engine.executeRaw(
        `UPDATE pages
            SET frontmatter = frontmatter || jsonb_build_object('atoms_scan_hash', $1::text)
          WHERE source_id = $2 AND slug = $3 AND deleted_at IS NULL`,
        [item.contentHash.slice(0, 16), sourceId, item.slug],
      );
    } catch { /* fail-soft: page stays rediscoverable */ }
  }

  /**
   * Durable per-item failure count, keyed to the CURRENT content hash so a
   * content edit resets the streak. Returns the new consecutive count, or
   * null for transcripts / on write failure (never blocks the phase).
   */
  async function recordPageFailureCount(item: { kind: string; slug?: string; contentHash: string }): Promise<number | null> {
    if (item.kind !== 'page' || !item.slug || opts.dryRun) return null;
    try {
      const rows = await engine.executeRaw<{ cnt: number | string }>(
        `UPDATE pages
            SET frontmatter = frontmatter
              || jsonb_build_object('atoms_fail_hash', $1::text)
              || jsonb_build_object('atoms_fail_count',
                   CASE WHEN COALESCE(frontmatter->>'atoms_fail_hash', '') = $1::text
                        THEN COALESCE((frontmatter->>'atoms_fail_count')::int, 0) + 1
                        ELSE 1 END)
          WHERE source_id = $2 AND slug = $3 AND deleted_at IS NULL
          RETURNING (frontmatter->>'atoms_fail_count')::int AS cnt`,
        [item.contentHash.slice(0, 16), sourceId, item.slug],
      );
      const cnt = rows[0]?.cnt;
      return cnt == null ? null : Number(cnt);
    } catch {
      return null;
    }
  }

  /**
   * Count a completed extraction whose candidates all failed deterministic or
   * semantic QUALITY gates. This is deliberately separate from malformed
   * output and provider/validator operational failures: quality rejects get
   * bounded retries on unchanged content, while operational failures remain
   * retryable. Only stable aggregate reason codes are persisted.
   */
  async function recordPageQualityRejectionCount(
    item: { kind: string; slug?: string; contentHash: string },
    reasons: Record<string, number>,
  ): Promise<number | null> {
    if (item.kind !== 'page' || !item.slug || opts.dryRun) return null;
    try {
      const rows = await engine.executeRaw<{ cnt: number | string }>(
        `UPDATE pages
            SET frontmatter = frontmatter
              || jsonb_build_object('atoms_reject_hash', $1::text)
              || jsonb_build_object('atoms_reject_count',
                   CASE WHEN COALESCE(frontmatter->>'atoms_reject_hash', '') = $1::text
                        THEN COALESCE((frontmatter->>'atoms_reject_count')::int, 0) + 1
                        ELSE 1 END)
              || jsonb_build_object('atoms_reject_last_reasons', $4::text::jsonb)
          WHERE source_id = $2 AND slug = $3 AND deleted_at IS NULL
          RETURNING (frontmatter->>'atoms_reject_count')::int AS cnt`,
        [item.contentHash.slice(0, 16), sourceId, item.slug, JSON.stringify(reasons)],
      );
      const cnt = rows[0]?.cnt;
      return cnt == null ? null : Number(cnt);
    } catch {
      return null;
    }
  }

  await withBudgetTracker(budgetTracker, async () => {
  for (const item of boundedWork) {
    await maybeYield();
    if (budgetExhausted || budgetTracker.totalSpent >= budgetCap) {
      if (item.kind === 'transcript') transcriptsSkipped++;
      else pagesSkipped++;
      continue;
    }

    const originLabel = item.kind === 'transcript' ? item.filePath : item.slug;
    const itemRejectedByReason: Record<string, number> = {};
    let itemGateOperationalFailure = false;
    try {
      const result = await chat({
        model: activeExtractModel,
        system: EXTRACT_PROMPT,
        messages: [
          {
            role: 'user',
            // #4529/#4540: configurable input cap, cut UTF-8-safely (a bare
            // .slice() can split a surrogate pair at the boundary).
            content: `Source: ${originLabel}\n\n---\n\n${truncateUtf8(item.content, maxInputChars)}`,
          },
        ],
        maxTokens: maxOutputTokens,
      });
      // The gateway reports the canonical requested model unless a fallback
      // answered. Keep that operationally healthy route for this batch only.
      if (result.model !== activeExtractModel) {
        activeExtractModel = result.model;
        fallbackLatchedModel = result.model;
      }
      extractionActualModels.add(result.model);
      extractionActualRoutes.add(result.providerId);
      // Post-await yield: closes the "long LLM call past TTL" hazard
      // codex flagged. The 30s throttle inside maybeYield bounds the
      // actual refresh rate so this is cheap when calls are fast.
      await maybeYield();
      llmHalt.reset();
      // #4540: optional per-item pacing between successful LLM calls.
      // setTimeout (not setImmediate) so the lock-refresh interval fires.
      if (pacingMs > 0) await new Promise<void>((r) => setTimeout(r, pacingMs));

      estimatedSpendUsd = budgetTracker.totalSpent;

      // gbrain#4148: typed outcome — malformed output is a FAILURE (counted
      // toward the bounded tombstone below), never a zero-yield success.
      const parseOutcome = parseAtomsOutcome(result.text, item.content);
      if (!parseOutcome.ok) {
        malformedOutputs++;
        hardFailureCount++;
        const failCount = await recordPageFailureCount(item);
        failures.push({
          source: originLabel,
          error: `malformed model output: ${parseOutcome.reason}` +
            (failCount != null ? ` (consecutive failure ${failCount} on this content)` : ''),
        });
        // Content-deterministic class: the same prose reliably produces
        // unparseable output. After N consecutive failures on the SAME
        // content hash, tombstone so the backlog floor clears; a content
        // edit re-eligibilizes (stamp is hash-keyed). Transient provider
        // errors never reach here — they throw and take the catch path.
        if (failCount != null && failCount >= MAX_DETERMINISTIC_FAILURES && !opts.dryRun && item.kind === 'page') {
          await stampAtomsScanHash(item);
          tombstonedForFailures.push(item.slug);
        }
        continue;
      }
      const atoms = parseOutcome.atoms;
      candidatesCount += atoms.length;
      if (atoms.length === 0) {
        // #2144: tombstone zero-yield pages so they stop being rediscovered.
        // Idempotency is keyed on atom rows — a page that yields no atoms
        // leaves no row, so pre-fix it re-entered the discovery window every
        // run (wedging --drain with a false no_progress and re-spending
        // nightly budget on the same pages). Stamp the content hash we
        // scanned; discovery skips the page only while its content is
        // unchanged (edits re-eligibilize, mirroring atom-row staleness).
        // Only stamped after a SUCCESSFUL chat call — LLM failures take the
        // catch path below and stay retryable, and malformed output is
        // counted above (gbrain#4148), never stamped as success.
        if (!opts.dryRun && item.kind === 'page') {
          await stampAtomsScanHash(item);
        }
        if (item.kind === 'transcript') transcriptsProcessed++;
        else pagesProcessed++;
        continue;
      }

      const deterministicSurvivors: ExtractedAtom[] = [];
      if (sensitivePatternConfig.invalid) {
        itemGateOperationalFailure = true;
        for (const _atom of atoms) {
          rejectCandidate(['sensitive_pattern_config_invalid']);
          itemRejectedByReason.sensitive_pattern_config_invalid =
            (itemRejectedByReason.sensitive_pattern_config_invalid ?? 0) + 1;
        }
      } else {
        for (const atom of atoms) {
          const reasons = scanAtomCandidate(atom, sensitivePatternConfig.patterns);
          if (reasons.length > 0) {
            rejectCandidate(reasons);
            for (const reason of reasons) {
              itemRejectedByReason[reason] = (itemRejectedByReason[reason] ?? 0) + 1;
            }
          }
          else deterministicSurvivors.push(atom);
        }
      }

      const acceptedAtoms: ExtractedAtom[] = [];
      if (deterministicSurvivors.length > 0) {
        try {
          const semanticResult = await runSemanticValidatorBounded(
            semanticValidator,
            { sourceText: item.content, candidates: deterministicSurvivors },
            semanticTimeoutMs,
          );
          const verdicts = parseAtomSemanticResponse(
            JSON.stringify({ verdicts: semanticResult.verdicts }),
            deterministicSurvivors.length,
          );
          if (semanticResult.actualModel) validatorActualModels.add(semanticResult.actualModel);
          if (semanticResult.route) validatorActualRoutes.add(semanticResult.route);
          for (let i = 0; i < deterministicSurvivors.length; i++) {
            const reasons = semanticRejectionReasons(verdicts[i].scores);
            if (reasons.length > 0) {
              rejectCandidate(reasons);
              for (const reason of reasons) {
                itemRejectedByReason[reason] = (itemRejectedByReason[reason] ?? 0) + 1;
              }
            }
            else {
              acceptedAtoms.push(deterministicSurvivors[i]);
              acceptedCount++;
            }
          }
        } catch (err) {
          if (err instanceof BudgetExhausted) throw err;
          itemGateOperationalFailure = true;
          const code = err instanceof AtomSemanticValidationError ? err.code : 'validator_failure';
          const reason = code === 'invalid_json'
            ? 'semantic_validator_invalid_json'
            : code === 'timeout'
              ? 'semantic_validator_timeout'
              : 'semantic_validator_failure';
          for (const _atom of deterministicSurvivors) {
            rejectCandidate([reason]);
            itemRejectedByReason[reason] = (itemRejectedByReason[reason] ?? 0) + 1;
          }
          failures.push({ source: 'semantic_validator', error: reason });
        }
      }

      if (acceptedAtoms.length === 0) {
        // Candidates that all failed QUALITY gates get a bounded retry
        // allowance. Validator/config operational failures are never charged.
        if (
          atoms.length > 0 &&
          !itemGateOperationalFailure &&
          !opts.dryRun &&
          item.kind === 'page'
        ) {
          const rejectCount = await recordPageQualityRejectionCount(item, itemRejectedByReason);
          if (rejectCount != null && rejectCount >= MAX_DETERMINISTIC_FAILURES) {
            await stampAtomsScanHash(item);
            tombstonedForQualityRejections.push(item.slug);
          }
        }
        if (item.kind === 'transcript') transcriptsProcessed++;
        else pagesProcessed++;
        opts.progress?.tick(1, `${totalAtomsExtracted} atoms / ${duplicatesSkipped} skipped`);
        continue;
      }

      if (!opts.dryRun) {
        // gbrain#4148 completion receipt: atoms import with a PROVISIONAL
        // source_hash (`pending:<hash>`) that discovery's NOT-EXISTS check
        // can never match, then ONE flip UPDATE marks the whole item done
        // after every atom persisted. Pre-fix, atom writes were per-atom
        // while discovery treated any matching source_hash as complete — if
        // atom 1 persisted and atom 2 failed, the next run skipped the item
        // and atom 2 was permanently lost. On partial failure the pending
        // rows stay invisible to doneness, the item re-runs, and the
        // deterministic slugs upsert instead of duplicating.
        const hash16 = item.contentHash.slice(0, 16);
        const importedSlugs: string[] = [];
        // #3961: provenance edges source-page → atom, accumulated during the
        // atom loop and flushed AFTER the completion-receipt flip so a
        // partially-failed item never banks edges for atoms whose receipt
        // never flipped. Page-kind items only — transcripts are files, not
        // pages, so there is no from-endpoint to link.
        const provenanceLinks: LinkBatchInput[] = [];
        for (const atom of acceptedAtoms) {
          const srcRef = item.kind === 'transcript' ? item.filePath : item.slug;
          const slug = atomSlug(atom.title, srcRef);
          const originFrontmatter =
            item.kind === 'transcript'
              ? { source_path: item.filePath }
              : { source_slug: item.slug };
          // Serialize to markdown and import via the canonical pipeline so
          // the atom is chunked (+ embedded when a provider is configured).
          // engine.putPage is a bare page-row upsert that never chunks, so
          // atoms written through it never reached content_chunks and were
          // invisible to search — the same defect #2163 fixed for concept
          // pages in synthesize-concepts.ts, which was never applied here.
          //
          // `type: 'atom'` rides in frontmatter, which parseMarkdown honours
          // as an explicit override ahead of path inference, so the page type
          // survives the round-trip. sourceId stays threaded (v0.41.2.1 D9 #1)
          // so atoms still land in the source they were discovered from.
          const md = serializeMarkdown(
            {
              atom_type: atom.atom_type,
              ...originFrontmatter,
              // Provisional until the whole item's atoms persist (see above).
              source_hash: `pending:${hash16}`,
              ...(atom.source_quote && { source_quote: atom.source_quote }),
              ...(atom.lesson && { lesson: atom.lesson }),
              ...(atom.concepts && atom.concepts.length > 0 && { concepts: atom.concepts }),
              ...(atom.virality_score !== undefined && { virality_score: atom.virality_score }),
              ...(atom.emotional_register && { emotional_register: atom.emotional_register }),
              extracted_at: new Date().toISOString(),
              extracted_by: 'extract_atoms-v0.41.2.1',
            },
            atom.body,
            '',
            { type: 'atom', title: atom.title, tags: [] },
          );
          await importFromContent(engine, slug, md, {
            sourceId,
            noEmbed: !isAvailable('embedding'),
          });
          importedSlugs.push(slug);
          if (item.kind === 'page') {
            provenanceLinks.push({
              from_slug: item.slug,
              to_slug: slug,
              link_source: 'atom-provenance',
              from_source_id: sourceId,
              to_source_id: sourceId,
            });
          }
          totalAtomsExtracted++;
        }
        // Completion receipt: flip provisional → real in one statement, then
        // stamp the source page. A crash between flip and stamp degrades to
        // the legacy atom-rows-mean-done semantics — safe, not lossy.
        await engine.executeRaw(
          `UPDATE pages
              SET frontmatter = frontmatter || jsonb_build_object('source_hash', $1::text)
            WHERE source_id = $2 AND type = 'atom' AND slug = ANY($3::text[]) AND deleted_at IS NULL`,
          [hash16, sourceId, importedSlugs],
        );
        // #3961: bank the provenance edges so `gbrain backlinks <source-page>`
        // and the graph surface atom lineage. ON CONFLICT-deduped by the
        // batch write, so the deterministic-slug re-run path upserts instead
        // of duplicating. Best-effort: a link failure must not fail the item
        // (the receipt already flipped — atoms are safe) but it logs loudly.
        if (provenanceLinks.length > 0) {
          try {
            await engine.addLinksBatch(provenanceLinks, { auditSite: 'cycle.extract_atoms.provenance' }); // gbrain-allow-direct-insert: atom-provenance edges derived from the extraction itself (no markdown body to reconcile from)
          } catch (linkErr) {
            console.error(
              `[extract_atoms] atom-provenance link batch failed for ${item.kind === 'page' ? item.slug : 'item'}: ` +
              `${(linkErr as Error).message}`,
            );
          }
        }
        if (item.kind === 'page') {
          await stampAtomsScanHash(item);
        }
      } else {
        totalAtomsExtracted += acceptedAtoms.length; // count for dry-run reporting
      }
      if (item.kind === 'transcript') transcriptsProcessed++;
      else pagesProcessed++;
      // v0.41.19.0 (T4): one tick per processed item, with a count note.
      // Reporter rate-limits to ~1 line/sec; safe to tick every iter.
      opts.progress?.tick(1, `${totalAtomsExtracted} atoms / ${duplicatesSkipped} skipped`);
    } catch (err) {
      if (err instanceof BudgetExhausted) {
        budgetExhausted = true;
        if (item.kind === 'transcript') transcriptsSkipped++;
        else pagesSkipped++;
        continue;
      }
      // gbrain#4148: classify. Transient provider/infra errors (timeouts,
      // rate limits, 5xx, network) stay retryable and are NOT counted toward
      // any tombstone. Everything else gets a durable count for
      // observability, but only the malformed-output class (handled above)
      // ever tombstones — an unknown error class must never permanently
      // suppress a page's atoms.
      const message = err instanceof Error ? err.message : String(err);
      // #3044: a whole-run LLM outage halts the phase. No
      // recordPageFailureCount here — a global outage says nothing about the
      // content, so it must not pre-charge the per-page tombstone counter.
      const decision = llmHalt.observe(err);
      if (decision !== 'continue') {
        abortedGlobalError = haltedClassOf(decision);
        if (abortedGlobalError !== 'rate_limit') hardFailureCount++;
        failures.push({
          source: originLabel,
          error: `aborting phase: ${llmHalt.note()} (${message})`,
        });
        break;
      }
      const transient =
        llmHalt.lastClass() === 'rate_limit' || TRANSIENT_EXTRACT_ERROR_RE.test(message);
      if (!transient) {
        await recordPageFailureCount(item);
        hardFailureCount++;
      }
      failures.push({
        source: originLabel,
        error: transient ? `${message} [transient — retried next run]` : message,
      });
    }
  }
  });
  estimatedSpendUsd = budgetTracker.totalSpent;

  // v0.42 Wave B2: write extract receipt + rollup row when the phase
  // actually extracted atoms. Both are best-effort per F-OUT-19 —
  // audit-trail / search-visibility surfaces don't block the phase result.
  if (!opts.dryRun && (totalAtomsExtracted > 0 || candidatesCount > 0)) {
    // receiptSlug keeps the first 8 chars, so entropy must be front-loaded.
    const runId = `${randomUUID().replace(/-/g, '').slice(0, 8)}-atoms-${Date.now().toString(36)}-${sourceId.slice(0, 4)}`;
    const receiptModel = [...validatorActualModels][0] ?? [...extractionActualModels][0];
    const receiptRoute = [...validatorActualRoutes][0] ?? [...extractionActualRoutes][0];
    try {
      await writeReceipt(engine, {
        kind: 'atoms',
        source_id: sourceId,
        run_id: runId,
        round: 'single',
        extracted_at: new Date().toISOString(),
        total_rows: totalAtomsExtracted,
        cost_usd: estimatedSpendUsd,
        ...(receiptModel ? { model_id: receiptModel } : {}),
        ...(receiptRoute ? { model_route: receiptRoute } : {}),
        candidates: candidatesCount,
        accepted: acceptedCount,
        rejected_by_reason: { ...rejectedByReason },
        summary:
          `Extracted ${totalAtomsExtracted} atoms from ` +
          `${transcriptsProcessed} transcripts + ${pagesProcessed} pages.`,
      });
    } catch (err) {
      console.error(`[extract_atoms] receipt write failed: ${(err as Error).message}`);
    }
  }
  if (!opts.dryRun) {
    // gbrain#4148 / TRANSIENT_EXTRACT_ERROR_RE: transient provider/infra
    // failures (rate limits, timeouts, 5xx, network) are "retryable, never
    // counted" by design — count only hardFailureCount here, not
    // failures.length (which stays inclusive, for CLI/receipt reporting),
    // so a heavy run that only ever hit transient errors doesn't trip the
    // doctor extract_health halt-rate warning.
    await upsertExtractRollup(engine, {
      kind: 'atoms',
      source_id: sourceId,
      cost_delta: estimatedSpendUsd,
      round_completed_delta: hardFailureCount === 0 ? 1 : 0,
      halt_delta: hardFailureCount > 0 ? 1 : 0,
    });
  }

  return {
    phase: 'extract_atoms',
    // A phase that skipped every work item and produced nothing did not
    // succeed, even though skips are not failures and leave failures[] empty.
    // Reporting 'ok' there hides a total no-op behind a green status.
    status:
      failures.length > 0 ||
      (work.length > 0 &&
        totalAtomsExtracted === 0 &&
        transcriptsSkipped + pagesSkipped === work.length)
        ? 'warn'
        : 'ok',
    duration_ms: 0,
    summary:
      `extract_atoms: ${totalAtomsExtracted} atoms from ` +
      `${transcriptsProcessed}/${transcripts.length} transcripts + ` +
      `${pagesProcessed}/${pages.length} pages` +
      (failures.length > 0 ? ` (${failures.length} failed)` : '') +
      (transcriptsSkipped + pagesSkipped > 0
        ? ` (${transcriptsSkipped + pagesSkipped} budget-skipped)`
        : ''),
    details: {
      atoms_extracted: totalAtomsExtracted,
      transcripts_processed: transcriptsProcessed,
      transcripts_total: transcripts.length,
      transcripts_skipped_budget: transcriptsSkipped,
      pages_processed: pagesProcessed,
      pages_total: pages.length,
      pages_skipped_budget: pagesSkipped,
      duplicates_skipped: duplicatesSkipped,
      failures,
      ...(abortedGlobalError ? { aborted_global_error: abortedGlobalError } : {}),
      malformed_outputs: malformedOutputs,
      tombstoned_for_failures: tombstonedForFailures,
      tombstoned_for_quality_rejections: tombstonedForQualityRejections,
      estimated_spend_usd: estimatedSpendUsd,
      budget_usd: budgetCap,
      model: extractModel,
      fallback_latched_model: fallbackLatchedModel,
      budget_exhausted: budgetExhausted,
      source_id: sourceId,
      dry_run: opts.dryRun ?? false,
      dry_run_limit: opts.dryRun ? MAX_DRY_RUN_WORK_ITEMS : null,
      dry_run_omitted_items: dryRunOmittedItems,
      candidates: candidatesCount,
      accepted: acceptedCount,
      rejected: rejectedCount,
      rejected_by_reason: { ...rejectedByReason },
      actual_models: {
        extraction: [...extractionActualModels].sort(),
        semantic_validator: [...validatorActualModels].sort(),
      },
      actual_routes: {
        extraction: [...extractionActualRoutes].sort(),
        semantic_validator: [...validatorActualRoutes].sort(),
      },
    },
  };
}

/**
 * gbrain#4148 — typed parse outcome. Malformed model output and a legitimate
 * zero-yield extraction both used to collapse into `[]`, so malformed output
 * was tombstoned as success (the page never retried, its atoms silently
 * lost). `ok: false` means the response was not parseable as an atoms array
 * AT ALL — a content-deterministic failure class the caller counts toward a
 * bounded tombstone; `ok: true, atoms: []` means the model genuinely
 * extracted nothing.
 */
export type AtomsParseOutcome =
  | { ok: true; atoms: ExtractedAtom[] }
  | { ok: false; reason: string };

export function parseAtomsOutcome(raw: string, sourceText?: string): AtomsParseOutcome {
  const direct = parseAtomsOutcomeInner(raw, sourceText);
  if (direct.ok) return direct;
  // Same reasoning-block hazard as the facts extractor: `indexOf('[')` below
  // finds a bracket inside <think> when the model drafts its array while
  // reasoning, so the parse fails and the page is halted. Ladder, not a
  // pre-filter: raw first, stripped only on failure — and the ORIGINAL
  // outcome is returned when the retry also fails, so error reasons are
  // unchanged for non-reasoning models.
  const stripped = stripReasoningBlocks(raw);
  if (stripped && stripped !== raw.trim()) {
    const retry = parseAtomsOutcomeInner(stripped, sourceText);
    if (retry.ok) return retry;
  }
  return direct;
}

function parseAtomsOutcomeInner(raw: string, sourceText?: string): AtomsParseOutcome {
  // Strip markdown code fences if the LLM wrapped JSON in them.
  let cleaned = raw.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();

  // Find the first JSON array bracket.
  const arrayStart = cleaned.indexOf('[');
  if (arrayStart === -1) return { ok: false, reason: 'no JSON array in response' };
  cleaned = cleaned.slice(arrayStart);

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Try trimming back from the end to recover from trailing prose.
    const arrayEnd = cleaned.lastIndexOf(']');
    if (arrayEnd === -1) return { ok: false, reason: 'unterminated JSON array' };
    try {
      parsed = JSON.parse(cleaned.slice(0, arrayEnd + 1));
    } catch {
      return { ok: false, reason: 'unparseable JSON array' };
    }
  }

  if (!Array.isArray(parsed)) return { ok: false, reason: 'JSON value is not an array' };
  const atoms = atomsFromParsedArray(parsed, sourceText);
  if (typeof sourceText === 'string' && sourceText.length >= MIN_PAGE_CHARS_FOR_EXTRACTION
      && parsed.length > 0 && atoms.length === 0) {
    return { ok: false, reason: 'no valid grounded atomic claims' };
  }
  return { ok: true, atoms };
}

/**
 * Back-compat wrapper: parse the response into ExtractedAtom[], returning []
 * for BOTH malformed output and a legitimate zero-yield (legacy callers/tests
 * that don't need the typed distinction — new code uses parseAtomsOutcome).
 */
export function parseAtomsResponse(raw: string, sourceText?: string): ExtractedAtom[] {
  const outcome = parseAtomsOutcome(raw, sourceText);
  return outcome.ok ? outcome.atoms : [];
}

function atomsFromParsedArray(parsed: unknown[], sourceText?: string): ExtractedAtom[] {

  const atoms: ExtractedAtom[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const obj = item as Record<string, unknown>;
    const title = typeof obj.title === 'string' ? obj.title.slice(0, 80) : null;
    const atomType = typeof obj.atom_type === 'string' ? obj.atom_type.trim().toLowerCase() : null;
    let body = typeof obj.body === 'string' ? obj.body.trim() : null;
    const sourceQuote = typeof obj.source_quote === 'string' ? obj.source_quote.trim() : null;
    if (!title || !atomType || !body) continue;
    if (!ATOM_TYPES.includes(atomType as typeof ATOM_TYPES[number])) continue;
    const requireGrounding = typeof sourceText === 'string'
      && sourceText.length >= MIN_PAGE_CHARS_FOR_EXTRACTION;
    if (requireGrounding) {
      if (!sourceQuote || sourceQuote.length > 200 || !sourceText.includes(sourceQuote)) continue;
      if (!isSingleAtomicSentence(body, MAX_GROUNDED_BODY_CHARS)) continue;
      if (!isSingleAtomicSentence(sourceQuote, 200)) continue;
      if (!isSelfContainedAtomicEvidence(sourceQuote)) continue;
      body = sourceQuote;
    }
    atoms.push({
      title,
      atom_type: atomType as typeof ATOM_TYPES[number],
      body,
      source_quote: sourceQuote ? sourceQuote.slice(0, 200) : undefined,
      lesson: requireGrounding ? undefined : (typeof obj.lesson === 'string' ? obj.lesson : undefined),
      concepts: (() => {
        if (!Array.isArray(obj.concepts)) return undefined;
        const labels = obj.concepts
          .filter((c): c is string => typeof c === 'string' && CONCEPT_LABEL_RE.test(c))
          .slice(0, 3);
        return labels.length > 0 ? labels : undefined;
      })(),
      virality_score:
        typeof obj.virality_score === 'number' &&
        obj.virality_score >= 0 &&
        obj.virality_score <= 100
          ? obj.virality_score
          : undefined,
      emotional_register:
        typeof obj.emotional_register === 'string' ? obj.emotional_register : undefined,
    });
  }
  return atoms;
}
