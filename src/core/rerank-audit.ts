/**
 * v0.35.0.0+ — rerank-failure audit trail.
 *
 * Writes warn-severity rows to `~/.gbrain/audit/rerank-failures-YYYY-Www.jsonl`
 * (ISO-week rotation, mirrors slug-fallback-audit.ts). Fired when
 * `applyReranker` in src/core/search/rerank.ts catches a RerankError from
 * the gateway. Failure is fail-open at the search layer (results pass
 * through in RRF order); the audit row is the cross-process signal that
 * `gbrain doctor reranker_health` reads.
 *
 * Ordinary success events are intentionally NOT logged here. A bounded
 * recovery marker is written only when a later real rerank proves that one
 * or more earlier failures are no longer current. This preserves the
 * rare-event-only posture without making doctor warn forever on history.
 * The doctor check reads `search.reranker.enabled` first to interpret
 * "no events in window" correctly (enabled + no events = healthy;
 * disabled = no failures expected).
 *
 * Best-effort writes. Write failures go to stderr but search continues.
 *
 * v0.40.4.0: internals delegate to the shared `src/core/audit/audit-writer.ts`
 * primitive. Public API (logRerankFailure, readRecentRerankFailures,
 * computeRerankAuditFilename) preserved bit-for-bit for the existing test
 * suite at `test/rerank-audit.test.ts`.
 */

import { createAuditWriter, computeIsoWeekFilename } from './audit/audit-writer.ts';

/** Stable error-classification union for reranker fail-open audit rows.
 * `sunset_short_circuit` (#3657) is written ONCE per process per model by the
 * gateway itself (not per query by applyReranker): the reranker's hosted API
 * passed its announced shutdown date, so calls are skipped without HTTP and
 * results pass through unreranked. */
export type RerankFailureReason =
  | 'auth'
  | 'rate_limit'
  | 'network'
  | 'timeout'
  | 'budget'
  | 'payload_too_large'
  | 'sunset_short_circuit'
  | 'unknown';

export interface RerankFailureEvent {
  ts: string;
  /** Provider:model — e.g. `'zeroentropyai:zerank-2'`. */
  model: string;
  /** Classified failure mode (see RerankFailureReason). */
  reason: RerankFailureReason;
  /** SHA-256 prefix of the rerank query (8 hex chars). Privacy: never log
   *  query text. Lets doctor dedupe repeat failures on the same query. */
  query_hash: string;
  /** Number of documents that were being reranked when failure fired. */
  doc_count: number;
  /**
   * Truncated upstream error message (first 200 chars). Useful for
   * diagnosing flaky providers without leaking PII; query text is hashed
   * separately so this string never carries it.
   */
  error_summary: string;
  /** Always 'warn' — matches RerankError's "all failures degrade UX". */
  severity: 'warn';
}

export interface RerankRecoveryEvent {
  ts: string;
  /** Must match the failed provider:model before it can clear that signal. */
  model: string;
  /** Successful document count. Capacity failures require >= failed count. */
  doc_count: number;
  severity: 'info';
}

/** ISO-week-rotated filename: `rerank-failures-YYYY-Www.jsonl`. */
export function computeRerankAuditFilename(now: Date = new Date()): string {
  return computeIsoWeekFilename('rerank-failures', now);
}

/** ISO-week-rotated filename: `rerank-recoveries-YYYY-Www.jsonl`. */
export function computeRerankRecoveryFilename(now: Date = new Date()): string {
  return computeIsoWeekFilename('rerank-recoveries', now);
}

/**
 * Truncate a string for audit logging. Plain length cut — error messages
 * from the gateway are already free of caller-controlled prefixes.
 */
function truncateErrorSummary(msg: string, max = 200): string {
  if (msg.length <= max) return msg;
  return msg.slice(0, max - 1) + '…';
}

const writer = createAuditWriter<RerankFailureEvent>({
  featureName: 'rerank-failures',
  errorLabel: 'gbrain',
  errorMessagePrefix: 'rerank-failure audit ',
  errorTrailer: '; search continues',
});

const recoveryWriter = createAuditWriter<RerankRecoveryEvent>({
  featureName: 'rerank-recoveries',
  errorLabel: 'gbrain',
  errorMessagePrefix: 'rerank-recovery audit ',
  errorTrailer: '; search continues',
});

/**
 * Append a rerank-failure event. Best-effort: write failure logs to stderr
 * but never throws.
 */
export function logRerankFailure(event: Omit<RerankFailureEvent, 'ts' | 'severity'>): void {
  writer.log({
    severity: 'warn',
    ...event,
    error_summary: truncateErrorSummary(event.error_summary),
  } as Omit<RerankFailureEvent, 'ts'>);
}

/**
 * Read recent (`days` window, default 7) rerank-failure events. Used by
 * `gbrain doctor`'s `reranker_health` check. Missing file / corrupt rows
 * are skipped silently — the audit trail is informational.
 */
export function readRecentRerankFailures(days = 7, now: Date = new Date()): RerankFailureEvent[] {
  return writer.readRecent(days, now);
}

/** Append a rare recovery marker after a real production rerank succeeds. */
export function logRerankRecovery(event: Omit<RerankRecoveryEvent, 'ts' | 'severity'>): void {
  recoveryWriter.log({ severity: 'info', ...event } as Omit<RerankRecoveryEvent, 'ts'>);
}

export function readRecentRerankRecoveries(days = 7, now: Date = new Date()): RerankRecoveryEvent[] {
  return recoveryWriter.readRecent(days, now);
}

/**
 * Old llama.cpp physical-batch failures landed as network/unknown before the
 * gateway learned that error dialect. Normalize them at read time so old
 * evidence remains useful without rewriting the append-only audit trail.
 */
export function normalizedRerankFailureReason(event: RerankFailureEvent): RerankFailureReason {
  if (
    event.reason !== 'budget' &&
    /physical[- ]batch|input[_ -]?too[_ -]?large|payload[_ -]?too[_ -]?large|context[^\n]{0,40}too large/i.test(
      event.error_summary ?? '',
    )
  ) {
    return 'payload_too_large';
  }
  return event.reason;
}

/** Return only failures that have no qualifying later same-model recovery. */
export function unrecoveredRerankFailures(
  failures: RerankFailureEvent[],
  recoveries: RerankRecoveryEvent[],
): RerankFailureEvent[] {
  return failures.filter((failure) => {
    const reason = normalizedRerankFailureReason(failure);
    // A successful wire call says nothing about exhausted or missing pricing.
    if (reason === 'budget') return true;
    const failureAt = Date.parse(failure.ts);
    return !recoveries.some((recovery) => {
      if (recovery.model !== failure.model) return false;
      const recoveryAt = Date.parse(recovery.ts);
      if (!Number.isFinite(failureAt) || !Number.isFinite(recoveryAt) || recoveryAt <= failureAt) return false;
      return reason !== 'payload_too_large' || recovery.doc_count >= failure.doc_count;
    });
  });
}

// stderr label "gbrain" + qualifier "rerank-failure audit " preserve the
// pre-v0.40.4 message byte-for-byte:
//
//   `[gbrain] rerank-failure audit write failed (${msg}); search continues`
//
// The `errorMessagePrefix` option on createAuditWriter restores the
// qualifier that would otherwise be dropped by the refactor. Operators
// grepping logs for "rerank-failure audit write failed" keep working.
