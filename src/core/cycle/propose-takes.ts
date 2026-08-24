/**
 * v0.36.1.0 (T3) — propose_takes cycle phase.
 *
 * Scans markdown pages updated since last run, sends each page's prose to
 * a tuned LLM extractor, writes the extracted gradeable claims to the
 * `take_proposals` queue. User accepts/rejects via `gbrain takes propose`.
 *
 * Idempotency contract (D17 schema spec):
 *   The unique index on (source_id, page_slug, content_hash, prompt_version)
 *   means an unchanged page never re-spends LLM tokens. Bumping
 *   PROPOSE_TAKES_PROMPT_VERSION cleanly invalidates the cache so a tuned
 *   prompt re-runs proposals on every page.
 *
 * F2 fence dedup:
 *   The phase reads the page's existing `<!-- gbrain:takes:begin -->` fence
 *   (when present) and passes the canonical take rows to the extractor as
 *   "things you have already captured." This prevents duplicate proposals
 *   when a user adds prose to a page that already has takes.
 *
 * Auto-resolve posture:
 *   propose_takes only WRITES proposals to the queue. Nothing here mutates
 *   the canonical takes table. Operator opt-in via `gbrain takes propose
 *   --accept N` is the only path from queue to canonical fence (D17).
 *
 * Prompt tuning status (v0.36.1.0 ship state):
 *   The default extractor prompt was tuned against the synthetic corpus at
 *   test/fixtures/calibration/ and validated via the cat15 propose_takes
 *   eval in the gbrain-evals repo. First live run scored 0.952 F1 on
 *   training (target 0.85) and 0.922 F1 on holdout (target 0.80), with a
 *   0.03 train-holdout gap (no overfitting). PROPOSE_TAKES_PROMPT_VERSION
 *   is "v0.36.1.0-tuned-cat15". Re-tuning requires re-running cat15;
 *   bumping the version string invalidates the take_proposals idempotency
 *   cache so old proposals stay as audit history but the next cycle
 *   re-extracts fresh against the new prompt.
 *
 * The extractor LLM call is INJECTED via opts.extractor for tests, so the
 * phase can run hermetically in unit tests without touching the gateway.
 */

import { randomUUID, createHash } from 'node:crypto';
import { BaseCyclePhase, CYCLE_DEADLINE_RESERVE_MS, type ScopedReadOpts, type BasePhaseOpts } from './base-phase.ts';
import { defaultTimeoutMsFor } from '../minions/handler-timeouts.ts';
import { chat as gatewayChat, getChatModel, probeChatModel } from '../ai/gateway.ts';
import { createGlobalLlmHaltTracker, haltedClassOf, type GlobalLlmErrorClass } from '../ai/errors.ts';
import { normalizeModelId } from '../model-id.ts';
import { writeReceipt } from '../extract/receipt-writer.ts';
import { upsertExtractRollup } from '../extract/rollup-writer.ts';
import { GBrainError } from '../types.ts';
import { isConfigTruthy } from '../config.ts';
import { loadSensitivityConfig, scanSensitive, type SensitivityScanConfig } from '../context/sensitivity-scan.ts';
import type { OperationContext } from '../operations.ts';
import type { BrainEngine } from '../engine.ts';
import type { PhaseStatus, CyclePhase } from '../cycle.ts';

/**
 * Bump when the extractor prompt, JSON output shape, or production
 * eligibility/privacy contract changes. Old verdicts in `take_proposals`
 * (composite key includes prompt_version) stay valid as audit history; new
 * runs re-spend LLM tokens on every page.
 */
export const PROPOSE_TAKES_PROMPT_VERSION = 'v0.46.28.9-calibration-judgments';

/**
 * Containment allowlist. Apply this predicate in SQL before ORDER/LIMIT so a
 * stream of newer conversations, sessions, projects, or operational pages
 * cannot starve the durable long-form pages eligible for take extraction.
 */
export const PROPOSE_TAKES_ALLOWED_PAGE_TYPES = [
  'concept', 'atom', 'lore', 'briefing', 'writing', 'originals',
] as const;

/**
 * Type metadata is advisory: production contains project, feature, infra and
 * generated skill pages mislabeled as `concept`. Deny those operational slug
 * contours in SQL before LIMIT so they neither consume canary slots nor rely
 * on the LLM to notice that they are out of scope.
 */
export const PROPOSE_TAKES_EXCLUDED_SLUG_PATTERNS = [
  'conversations/%',
  'sessions/%',
  'projects/%',
  'companies/%',
  'infra/%',
  'infrastructure/%',
  'features/%',
  'jira/%',
  '%/jira/%',
  'cf/%',
  '%/cf/%',
  '%/skill',
  '%/skills/%',
] as const;

/** Production means long-form prose, not newly written factual entity stubs. */
export const PROPOSE_TAKES_MIN_PAGE_CHARS = 800;

/**
 * @deprecated Empty extraction memoization now lives only in
 * `proposal_page_runs`; no synthetic proposal row is written.
 */
export const EMPTY_EXTRACTION_TOMBSTONE_TEXT = '(no gradeable claims)';

/**
 * Historical tuned baseline, validated against the hand-labeled synthetic
 * corpus at test/fixtures/calibration/. The baseline measured F1 on its first live run
 * via gbrain-evals cat15 (claude-sonnet-4-6 extractor, claude-haiku-4-5
 * matcher judge):
 *
 *   training avg F1: 0.952 (target 0.85, exceeded by 10 points)
 *   holdout  avg F1: 0.922 (target 0.80, exceeded by 12 points)
 *   train-holdout gap: 0.03 (no overfitting signal)
 *
 * Per-genre F1 floor: 0.80 (people-pages, the hardest genre). The
 * concept-with-timeline and meeting-notes genres scored at 1.00 on
 * holdout pages.
 *
 * Design choices baked into the prompt:
 *   - Worked example list seeds the model's notion of "gradeable claim"
 *     so it doesn't drift into pure-fact extraction.
 *   - NOT-gradeable list catches the most common over-extraction modes
 *     (pure facts, direct quotes, restatements).
 *   - conviction inference rules anchored to specific hedging language
 *     ("I bet"/"strong conviction"=0.7-0.85, "I think"/"moderate"=0.5-0.7).
 *   - kind enum kept narrow ('prediction'|'judgment'|'bet') — the v1
 *     stub's 4-tag enum bled into noise classification.
 *
 * The current v0.46.28.6 contract adds production containment learned from four
 * grounded canaries: exact evidence alone does not distinguish a gradeable
 * judgment from a KPI, historical measurement, ETA, procedural fact, or
 * heading fragment; type labels alone do not guarantee long-form prose; Jira
 * and Confluence imports can be mislabeled as concepts; and a page can contain
 * credentials or PII that must fail before an external LLM call. Those stricter
 * rules are not represented by the historical score above. It also persists
 * aggregate-only first-failure diagnostics and rejects explicit holder/weight
 * values outside the prompt contract. Re-run cat15 before enabling automatic
 * production work. The train-holdout gap should stay < 0.10 (overfitting
 * threshold).
 */
export const EXTRACT_TAKES_PROMPT = `Extract gradeable claims from the prose below.

A "gradeable claim" is a prediction, recommendation, or interpretive judgment
that could turn out wrong over time. Examples:
- "X company will hit ARR milestone by Q3" (prediction)
- "Y founder is going to struggle with execution" (judgment)
- "Z market will compress in 18 months" (prediction)
- "I bet alice wins the round" (bet)

NOT gradeable (do NOT extract these):
- Pure facts ("X was founded in 2020")
- Direct quotes from others without endorsement
- Restatements of an earlier claim in the same page
- Operational instructions, checklists, status updates, ETAs, and incident tactics
- A heading or fragment that merely names a topic (for example "MFA on OWA")
  cannot support an inferred absence, failure, cause, consequence, or polarity

Coverage rules:
- Scan every paragraph and every bullet. Return every independent author-endorsed
  gradeable claim once; do not stop after the first few.
- Explicit "I bet ..." claims are gradeable bets even when their grammar uses
  present tense. Concrete future assertions in a Bets/Takes section still count.
- Self-assessments of calibration, confidence, strengths, or recurring errors are
  interpretive judgments, as are generalizations, comparisons, causal diagnoses,
  and recommendations grounded in the author's observations.
- Calibration examples that MUST be extracted as judgments include "I'm right
  roughly 70% of the time on X", "I am worse than I think on Y", and "I'm
  well-calibrated on Z". Preserve the exact source wording and any stated rate.
  When the same paragraph adds a consequent self-instruction ("so I should stop
  or trust it more"), prefer the calibration assessment; do not emit the
  consequent instruction as a duplicate of that assessment.
- A third party's assertion ("she thinks ...", "X argues ...") is not the page
  author's claim unless the author explicitly endorses it. Extract the author's
  pushback or evaluation instead, using an exact self-contained source span.
- When two nearby sentences express the same assertion, emit only the clearest
  author-endorsed version. Supporting reasons are evidence, not separate claims,
  unless they assert a genuinely independent gradeable proposition.

The exact claim_text quote must contain its own gradeability signal:
- prediction/bet: an explicit forward-looking or uncertainty cue such as
  "will", "likely", "next year", "будет", "вероятно", or "ожидаю"
- judgment: an explicit opinion, evaluation, or recommendation cue such as
  "should", "better", "harmful", "I think", "следует", "лучше", or
  "правильное решение"
- claim_text must contain at least three lexical words; a bare metric, label,
  heading, or ETA is invalid even when quoted exactly

Use this COPY-FIRST workflow for every row:
1. Select the smallest complete declarative span already present in PAGE PROSE.
2. Copy that span into claim_text. Do not summarize, rewrite, join clauses from
   different places, or remove words/polarity. Preserve punctuation and wording.
3. Copy one contiguous evidence_span that contains claim_text. The safest valid
   evidence_span is the same exact source span as claim_text; expand it only when
   adjacent author framing is needed.
4. Before returning, verify both strings occur in PAGE PROSE and that
   evidence_span contains claim_text. Markdown may visually wrap a sentence;
   copy its text without paraphrasing it.

For each gradeable claim, output a JSON object with:
- claim_text   (one exact contiguous quote copied byte-for-byte from PAGE PROSE,
                <=200 chars; never paraphrase, add, or remove polarity, cause,
                or consequence)
- kind         ('prediction' | 'judgment' | 'bet')
- holder       ('world' | 'people/<slug>' | 'companies/<slug>' | 'brain' — default 'brain' when author asserts the claim)
- weight       (number 0..1 inferred from hedging language: 'I bet'/'strong conviction'=0.7-0.85,
                'I think'/'moderate conviction'=0.5-0.7, 'maybe'/'I'd guess'=0.3-0.5)
- domain       (short tag — e.g. 'tactics', 'macro', 'hiring', 'geography', 'pricing')
- evidence_span (one exact contiguous substring copied byte-for-byte from PAGE
                 PROSE that directly supports the whole claim; <=500 chars;
                 never paraphrase or combine non-contiguous fragments)

Output ONLY a JSON array of these objects. No prose. No commentary. If no
gradeable claims, return [].

EXISTING FENCE ROWS (already captured — do NOT propose duplicates):
{EXISTING_TAKES_JSON}

PAGE PROSE:
{PAGE_BODY}
`;

/** One proposed take, as the extractor produces it. */
export interface ProposedTake {
  claim_text: string;
  kind: 'fact' | 'take' | 'bet' | 'hunch';
  holder: string;
  weight: number;
  domain?: string;
  evidence_span?: string;
}

/** Array result with non-enumerable production provenance attached by the gateway extractor. */
export type ProposeTakesExtraction = ProposedTake[] & {
  modelId?: string;
  /** Clean JSON array was returned, but every row failed the strict contract. */
  qualityRejected?: boolean;
  /** Rows removed by the strict grounding/kind/signal contract. */
  contractRejectedCount?: number;
  /** Aggregate-only first-failure reasons; never contains source or proposal text. */
  rejectionReasonCounts?: ProposalRejectionReasonCounts;
};

export type ProposalRejectionReason =
  | 'invalid_row'
  | 'missing_claim'
  | 'claim_too_long'
  | 'unknown_kind'
  | 'missing_gradeable_signal'
  | 'invalid_holder'
  | 'invalid_weight'
  | 'missing_evidence'
  | 'evidence_too_long'
  | 'claim_not_verbatim'
  | 'evidence_not_verbatim'
  | 'claim_not_in_evidence'
  | 'post_parse_grounding'
  | 'sensitive_source';

export type ProposalRejectionReasonCounts = Partial<Record<ProposalRejectionReason, number>>;

/** Extractor function signature — injected for tests; production calls gateway. */
export type ProposeTakesExtractor = (input: {
  pagePath: string;
  pageBody: string;
  existingTakes: Array<{ claim: string; kind: string; holder: string; weight: number }>;
  modelHint?: string;
}) => Promise<ProposeTakesExtraction>;

export interface ProposeTakesOpts extends BasePhaseOpts {
  /** Brain repo root for fs-source page walking. Optional — defaults to engine pages. */
  repoPath?: string;
  /** Limit pages processed in this cycle (for triage / quick smoke). Default: 100. */
  pageLimit?: number;
  /** Inject the LLM call for tests; production uses gateway.chat. */
  extractor?: ProposeTakesExtractor;
  /** Override prompt_version (tests). */
  promptVersion?: string;
  /** Override model id (tests + config). */
  model?: string;
  /** Override the production long-form floor (tests/evals). */
  minPageChars?: number;
  /** Inject a deterministic source-sensitivity config (tests). */
  sensitivityConfig?: SensitivityScanConfig;
  /** Skip pages that already have a complete takes fence. Default: true. */
  skipPagesWithFence?: boolean;
  /** Override the phase wall-clock deadline (tests). Default: 30 min. */
  deadlineMs?: number;
  /**
   * #4102 — `gbrain dream --phase propose_takes --once` bypasses the
   * `cycle.propose_takes.enabled` off switch for THIS call only (mirrors the
   * conversation_facts_backfill `once` semantics; never reads/writes config).
   */
  once?: boolean;
}

export interface ProposeTakesResult {
  pages_scanned: number;
  cache_hits: number;
  cache_misses: number;
  proposals_inserted: number;
  proposals_rejected_ungrounded: number;
  /** @deprecated Always 0; empty memoization lives in proposal_page_runs. */
  tombstones_written: number;
  /** Terminal empty page-run receipts written (without synthetic proposals). */
  empty_runs_written: number;
  budget_exhausted: boolean;
  /** True when the phase deadline fired before the page loop completed (partial result). */
  deadline_hit?: boolean;
  /**
   * Set when the page loop broke on a whole-run LLM failure (#3044):
   * auth/billing on the first hit, rate_limit after RATE_LIMIT_HALT_STREAK
   * consecutive hits. The phase reports 'warn' ('fail' when NO extractor
   * call succeeded) and the rollup records a halt so the condition can't
   * hide behind a green summary.
   */
  aborted_global_error?: GlobalLlmErrorClass;
  /**
   * #3763: set when the page loop halted because EVERY extractor call failed
   * (zero successes) for EXTRACTOR_FAILURE_HALT_STREAK consecutive pages —
   * a dead extractor lane (bad model id, broken recipe, systematic truncation)
   * that would otherwise re-bill every remaining page. Folds into `halted`
   * and reports the phase as 'fail'.
   */
  aborted_failure_streak?: boolean;
  /** Extractor calls that returned (idempotency cache hits don't count). */
  llm_calls_succeeded: number;
  /** Extractor calls that threw (global or per-page alike). */
  llm_calls_failed: number;
  page_receipts_completed: number;
  page_receipts_empty: number;
  page_receipts_quality_rejected: number;
  page_receipts_failed: number;
  /** Pages stopped by the deterministic full-source scan before any LLM call. */
  pages_rejected_sensitive: number;
  /** Provider/model ids that actually answered successful production calls. */
  models_used: string[];
  /** Aggregate-only rejection diagnostics, safe for receipts and phase output. */
  rejection_reason_counts: ProposalRejectionReasonCounts;
  warnings: string[];
}

/** Narrow projection of `pages` — the only columns this phase reads. */
interface ProposeTakesPageRow {
  slug: string;
  source_id: string;
  compiled_truth: string | null;
}

/**
 * Load proposal candidates with a narrow projection instead of
 * `engine.listPages` (`SELECT p.*`). The phase only reads slug, source_id
 * and compiled_truth — skipping timeline/frontmatter/title keeps large
 * toasted columns out of the hot path. Scope precedence mirrors
 * `sourceScopeOpts`: federated array (`sourceIds`) beats scalar
 * (`sourceId`); ordering matches `PAGE_SORT_SQL.updated_desc` with an id
 * tiebreak for determinism. (Takeover of PR #1979's projection by
 * @shawnduggan.)
 */
async function listCandidatePages(
  engine: BrainEngine,
  scope: ScopedReadOpts,
  limit: number,
  minPageChars: number,
): Promise<ProposeTakesPageRow[]> {
  const where = [
    'deleted_at IS NULL',
    'type = ANY($1::text[])',
    'NOT (slug LIKE ANY($2::text[]))',
    'length(compiled_truth) >= $3',
    'compiled_truth IS NOT NULL',
    "btrim(compiled_truth) <> ''",
  ];
  const params: unknown[] = [
    PROPOSE_TAKES_ALLOWED_PAGE_TYPES,
    PROPOSE_TAKES_EXCLUDED_SLUG_PATTERNS,
    minPageChars,
  ];
  if (scope.sourceIds && scope.sourceIds.length > 0) {
    params.push(scope.sourceIds);
    where.push(`source_id = ANY($${params.length}::text[])`);
  } else if (scope.sourceId) {
    params.push(scope.sourceId);
    where.push(`source_id = $${params.length}`);
  }
  params.push(limit);
  return engine.executeRaw<ProposeTakesPageRow>(
    `SELECT slug, source_id, compiled_truth
       FROM pages
      WHERE ${where.join(' AND ')}
      ORDER BY updated_at DESC, id DESC
      LIMIT $${params.length}`,
    params,
  );
}

/**
 * Compute the content_hash key for the idempotency cache. SHA-256 of the
 * page body suffices — page slug + prompt_version are separate columns in
 * the composite unique index.
 */
export function contentHash(pageBody: string): string {
  return createHash('sha256').update(pageBody).digest('hex');
}

/**
 * Detect whether a page already has a complete `<!-- gbrain:takes:begin -->`
 * fence. We DO propose against pages with fences (F2 dedup) but the operator
 * may opt to skip-with-fence pages via skipPagesWithFence:true for a faster
 * pass. The fence shape mirrors src/core/takes-fence.ts.
 */
export function hasCompleteFence(pageBody: string): boolean {
  return /<!---?\s*gbrain:takes:begin[\s\S]*?gbrain:takes:end\s*-->/.test(pageBody);
}

/**
 * Parse the existing fence into rows so the extractor can dedupe.
 * Returns [] when no fence is present. Best-effort — malformed fences
 * surface to the operator via the existing v0.28 fence parser, not here.
 */
export function extractExistingTakesForDedup(pageBody: string): Array<{
  claim: string;
  kind: string;
  holder: string;
  weight: number;
}> {
  const fenceMatch = pageBody.match(/<!---?\s*gbrain:takes:begin\s*-->([\s\S]*?)<!---?\s*gbrain:takes:end\s*-->/);
  if (!fenceMatch) return [];
  const body = fenceMatch[1] ?? '';
  const rows: Array<{ claim: string; kind: string; holder: string; weight: number }> = [];
  for (const line of body.split('\n')) {
    const cells = line.split('|').map(c => c.trim()).filter((_, i, arr) => i > 0 && i < arr.length - 1);
    // Skip header + separator rows.
    if (cells.length < 4) continue;
    if (cells[0] === '#' || cells[0]?.match(/^-+$/)) continue;
    const claim = cells[1] ?? '';
    if (!claim || claim.startsWith('~~')) continue; // strikethrough = inactive, doesn't count for dedup
    const kind = cells[2] ?? 'take';
    const holder = cells[3] ?? 'brain';
    const weight = Number.parseFloat(cells[4] ?? '0.5');
    rows.push({
      claim: claim.replace(/^~~|~~$/g, ''),
      kind,
      holder,
      weight: Number.isFinite(weight) ? weight : 0.5,
    });
  }
  return rows;
}

/** Per-call wall-clock timeout for the extractor LLM call. */
const EXTRACTOR_CALL_TIMEOUT_MS = 90_000;

/**
 * #3763 — output caps for the extractor call. A stopReason 'length' response
 * at the base cap retries ONCE at the escalated cap (facts/extract.ts #2113
 * parity); a still-truncated retry throws an error NAMING the truncation
 * instead of the old generic 'transient — retry' (which re-billed the page
 * every cycle forever while hiding the real cause).
 */
export const PROPOSE_TAKES_MAX_TOKENS = 2048;
export const PROPOSE_TAKES_RETRY_MAX_TOKENS = 4096;

/**
 * #3763 — halt streak for a dead extractor lane. When EVERY extractor call in
 * the run has failed (zero successes) and the failure count reaches this
 * streak, the page loop halts instead of burning an LLM call (and its input
 * tokens) on every remaining page. Any single success disarms the halt for
 * the rest of the run — a mixed run is per-page noise, not a dead lane.
 * Deliberately NO failure tombstone (#3910 policy): failed pages retry next
 * cycle once the underlying cause clears.
 */
export const EXTRACTOR_FAILURE_HALT_STREAK = 5;

/**
 * Production extractor — calls gateway.chat with the EXTRACT_TAKES_PROMPT
 * and parses the JSON array output. Returns [] on parse failure (logged as
 * warning, not thrown — one bad page must not abort the phase).
 *
 * Stub-prompt note: the v0.36.1.0 ship-state prompt is a placeholder. Real
 * extractor lands when T19 corpus build produces the tuned prompt. Until
 * then, the production extractor returns whatever the stub LLM produces —
 * empirically often a sparse list or [].
 */
export async function defaultExtractor(
  input: Parameters<ProposeTakesExtractor>[0],
): Promise<ProposeTakesExtraction> {
  const prompt = EXTRACT_TAKES_PROMPT
    .replace('{EXISTING_TAKES_JSON}', JSON.stringify(input.existingTakes, null, 2))
    .replace('{PAGE_BODY}', input.pageBody);

  // Bound each call so one stalled provider socket can't pin the phase for the
  // full gateway default (GBRAIN_AI_CHAT_TIMEOUT_MS, 300s) x pageLimit. The
  // caller already catches per-page errors, logs a warning, and continues.
  const call = (maxTokens: number) => gatewayChat({
    messages: [{ role: 'user', content: prompt }],
    ...(input.modelHint ? { model: input.modelHint } : {}),
    maxTokens,
    abortSignal: AbortSignal.timeout(EXTRACTOR_CALL_TIMEOUT_MS),
  });
  let result = await call(PROPOSE_TAKES_MAX_TOKENS);

  // #3763: a truncated response (stopReason 'length' — e.g. reasoning tokens
  // eating the cap, or a dense page extracting many claims) produced
  // unparseable JSON that the ambiguity guard below rethrew as a GENERIC
  // 'transient — retry', so the page was re-billed at the same too-small cap
  // every cycle forever. Retry ONCE at the escalated cap (#2113 parity);
  // still-truncated throws a message that NAMES the truncation so the phase
  // warning tells the operator what actually happened.
  if (result.stopReason === 'length') {
    process.stderr.write(
      `[propose_takes] WARN: extractor output truncated at maxTokens=${PROPOSE_TAKES_MAX_TOKENS} ` +
      `(${input.pagePath}); retrying once at ${PROPOSE_TAKES_RETRY_MAX_TOKENS}\n`,
    );
    result = await call(PROPOSE_TAKES_RETRY_MAX_TOKENS);
    if (result.stopReason === 'length') {
      throw new Error(
        `propose_takes extractor: output truncated (stopReason=length) even at ` +
        `maxTokens=${PROPOSE_TAKES_RETRY_MAX_TOKENS} on ${input.pagePath} — ` +
        `page prose extracts more than the cap can carry; no tombstone written, page retries next cycle`,
      );
    }
  }

  // ChatResult.text is already the concatenated text content.
  const takes = parseExtractorOutput(result.text, input.pageBody) as ProposeTakesExtraction;
  const cleanRows = parseCleanExtractionArray(result.text);
  // A parse-level `[]` is AMBIGUOUS: it means either "the model genuinely
  // found no gradeable claims" OR "the model returned malformed/prose/
  // truncated output we couldn't parse." The caller memoizes empty
  // extractions with a tombstone, so a transient parse failure would
  // PERMANENTLY suppress a page that actually has claims. Only a cleanly
  // parsed empty array is a real "no claims" result worth memoizing; treat
  // anything else as a transient error and throw, so the phase's catch
  // retries the page next cycle (writing no tombstone).
  if (cleanRows === null) {
    throw new Error('propose_takes extractor: no parseable takes JSON array (transient — retry)');
  }
  const contractRejectedCount = Math.max(0, cleanRows.length - takes.length);
  if (contractRejectedCount > 0) {
    Object.defineProperty(takes, 'contractRejectedCount', {
      value: contractRejectedCount,
      enumerable: false,
    });
  }
  if (takes.length === 0) {
    if (cleanRows.length > 0) {
      Object.defineProperty(takes, 'qualityRejected', {
        value: true,
        enumerable: false,
      });
    }
  }
  Object.defineProperty(takes, 'modelId', {
    value: result.model,
    enumerable: false,
  });
  return takes;
}

/**
 * True only when `raw` is a cleanly-parseable EMPTY JSON array — the
 * well-behaved "no gradeable claims" response (the prompt instructs the model
 * to return `[]`). Distinguishes a genuine empty extraction (safe to memoize
 * via a tombstone) from malformed / prose / truncated output (transient —
 * must be retried, never tombstoned). Mirrors parseExtractorOutput's
 * think-strip + fence-strip + first-array handling so both agree on what
 * "the model returned []" means.
 */
export function isWellFormedEmptyExtraction(raw: string): boolean {
  return parseCleanExtractionArray(raw)?.length === 0;
}

/** Parse the prompt-mandated top-level array without accepting malformed prose. */
function parseCleanExtractionArray(raw: string): unknown[] | null {
  if (!raw || raw.trim().length === 0) return null;
  let text = raw.trim();
  // Strip <think>...</think> reasoning tags (MiniMax-M3, DeepSeek-R1, etc.),
  // same as parseExtractorOutput (#2559).
  text = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const fenced = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  if (fenced) text = (fenced[1] ?? '').trim();
  const arrStart = text.indexOf('[');
  if (arrStart === -1) return null;
  try {
    const parsed = JSON.parse(text.slice(arrStart));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const PREDICTION_SIGNAL_RE = /\b(?:i\s+bet|will|won't|would|likely|unlikely|expect(?:s|ed|ing)?|predict(?:s|ed|ing)?|forecast(?:s|ed|ing)?|probab(?:le|ly|ility)|chance|risk|may|might|could|going\s+to|before|within|next\s+(?:(?:\d+|a|an)\s+)?(?:week|month|quarter|year)s?|by\s+(?:(?:early|mid|late)[-\s])?(?:q[1-4]|\d{4}|year(?:-end|\s+\d+)?))\b|(?:будет|будут|буду|вероятн\p{L}*|ожида\p{L}*|прогноз\p{L}*|предска\p{L}*|шанс\p{L}*|риск\p{L}*|может|могут|в\s+следующ\p{L}*|к\s+\d{4})/iu;
const CONDITIONAL_PREDICTION_SIGNAL_RE = /\bif\b[\s\S]{0,160}\b(?:will|would|then|reach(?:es)?|rise|fall|grow|drop|increase|decrease|land)\b|(?:если)[\s\S]{0,160}(?:будет|станет|достигн\p{L}*|выраст\p{L}*|упад\p{L}*|сниз\p{L}*|увелич\p{L}*)/iu;
const JUDGMENT_SIGNAL_RE = /\b(?:should|must|ought|need(?:s)?\s+to|better|worse|best|worst|right|wrong|correct|correctly|incorrect|prefer(?:s|red|ring)?|recommend(?:s|ed|ing)?|worth|valuable|harmful|beneficial|dangerous|safe|safer|unsafe|good|bad|ideal|effective|ineffective|important|critical|reasonable|unreasonable|clever|sound|flawed|superior|inferior|robust|fragile|strong|strongly|stronger|weak|weaker|fast(?:er)?|slow(?:er)?|aggressive|mistake|problem|trouble|concern|skeptical|calibrat(?:ed|ion)|confident|over-?confident|under-?invest|more\s+than|less\s+than|too\s+(?:long|short|high|low|aggressive)|does(?:n't|\s+not)\s+hold|leaves?\s+money\s+on\s+the\s+table|i\s+think|i\s+believe|i(?:'m|\s+am)\s+not\s+sure|actually)\b|(?:следует|нужно|необходимо|долж(?:ен|на|ны|но)|лучше|хуже|правильн\p{L}*|неправильн\p{L}*|корректн\p{L}*|рекоменд\p{L}*|предпочт\p{L}*|не\s+стоит|стоит|важн\p{L}*|критичн\p{L}*|опасн\p{L}*|безопасн\p{L}*|губительн\p{L}*|полезн\p{L}*|эффективн\p{L}*|неэффективн\p{L}*|оптимальн\p{L}*|разумн\p{L}*|сильн\p{L}*|слаб\p{L}*|над[её]жн\p{L}*|хрупк\p{L}*|счита\p{L}*|дума\p{L}*|полага\p{L}*)/iu;
const STRICT_HOLDER_RE = /^(?:world|brain|people\/[a-z0-9][a-z0-9._-]*|companies\/[a-z0-9][a-z0-9._-]*)$/;

function incrementRejectionReason(
  counts: ProposalRejectionReasonCounts,
  reason: ProposalRejectionReason,
  amount = 1,
): void {
  counts[reason] = (counts[reason] ?? 0) + amount;
}

function mergeRejectionReasonCounts(
  target: ProposalRejectionReasonCounts,
  source: ProposalRejectionReasonCounts | undefined,
): void {
  if (!source) return;
  for (const [reason, count] of Object.entries(source)) {
    if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) continue;
    incrementRejectionReason(target, reason as ProposalRejectionReason, count);
  }
}

/**
 * Exact quotation proves provenance, not semantic gradeability. Require the
 * quote itself (not surrounding evidence) to carry a kind-specific signal so
 * model-mislabeled facts, KPIs, ETAs and headings fail closed deterministically.
 */
export function hasGradeableClaimSignal(claimText: string, rawKind: string): boolean {
  const normalized = claimText.normalize('NFKC').trim();
  const lexicalWords = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (lexicalWords.length < 3) return false;
  if (rawKind === 'prediction' || rawKind === 'bet') {
    return PREDICTION_SIGNAL_RE.test(normalized) || CONDITIONAL_PREDICTION_SIGNAL_RE.test(normalized);
  }
  if (rawKind === 'judgment') return JUDGMENT_SIGNAL_RE.test(normalized);
  return false;
}

/**
 * LLMs routinely collapse Markdown hard-wrap whitespace even under an exact-
 * quote instruction. Recover only a whitespace-equivalent source span and
 * publish the source bytes, never the model-normalized string. This is not
 * fuzzy grounding: changed, inserted, deleted, or reordered non-whitespace
 * characters still fail closed.
 */
export function canonicalizeWhitespaceEquivalentSpan(
  pageBody: string,
  candidate: string,
): string | null {
  const trimmed = candidate.trim();
  if (!trimmed) return null;
  if (/\r?\n[ \t]*\r?\n/u.test(trimmed)) return null;
  if (pageBody.includes(trimmed)) return trimmed;

  const normalize = (value: string, withMap: boolean): {
    text: string;
    starts: number[];
    ends: number[];
  } => {
    let text = '';
    const starts: number[] = [];
    const ends: number[] = [];
    for (let i = 0; i < value.length;) {
      if (/\s/u.test(value[i]!)) {
        const runStart = i;
        while (i < value.length && /\s/u.test(value[i]!)) i++;
        const run = value.slice(runStart, i);
        if (/\r?\n[ \t]*\r?\n/u.test(run)) {
          text += '\u0000';
          if (withMap) {
            starts.push(runStart);
            ends.push(i);
          }
          continue;
        }
        // Markdown often wraps a hyphenated token after the hyphen. Treat only
        // that presentation whitespace as absent; other runs become one space.
        if (text.endsWith('-')) continue;
        if (text.length === 0 || i === value.length || text.endsWith(' ')) continue;
        text += ' ';
        if (withMap) {
          starts.push(runStart);
          ends.push(i);
        }
        continue;
      }
      text += value[i]!;
      if (withMap) {
        starts.push(i);
        ends.push(i + 1);
      }
      i++;
    }
    return { text, starts, ends };
  };

  const source = normalize(pageBody, true);
  const needle = normalize(trimmed, false).text;
  if (!needle) return null;
  const normalizedStart = source.text.indexOf(needle);
  if (normalizedStart < 0) return null;
  const normalizedEnd = normalizedStart + needle.length - 1;
  const sourceStart = source.starts[normalizedStart];
  const sourceEnd = source.ends[normalizedEnd];
  if (sourceStart === undefined || sourceEnd === undefined) return null;
  return pageBody.slice(sourceStart, sourceEnd);
}

/**
 * Parse extractor output into ProposedTake[]. Handles common LLM output
 * sins (markdown fence wrapping, leading/trailing prose, single-object
 * instead of array). Returns [] on any unrecoverable parse error rather
 * than throwing.
 */
export function parseExtractorOutput(raw: string, pageBody?: string): ProposeTakesExtraction {
  if (!raw || raw.trim().length === 0) return [];
  let text = raw.trim();
  // Strip <think>...</think> reasoning tags (MiniMax-M3, DeepSeek-R1, etc.).
  text = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  // Strip markdown code fence wrapper.
  const fenced = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  if (fenced) text = (fenced[1] ?? '').trim();
  // First-array-or-object substring extraction (defends against leading prose).
  const firstArr = text.indexOf('[');
  const firstObj = text.indexOf('{');
  if (firstArr === -1 && firstObj === -1) return [];
  const start = firstArr !== -1 && (firstObj === -1 || firstArr < firstObj) ? firstArr : firstObj;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start));
  } catch {
    // Fallback: truncate at last ] or } to handle trailing noise (e.g. leftover
    // markdown fences after <think> stripping). Try array-closing first.
    const sliced = text.slice(start);
    const lastArr = sliced.lastIndexOf(']');
    const lastObj = sliced.lastIndexOf('}');
    const end = Math.max(lastArr, lastObj);
    if (end > 0) {
      try {
        parsed = JSON.parse(sliced.slice(0, end + 1));
      } catch {
        return [];
      }
    } else {
      return [];
    }
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  const out: ProposeTakesExtraction = [];
  const rejectionReasonCounts: ProposalRejectionReasonCounts = {};
  const reject = (reason: ProposalRejectionReason): void => incrementRejectionReason(rejectionReasonCounts, reason);
  for (const raw of arr) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      if (typeof pageBody === 'string') reject('invalid_row');
      continue;
    }
    const r = raw as Record<string, unknown>;
    const rawClaimText = typeof r.claim_text === 'string' ? r.claim_text.trim() : '';
    const strictGrounding = typeof pageBody === 'string';
    if (!rawClaimText) {
      if (strictGrounding) reject('missing_claim');
      continue;
    }
    if (rawClaimText.length > (strictGrounding ? 200 : 500)) {
      if (strictGrounding) reject('claim_too_long');
      continue;
    }
    const claim_text = strictGrounding
      ? canonicalizeWhitespaceEquivalentSpan(pageBody, rawClaimText)
      : rawClaimText;
    const rawKind = typeof r.kind === 'string' ? r.kind : '';
    const kind: ProposedTake['kind'] | null = strictGrounding
      ? (rawKind === 'prediction' || rawKind === 'judgment'
          ? 'take'
          : rawKind === 'bet'
            ? 'bet'
            : null)
      : (['fact', 'take', 'bet', 'hunch'].includes(rawKind)
          ? rawKind as ProposedTake['kind']
          : 'take');
    if (kind === null) {
      reject('unknown_kind');
      continue;
    }
    if (strictGrounding && !hasGradeableClaimSignal(rawClaimText, rawKind)) {
      reject('missing_gradeable_signal');
      continue;
    }
    const holder = typeof r.holder === 'string' && r.holder.length > 0 ? r.holder : 'brain';
    if (strictGrounding && !STRICT_HOLDER_RE.test(holder)) {
      reject('invalid_holder');
      continue;
    }
    if (
      strictGrounding &&
      r.weight !== undefined &&
      (typeof r.weight !== 'number' || !Number.isFinite(r.weight) || r.weight < 0 || r.weight > 1)
    ) {
      reject('invalid_weight');
      continue;
    }
    const weightRaw = typeof r.weight === 'number' ? r.weight : 0.5;
    const weight = Math.max(0, Math.min(1, weightRaw));
    const domain = typeof r.domain === 'string' && r.domain.length > 0 ? r.domain : undefined;
    const rawEvidenceSpan = typeof r.evidence_span === 'string' && r.evidence_span.trim().length > 0
      ? r.evidence_span.trim()
      : undefined;
    const evidence_span = strictGrounding && rawEvidenceSpan
      ? canonicalizeWhitespaceEquivalentSpan(pageBody, rawEvidenceSpan)
      : rawEvidenceSpan;
    if (strictGrounding) {
      if (!rawEvidenceSpan) {
        reject('missing_evidence');
        continue;
      }
      if (rawEvidenceSpan.length > 500) {
        reject('evidence_too_long');
        continue;
      }
      if (!claim_text) {
        reject('claim_not_verbatim');
        continue;
      }
      if (claim_text.length > 200) {
        reject('claim_too_long');
        continue;
      }
      if (!evidence_span) {
        reject('evidence_not_verbatim');
        continue;
      }
      if (evidence_span.length > 500) {
        reject('evidence_too_long');
        continue;
      }
      if (!evidence_span.includes(claim_text)) {
        reject('claim_not_in_evidence');
        continue;
      }
    }
    if (!claim_text) continue;
    out.push({ claim_text, kind, holder, weight, domain, evidence_span: evidence_span ?? undefined });
  }
  if (Object.keys(rejectionReasonCounts).length > 0) {
    Object.defineProperty(out, 'rejectionReasonCounts', {
      value: rejectionReasonCounts,
      enumerable: false,
    });
  }
  return out;
}

/** A grounded proposal must quote its source page exactly, never paraphrase evidence. */
export function hasVerbatimEvidence(proposal: ProposedTake, pageBody: string): boolean {
  const span = proposal.evidence_span?.trim();
  const claim = proposal.claim_text.trim();
  return !!span && !!claim && span.length <= 500 && pageBody.includes(span) && span.includes(claim);
}

type ProposalPageRunStatus = 'completed' | 'empty' | 'quality_rejected' | 'failed';

async function writeProposalPageRun(
  engine: BrainEngine,
  input: {
    sourceId: string; pageSlug: string; sourceHash: string; promptVersion: string;
    proposalRunId: string; modelId: string; status: ProposalPageRunStatus;
    proposalCount: number; evidenceSpanCount: number; errorCode?: string;
    rejectionReasonCounts?: ProposalRejectionReasonCounts;
  },
): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO proposal_page_runs
       (source_id, page_slug, source_hash, prompt_version, proposal_run_id,
        model_id, status, proposal_count, evidence_span_count, error_code, rejection_reason_counts)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
     ON CONFLICT (source_id, page_slug, source_hash, prompt_version, proposal_run_id) DO NOTHING`,
    [
      input.sourceId, input.pageSlug, input.sourceHash, input.promptVersion,
      input.proposalRunId, input.modelId, input.status, input.proposalCount,
      input.evidenceSpanCount, input.errorCode ?? null,
      JSON.stringify(input.rejectionReasonCounts ?? {}),
    ],
  );
}

/**
 * BaseCyclePhase subclass. Walks pages, checks idempotency cache, calls
 * extractor, writes proposals.
 */
/**
 * #4168 — the phase deadline is DERIVED, never a literal. The old
 * PHASE_DEADLINE_MS thirty-minute literal was bit-identical to the
 * autopilot-cycle handler anchor (and the clocks were not even co-started:
 * the job clock starts at claim, this phase starts LATE in ALL_PHASES), so
 * the clean-exit `deadline_hit` path was structurally unreachable in
 * production — cycles died on wall-clock instead of completing partial and
 * `cycle_freshness` never advanced. Same duplicated-literal class as #2781.
 *
 * Fail-loud derivation (autopilot-timeout.ts precedent): a missing handler
 * anchor throws HERE, at module load — which propagates through cycle.ts's
 * dynamic import and fails the WHOLE cycle visibly rather than one phase
 * silently. Accepted trade; the drift-guard test pins the inequality.
 */
function requireCycleAnchorMs(): number {
  const ms = defaultTimeoutMsFor('autopilot-cycle');
  if (ms === null) {
    throw new Error(
      "propose_takes: 'autopilot-cycle' has no entry in HANDLER_DEFAULT_TIMEOUT_MS " +
      '(handler-timeouts.ts) — the phase deadline can no longer be derived from it. See #4168.',
    );
  }
  return ms;
}

/** Headroom for grade_takes + calibration_profile, which run AFTER this
 *  phase in the same calibration block with no deadline of their own. */
export const PHASE_DEADLINE_FRACTION_OF_JOB = 0.8;
export const PROPOSE_TAKES_FALLBACK_DEADLINE_MS = Math.floor(
  requireCycleAnchorMs() * PHASE_DEADLINE_FRACTION_OF_JOB,
);
/** Mirrors MIN_PATTERNS_SUBAGENT_BUDGET_MS: below this the phase cannot do
 *  useful LLM work before the job's kill switch — skip honestly instead. */
export const MIN_PROPOSE_TAKES_BUDGET_MS = 2 * 60 * 1000;

/**
 * Resolve the phase's wall-clock budget from the REAL remaining job time
 * when it is known. Shaped like patterns.ts's clampSubagentBudgets: null
 * means "not worth starting" (caller returns an honest skip). Pure —
 * unit-testable without an engine.
 */
export function resolveProposeTakesDeadlineMs(
  deadlineAtMs: number | null | undefined,
  nowMs: number,
): number | null {
  if (deadlineAtMs == null) return PROPOSE_TAKES_FALLBACK_DEADLINE_MS;
  const remaining = deadlineAtMs - CYCLE_DEADLINE_RESERVE_MS - nowMs;
  // Red-team + adversarial F4: the grade_takes/calibration_profile headroom
  // the 0.8 fraction exists for must apply on the THREADED path too, and the
  // MIN floor must gate the FRACTIONED value — clamping a sub-MIN fraction
  // back UP to MIN would hand propose_takes the whole remaining window and
  // start the downstream phases inside the reserve. Under the floor, skip
  // honestly instead.
  const fractioned = Math.floor(remaining * PHASE_DEADLINE_FRACTION_OF_JOB);
  if (fractioned < MIN_PROPOSE_TAKES_BUDGET_MS) return null;
  return Math.min(fractioned, PROPOSE_TAKES_FALLBACK_DEADLINE_MS);
}

class ProposeTakesPhase extends BaseCyclePhase {
  readonly name = 'propose_takes' as CyclePhase;
  protected readonly budgetUsdKey = 'cycle.propose_takes.budget_usd';
  protected readonly budgetUsdDefault = 5.0;

  protected override mapErrorCode(err: unknown): string {
    if (err instanceof GBrainError) return err.problem;
    if (err instanceof Error) {
      if (err.message.includes('content_hash')) return 'CALIBRATION_PROPOSAL_DEDUP_FAIL';
      if (err.message.includes('budget') || err.message.includes('Budget')) return 'CALIBRATION_GRADE_BUDGET_EXHAUSTED';
    }
    return 'PROPOSE_TAKES_UNKNOWN';
  }

  protected async process(
    engine: BrainEngine,
    scope: ScopedReadOpts,
    ctx: OperationContext,
    opts: ProposeTakesOpts,
  ): Promise<{ summary: string; details: Record<string, unknown>; status?: PhaseStatus }> {
    // Downstream containment: fail closed. Unset/read-error/falsy all skip;
    // only explicit true runs automatically. `--once` is the one-call bypass.
    if (!opts.once) {
      let enabledRaw: string | null = null;
      try {
        enabledRaw = await engine.getConfig?.('cycle.propose_takes.enabled') ?? null;
      } catch {
        enabledRaw = null;
      }
      if (!isConfigTruthy(enabledRaw ?? 'false')) {
        return {
          summary: 'propose_takes skipped: cycle.propose_takes.enabled=false',
          details: {
            reason: 'disabled',
            enable_hint: 'gbrain config set cycle.propose_takes.enabled true',
            pages_scanned: 0,
            cache_hits: 0,
            cache_misses: 0,
            proposals_inserted: 0,
            tombstones_written: 0,
            budget_exhausted: false,
            warnings: [],
          },
          status: 'skipped',
        };
      }
    }

    const extractor = opts.extractor ?? defaultExtractor;
    const promptVersion = opts.promptVersion ?? PROPOSE_TAKES_PROMPT_VERSION;
    const pageLimit = opts.pageLimit ?? 100;
    const minPageChars = opts.minPageChars ?? PROPOSE_TAKES_MIN_PAGE_CHARS;
    const skipPagesWithFence = opts.skipPagesWithFence ?? false;
    // gbrain#4168: explicit test override wins; otherwise the REAL remaining
    // job budget (when the cycle threads deadlineAtMs) clamped to the derived
    // fallback. At the default installed-daemon interval the old 30-min
    // literal was bit-identical to the job timeout floor, and since this
    // phase starts after earlier phases, phase-elapsed always trailed
    // job-elapsed — the clean partial-exit below was unreachable and cycles
    // dead-lettered instead of banking work. Resolved to null = not enough
    // budget to start (see the honest-skip return after the provider probe).
    const resolvedDeadlineMs =
      opts.deadlineMs ?? resolveProposeTakesDeadlineMs(opts.deadlineAtMs, Date.now());
    const phaseStartMs = Date.now();
    const dryRun = ctx.dryRun || opts.dryRun === true;
    const proposalRunId = `propose-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}-${randomUUID().slice(0, 8)}`;

    const modelId = opts.model ?? getChatModel();

    // With the default (gateway) extractor, skip cheaply when the resolved
    // model's provider can't run — same probe semantics as patterns.ts /
    // think/index.ts: unknown provider/model or Anthropic-without-key skips;
    // other providers' auth surfaces lazily at chat() time. An injected
    // extractor bypasses the gateway, so it is never gated. (Takeover of
    // PR #1979's intent by @shawnduggan.)
    if (!opts.extractor) {
      const probe = probeChatModel(normalizeModelId(modelId));
      if (!probe.ok) {
        return {
          summary: `propose_takes skipped: ${probe.detail}`,
          details: {
            reason: 'no_provider',
            model: modelId,
            pages_scanned: 0,
            cache_hits: 0,
            cache_misses: 0,
            proposals_inserted: 0,
            budget_exhausted: false,
            warnings: [],
          },
          status: 'skipped',
        };
      }
    }

    // #4168 honest skip — placed AFTER the cheap provider probe (patterns.ts
    // ordering precedent) and BEFORE any rollup/DB write, matching the
    // no_provider skip: an insufficient-budget run records neither a halt
    // nor a completed round. On a brain where earlier phases eat the whole
    // job budget this fires EVERY cycle — the reason string and operator
    // hint are load-bearing observability, not decoration (a repeated-skip
    // doctor check is a filed follow-up).
    if (resolvedDeadlineMs === null) {
      return {
        summary:
          `propose_takes skipped: remaining cycle budget under ` +
          `${Math.round(MIN_PROPOSE_TAKES_BUDGET_MS / 1000)}s ` +
          `(reserve ${Math.round(CYCLE_DEADLINE_RESERVE_MS / 1000)}s) — earlier phases consumed ` +
          `the job budget; raise the autopilot interval or the autopilot-cycle handler anchor ` +
          `if this repeats every cycle. Next cycle retries with a fresh budget.`,
        details: {
          reason: 'insufficient_cycle_budget',
          // The job deadline is WHY the phase can't start — carry the same
          // flag the mid-run partial exit sets so dashboards see one signal.
          deadline_hit: true,
          pages_scanned: 0,
          cache_hits: 0,
          cache_misses: 0,
          proposals_inserted: 0,
          tombstones_written: 0,
          budget_exhausted: false,
          warnings: [],
        },
        status: 'skipped',
      };
    }
    const deadlineMs = resolvedDeadlineMs;

    const result: ProposeTakesResult = {
      pages_scanned: 0,
      cache_hits: 0,
      cache_misses: 0,
      proposals_inserted: 0,
      proposals_rejected_ungrounded: 0,
      tombstones_written: 0,
      empty_runs_written: 0,
      budget_exhausted: false,
      llm_calls_succeeded: 0,
      llm_calls_failed: 0,
      page_receipts_completed: 0,
      page_receipts_empty: 0,
      page_receipts_quality_rejected: 0,
      page_receipts_failed: 0,
      pages_rejected_sensitive: 0,
      models_used: [],
      rejection_reason_counts: {},
      warnings: [],
      deadline_hit: false,
    };

    // gbrain#4168: job budget already inside the reserve window — exit
    // cleanly before ANY work (the in-loop `elapsed > deadline` check can't
    // fire on the first iteration when the effective deadline is 0).
    if (deadlineMs <= 0) {
      result.warnings.push('phase skipped: job deadline already inside the reserve window');
      result.deadline_hit = true;
      return {
        summary: `propose_takes: skipped — job deadline inside the reserve window (run ${proposalRunId})`,
        details: { ...result, proposal_run_id: proposalRunId, prompt_version: promptVersion },
        status: 'warn' as PhaseStatus,
      };
    }

    // Load pages eligible for proposal. Source-scoped per BaseCyclePhase.
    const pages = await listCandidatePages(engine, scope, pageLimit, minPageChars);
    // Load once, before the loop and before any external call. A malformed or
    // unreadable operator scanner config throws and aborts the whole phase —
    // fail-closed is safer than sending even the first page unscanned.
    const sensitivityConfig = opts.sensitivityConfig ?? loadSensitivityConfig({
      workspaceRoot: opts.repoPath,
    });

    if (opts.reporter) {
      opts.reporter.start('propose_takes.pages' as never, pages.length);
    }

    // #3044 — shared halt policy: auth/billing halt on the first hit, a
    // rate_limit streak halts after RATE_LIMIT_HALT_STREAK consecutive
    // failures. A successful call resets the streak.
    const llmHalt = createGlobalLlmHaltTracker();

    for (const page of pages) {
      // Phase deadline check. Break (not throw) so the phase returns a
      // partial result with deadline_hit:true; work already banked stays.
      const elapsedMs = Date.now() - phaseStartMs;
      if (elapsedMs > deadlineMs) {
        result.warnings.push(
          `phase deadline hit at page ${result.pages_scanned}/${pages.length} ` +
          `after ${(elapsedMs / 1000).toFixed(0)}s (cap ${(deadlineMs / 1000).toFixed(0)}s); partial completion`,
        );
        result.deadline_hit = true;
        break;
      }

      result.pages_scanned += 1;
      this.tick(opts);

      // Skip pages that have NO prose body (e.g. metadata-only entity stubs).
      const body = page.compiled_truth ?? '';
      if (body.trim().length === 0) continue;
      if (skipPagesWithFence && hasCompleteFence(body)) continue;

      const ch = contentHash(body);
      const existingTakes = extractExistingTakesForDedup(body);

      // Successful per-page terminal receipts are the idempotency authority.
      // A partial legacy proposal insert without a terminal receipt must retry.
      const sourceId = page.source_id ?? scope.sourceId ?? 'default';
      const cached = await engine.executeRaw<{ id: number }>(
        `SELECT id FROM proposal_page_runs
         WHERE source_id = $1 AND page_slug = $2 AND source_hash = $3 AND prompt_version = $4
           AND status IN ('completed','empty')
         LIMIT 1`,
        [sourceId, page.slug, ch, promptVersion],
      );
      if (cached.length > 0) {
        result.cache_hits += 1;
        continue;
      }
      result.cache_misses += 1;

      // Full-source privacy boundary. Candidate-level scanning after the LLM
      // is too late: the raw page has already left the host. Findings expose
      // only stable detector families/fingerprints; receipts persist no match.
      const sensitivityFindings = scanSensitive(body, sensitivityConfig);
      if (sensitivityFindings.length > 0) {
        result.pages_rejected_sensitive += 1;
        result.warnings.push(
          `${page.slug}: skipped before LLM by deterministic sensitive-source scanner`,
        );
        if (!dryRun) {
          await writeProposalPageRun(engine, {
            sourceId, pageSlug: page.slug, sourceHash: ch, promptVersion,
            proposalRunId, modelId: 'deterministic:sensitivity-scan',
            status: 'quality_rejected', proposalCount: 0,
            evidenceSpanCount: 0, errorCode: 'sensitive_source',
            rejectionReasonCounts: { sensitive_source: sensitivityFindings.length },
          });
          result.page_receipts_quality_rejected += 1;
        }
        continue;
      }

      // Budget pre-check before the LLM call. Estimate: ~1500 input tokens + 500 output.
      const budget = this.checkBudget({
        modelId,
        estimatedInputTokens: 1500,
        maxOutputTokens: 500,
      });
      if (!budget.allowed) {
        result.budget_exhausted = true;
        result.warnings.push(
          `budget exhausted at page ${result.pages_scanned}/${pages.length} (cumulative $${budget.cumulativeCostUsd.toFixed(4)} / cap $${budget.budgetUsd.toFixed(2)})`,
        );
        break;
      }

      // Call the extractor. Per-page errors log a warning and continue —
      // UNLESS they classify as a whole-run condition (#3044): auth/billing
      // halts on the first hit (a revoked key or exhausted spend limit fails
      // identically on every remaining page); a bare rate_limit halts only
      // after RATE_LIMIT_HALT_STREAK consecutive hits (a burst 429 can clear
      // between pages).
      let proposals: ProposedTake[];
      try {
        proposals = await extractor({
          pagePath: page.slug,
          pageBody: body,
          existingTakes,
          modelHint: opts.model,
        });
      } catch (err) {
        result.llm_calls_failed += 1;
        if (!dryRun) {
          try {
            await writeProposalPageRun(engine, {
              sourceId, pageSlug: page.slug, sourceHash: ch, promptVersion,
              proposalRunId, modelId, status: 'failed', proposalCount: 0,
              evidenceSpanCount: 0, errorCode: 'extractor_error',
            });
            result.page_receipts_failed += 1;
          } catch (receiptErr) {
            result.warnings.push(
              `failed receipt write on ${page.slug}: ${receiptErr instanceof Error ? receiptErr.message : String(receiptErr)}`,
            );
          }
        }
        const msg = err instanceof Error ? err.message : String(err);
        const detail = `extractor failed on ${page.slug}: ${msg}`;
        const decision = llmHalt.observe(err);
        if (decision !== 'continue') {
          result.aborted_global_error = haltedClassOf(decision)!;
          result.warnings.push(
            `aborting phase at page ${result.pages_scanned}/${pages.length}: ` +
            `${llmHalt.note()} (${detail})`,
          );
          break;
        }
        result.warnings.push(detail);
        // #3763: N consecutive failures with ZERO successes = dead lane.
        // Halt instead of spending an LLM call on every remaining page. A
        // single success anywhere in the run keeps llm_calls_succeeded > 0
        // and permanently disarms this halt (mixed runs are per-page noise).
        if (
          result.llm_calls_succeeded === 0 &&
          result.llm_calls_failed >= EXTRACTOR_FAILURE_HALT_STREAK
        ) {
          result.aborted_failure_streak = true;
          result.warnings.push(
            `aborting phase at page ${result.pages_scanned}/${pages.length}: ` +
            `${result.llm_calls_failed} consecutive extractor failures with zero successes — ` +
            `halting to avoid re-billing every remaining page (no tombstones written; pages retry next cycle)`,
          );
          break;
        }
        continue;
      }
      result.llm_calls_succeeded += 1;
      llmHalt.reset();

      const actualModelId = (proposals as ProposeTakesExtraction).modelId ?? modelId;
      if (!result.models_used.includes(actualModelId)) result.models_used.push(actualModelId);

      const strictContractRejected = (proposals as ProposeTakesExtraction).contractRejectedCount ?? 0;
      const strictRejectionReasonCounts = (proposals as ProposeTakesExtraction).rejectionReasonCounts;
      mergeRejectionReasonCounts(result.rejection_reason_counts, strictRejectionReasonCounts);
      result.proposals_rejected_ungrounded += strictContractRejected;
      if (strictContractRejected > 0) {
        result.warnings.push(
          `${page.slug}: rejected ${strictContractRejected} row(s) without strict grounding/kind/semantic signal`,
        );
      }

      if ((proposals as ProposeTakesExtraction).qualityRejected === true) {
        result.warnings.push(
          `${page.slug}: extractor returned a clean JSON array but every row failed the strict claim/evidence/kind/semantic contract`,
        );
        if (!dryRun) {
          await writeProposalPageRun(engine, {
            sourceId, pageSlug: page.slug, sourceHash: ch, promptVersion,
            proposalRunId, modelId: actualModelId, status: 'quality_rejected', proposalCount: 0,
            evidenceSpanCount: 0, errorCode: 'invalid_claim_contract',
            rejectionReasonCounts: strictRejectionReasonCounts,
          });
          result.page_receipts_quality_rejected += 1;
        }
        continue;
      }

      const groundedByClaim = new Map<string, ProposedTake>();
      for (const proposal of proposals) {
        if (
          proposal.claim_text.length > 0 &&
          proposal.claim_text.length <= 200 &&
          (proposal.kind === 'take' || proposal.kind === 'bet') &&
          hasVerbatimEvidence(proposal, body)
        ) {
          groundedByClaim.set(proposal.claim_text, proposal);
        }
      }
      const grounded = [...groundedByClaim.values()];
      const rejectedUngrounded = proposals.length - grounded.length;
      result.proposals_rejected_ungrounded += rejectedUngrounded;
      if (rejectedUngrounded > 0) {
        incrementRejectionReason(result.rejection_reason_counts, 'post_parse_grounding', rejectedUngrounded);
        result.warnings.push(
          `${page.slug}: rejected ${rejectedUngrounded}/${proposals.length} proposal(s) without an exact evidence_span`,
        );
      }
      if (proposals.length > 0 && grounded.length === 0) {
        if (!dryRun) {
          await writeProposalPageRun(engine, {
            sourceId, pageSlug: page.slug, sourceHash: ch, promptVersion,
            proposalRunId, modelId: actualModelId, status: 'quality_rejected', proposalCount: 0,
            evidenceSpanCount: 0, errorCode: 'ungrounded_evidence',
            rejectionReasonCounts: { post_parse_grounding: rejectedUngrounded },
          });
          result.page_receipts_quality_rejected += 1;
        }
        continue;
      }

      // Dry-run performs selection, extraction, and validation, but writes no
      // proposals, page receipts, aggregate receipts, or rollup rows.
      if (dryRun) continue;

      // Publish every page atomically: either all grounded proposal rows and
      // the successful terminal receipt commit, or neither does.
      let insertedForPage = 0;
      try {
        await engine.transaction(async (tx) => {
          for (const p of grounded) {
            const inserted = await tx.executeRaw<{ id: number }>(
              `INSERT INTO take_proposals
                 (source_id, page_slug, content_hash, source_hash, prompt_version, proposal_run_id,
                  claim_text, kind, holder, weight, domain, evidence_span,
                  dedup_against_fence_rows, model_id)
               VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
               ON CONFLICT (source_id, page_slug, content_hash, prompt_version, md5(claim_text)) DO NOTHING
               RETURNING id`,
              [sourceId, page.slug, ch, promptVersion, proposalRunId, p.claim_text,
                p.kind, p.holder, p.weight, p.domain ?? null, p.evidence_span!.trim(),
                JSON.stringify(existingTakes), actualModelId],
            );
            insertedForPage += inserted.length;
          }

          await writeProposalPageRun(tx, {
            sourceId, pageSlug: page.slug, sourceHash: ch, promptVersion,
            proposalRunId, modelId: actualModelId, status: proposals.length === 0 ? 'empty' : 'completed',
            proposalCount: insertedForPage, evidenceSpanCount: grounded.length,
            rejectionReasonCounts: strictRejectionReasonCounts,
          });
        });
      } catch (err) {
        try {
          await writeProposalPageRun(engine, {
            sourceId, pageSlug: page.slug, sourceHash: ch, promptVersion,
            proposalRunId, modelId, status: 'failed', proposalCount: 0,
            evidenceSpanCount: 0, errorCode: 'publication_error',
          });
          result.page_receipts_failed += 1;
        } catch { /* original publication error remains the primary signal */ }
        result.warnings.push(
          `atomic proposal publication failed on ${page.slug}: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      result.proposals_inserted += insertedForPage;
      if (proposals.length === 0) {
        result.empty_runs_written += 1;
        result.page_receipts_empty += 1;
      } else {
        result.page_receipts_completed += 1;
      }
    }

    if (opts.reporter) opts.reporter.finish();

    // v0.42 Wave B3: receipt + rollup for propose_takes. Source-scoped
    // via the read scope. Receipt only when proposals actually written.
    const sourceIdForReceipt = scope.sourceId ?? 'default';
    if (!dryRun && result.proposals_inserted > 0) {
      try {
        await writeReceipt(engine, {
          kind: 'takes.proposed',
          source_id: sourceIdForReceipt,
          run_id: proposalRunId,
          round: 'single',
          extracted_at: new Date().toISOString(),
          total_rows: result.proposals_inserted,
          cost_usd: 0, // tracker isn't exposed at this layer; cost tracked centrally
          summary:
            `Proposed ${result.proposals_inserted} new takes from ${result.pages_scanned} pages ` +
            `(${result.cache_hits} cached).`,
        });
      } catch (err) {
        console.error(`[propose_takes] receipt write failed: ${(err as Error).message}`);
      }
    }
    // A deadline-hit run halted mid-list the same way a budget-exhausted one
    // does — record it as a halt, not a completed round. A global-error
    // abort (#3044) is the same posture: the round did not complete.
    const halted =
      result.budget_exhausted ||
      result.deadline_hit === true ||
      result.aborted_global_error !== undefined ||
      result.aborted_failure_streak === true;
    if (!dryRun) {
      await upsertExtractRollup(engine, {
        kind: 'takes.proposed',
        source_id: sourceIdForReceipt,
        round_completed_delta: halted ? 0 : 1,
        halt_delta: halted ? 1 : 0,
      });
    }

    // Status folds warnings in (the extract_facts precedent from #1928): a
    // run with swallowed per-page failures must not read as a clean 'ok'.
    // Severity split (#3044): a global halt with ZERO successful extractor
    // calls means the whole LLM lane is down — that is a phase 'fail', not a
    // 'warn' (deriveStatus turns one failed phase into a 'partial' cycle;
    // the autopilot handler deliberately does not throw on partial). A halt
    // after some successes is a partial run → 'warn'.
    const warningCount = result.warnings.length;
    // #3763: an all-failures streak halt is the same severity as a
    // zero-success global halt — the whole extractor lane is down.
    const phaseFailed =
      (result.aborted_global_error !== undefined && result.llm_calls_succeeded === 0) ||
      result.aborted_failure_streak === true;
    return {
      summary:
        `propose_takes: scanned ${result.pages_scanned} pages, ${result.cache_hits} cached, ${result.proposals_inserted} grounded proposals, ` +
        `${result.proposals_rejected_ungrounded} ungrounded rejected, ${result.pages_rejected_sensitive} sensitive skipped, ` +
        `${result.empty_runs_written} empty (run ${proposalRunId})` +
        (result.aborted_global_error
          ? `; aborted on ${result.aborted_global_error} error after ${result.pages_scanned} page(s)`
          : '') +
        (result.aborted_failure_streak
          ? `; aborted after ${result.llm_calls_failed} consecutive extractor failures (zero successes)`
          : '') +
        (warningCount > 0 ? ` (${warningCount} warning(s))` : ''),
      details: { ...result, halted, proposal_run_id: proposalRunId, prompt_version: promptVersion },
      status: phaseFailed ? 'fail' : halted || warningCount > 0 ? 'warn' : 'ok',
    };
  }
}

/**
 * Public entry point — mirrors the v0.23 `runPhaseSynthesize` shape so the
 * cycle orchestrator in cycle.ts can call it uniformly.
 */
export async function runPhaseProposeTakes(
  ctx: OperationContext,
  opts: ProposeTakesOpts = {},
) {
  return new ProposeTakesPhase().run(ctx, opts);
}

/** Test-only access to the class for subclassing in tests. */
export const __testing = {
  ProposeTakesPhase,
  parseExtractorOutput,
  contentHash,
  hasCompleteFence,
  extractExistingTakesForDedup,
  listCandidatePages,
};
