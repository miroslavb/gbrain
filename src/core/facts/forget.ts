/**
 * Forget records a durable, source- and visibility-scoped withdrawal together
 * with its canonical Markdown/page projection when a writable fence exists. Reimport and facts-index reconstruction cannot
 * silently reactivate the same normalized claim while that record exists.
 *
 * With a writable source file, strike the row, set valid_until and append the
 * reason atomically. Without a file, retain the same withdrawal and best-effort
 * DB-body strike. Imports overlay stale matching fence rows before chunking.
 * These are retractions: original prose, files and backups may retain text.
 * A Markdown-only clone does not carry DB-only withdrawal records.
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';

import { relative } from 'node:path';
import { rollbackFactFile } from './file-rollback.ts';
import { factPageProjection, projectFactPageBody } from './page-projection.ts';
import type { BrainEngine } from '../engine.ts';
import { withPageLock } from '../page-lock.ts';
import { assertSourceFilesystemActive, hasSourceFilesystemLock, withSourceFilesystemLock } from '../minions/source-filesystem.ts';
import { resolvePageWriteTarget } from '../write-through.ts';
import { parseFactsFence, renderFactsTable, type ParsedFact } from '../facts-fence.ts';
import { parseMarkdown } from '../markdown.ts';
import { contentHash } from '../utils.ts';
import { recordFactWithdrawal, recordFactWithdrawalInTransaction } from './withdrawal.ts';

export interface ForgetFactResult {
  /** True iff the row was found AND a forget was applied (fence or DB). */
  ok: boolean;
  /** Discriminator on the path that handled the forget. */
  path: 'fence' | 'legacy_db' | 'not_found' | 'already_expired';
  /** Human-readable reason captured in `context`; mirrors back what was written. */
  reason: string;
}

interface FactDbRow {
  id: string;
  source_id: string;
  entity_slug: string | null;
  row_num: number | null;
  source_markdown_slug: string | null;
  expired_at: Date | null;
  visibility: string;
}

interface SourceRow {
  id: string;
  local_path: string | null;
}

/** Format today's date as 'YYYY-MM-DD' UTC. Matches extract-from-fence's helper. */
function todayUtc(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    .toISOString().slice(0, 10);
}

const FENCE_BEGIN = '<!--- gbrain:facts:begin -->';
const FENCE_END = '<!--- gbrain:facts:end -->';

/**
 * Strike fence row `rowNum` inside `body`: strikethrough on the claim
 * (already-struck rows stay struck), valid_until = today, `forgotten:
 * <reason>` appended to context (preserving any existing context). Returns
 * the rewritten body, or null when the fence lacks the row (DB drifted from
 * markdown) or its markers — callers fall back to a DB-only expire.
 */
function strikeFenceRow(body: string, rowNum: number, reason: string, today: string): string | null {
  const parsed = parseFactsFence(body);
  const target = parsed.facts.find(f => f.rowNum === rowNum);
  if (!target) return null;
  const existingContext = target.context?.trim() ?? '';
  const newContext = existingContext
    ? `${existingContext} | forgotten: ${reason}`
    : `forgotten: ${reason}`;
  const updated: ParsedFact[] = parsed.facts.map(f =>
    f.rowNum === rowNum
      ? { ...f, active: false, validUntil: today, context: newContext, forgotten: true }
      : f,
  );
  const begin = body.indexOf(FENCE_BEGIN);
  const end = body.indexOf(FENCE_END, begin + 1);
  if (begin === -1 || end === -1) return null;
  return body.slice(0, begin) + renderFactsTable(updated) + body.slice(end + FENCE_END.length);
}

/**
 * Forget a fact by id. Routes through the fence when the row carries
 * v51 columns + the source has a local_path; falls through to legacy
 * DB-body mirroring otherwise. Idempotent: returns `already_expired` when
 * the row's `expired_at` is already non-null.
 *
 * Reason defaults to `'forgotten'` when the caller doesn't provide one
 * (matches the existing `gbrain forget` CLI which takes no reason
 * argument). MCP `forget_fact` op can pass a more specific reason
 * when the user provides it.
 */
export async function forgetFactInFence(
  engine: BrainEngine,
  factId: number,
  opts: {
    reason?: string;
    /**
     * MEMORY_VERBS v1 trust boundary [ship P1.1]: when set, the fact must
     * belong to this source or the call returns `not_found` (indistinguishable
     * from a truly-missing id — no cross-source existence leak). The `forget`
     * verb passes ctx.sourceId so a remote caller scoped to source A cannot
     * expire facts in source B by guessing global ids.
     */
    sourceId?: string;
    /**
     * When true (remote callers), the fact must be visibility='world' or the
     * call returns `not_found` — a remote caller can't expire private facts it
     * could never read (mirrors recall's remote posture).
     */
    worldOnly?: boolean;
  } = {},
): Promise<ForgetFactResult> {
  const reason = opts.reason ?? 'forgotten';
  const today = todayUtc();

  const rows = await engine.executeRaw<FactDbRow>(
    `SELECT id, source_id, entity_slug, row_num, source_markdown_slug, expired_at, visibility
       FROM facts WHERE id = $1`,
    [factId],
  );
  // Trust-boundary scope check BEFORE any state inspection: a row outside the
  // caller's source (or private, for remote callers) is reported as not_found,
  // never distinguished from a missing id.
  if (rows.length === 1) {
    const r = rows[0];
    const outOfScope =
      (opts.sourceId !== undefined && r.source_id !== opts.sourceId) ||
      (opts.worldOnly === true && r.visibility !== 'world');
    if (outOfScope) {
      return { ok: false, path: 'not_found', reason };
    }
  }
  if (rows.length === 0) {
    return { ok: false, path: 'not_found', reason };
  }
  const row = rows[0];

  if (row.expired_at !== null) {
    return { ok: false, path: 'already_expired', reason };
  }

  // Mirror the retraction in the page body. The withdrawal record protects
  // active facts even if this best-effort mirror fails or a stale file returns.
  const strikeDbBody = async (): Promise<void> => {
    if (row.row_num === null || row.source_markdown_slug === null) return;
    const slug = row.source_markdown_slug;
    const page = await engine.getPage(slug, { sourceId: row.source_id });
    if (!page) return;
    const struck = strikeFenceRow(page.compiled_truth ?? '', row.row_num, reason, today);
    if (struck === null) return;
    // The FILE was not rewritten on this tier, so the row must NOT keep the
    // importer's hash: sync would see file == row and skip, leaving
    // content_chunks with the live claim for good. A row-shaped hash over the
    // struck body can never equal the unchanged file's, so the next sync
    // re-imports + re-chunks through the withdrawal overlay.
    await engine.refreshPageBody(slug, row.source_id, struck, page.timeline ?? '',
      contentHash({ ...page, compiled_truth: struck }));
  };

  // DB-only path: the withdrawal remains authoritative during reimport.
  // The DB-body strike is a read-modify-write on pages.compiled_truth, so it
  // holds the same per-page lock the fence writers do (`locked` = the fence
  // tier is calling from inside its own withPageLock).
  const legacyExpire = async (locked = false): Promise<ForgetFactResult> => {
    await recordFactWithdrawal(engine, factId, row.source_id, opts.worldOnly === true);
    const ok = true;
    if (ok && row.source_markdown_slug !== null) {
      const slug = row.source_markdown_slug;
      await (locked ? strikeDbBody() : withPageLock(slug, strikeDbBody, { timeoutMs: 5_000 }))
        .catch(() => { /* best-effort, see above */ });
    }
    return { ok, path: 'legacy_db', reason };
  };

  // Fence path requires: v51 columns set + source.local_path set.
  const canFence =
    row.row_num !== null &&
    row.source_markdown_slug !== null &&
    row.entity_slug !== null;

  if (!canFence) return legacyExpire();

  // Look up source.local_path.
  const sources = await engine.executeRaw<SourceRow>(
    `SELECT id, local_path FROM sources WHERE id = $1 LIMIT 1`,
    [row.source_id],
  );
  const localPath = sources[0]?.local_path ?? null;
  if (!localPath) return legacyExpire();

  const slug = row.source_markdown_slug!;
  const targetRowNum = row.row_num!;
  // #4204: resolve the fence file the same way writeFactsToFence /
  // writePageThrough do (recorded source_path preference, own-local_path
  // root). A bare `join(localPath, slug.md)` misses fences that live in a
  // human-named vault file, degrading forget to a DB-only expire while the
  // fence keeps the live row for the next absorb to resurrect.
  const resolved = await resolvePageWriteTarget(engine, slug, row.source_id);
  if (!resolved.ok) return legacyExpire();
  // Hold the source lock before canonical file work; commit withdrawal and
  // page projection together so a failed projection remains retryable.
  const mirrorWithdrawal = async (): Promise<ForgetFactResult> => {
    const filePath = resolved.filePath;
    const tmpPath = `${filePath}.tmp`;

    if (!existsSync(filePath)) {
      // File deleted out from under us — only the DB has the row.
      // Legacy path is the safe behavior; the operator can fix the
      // tree mismatch separately.
      return legacyExpire();
    }

    return withPageLock(slug, async () => {
      const body = readFileSync(filePath, 'utf-8');
      // Fence missing the row (DB drifted from markdown) or its markers (race /
      // corruption): fall through to legacy expire so the user's intent
      // succeeds; doctor surfaces the drift separately.
      const newBody = strikeFenceRow(body, targetRowNum, reason, today);
      if (newBody === null) return legacyExpire(true);

      // Atomic .tmp + parse-validate + rename.
      assertSourceFilesystemActive();
      writeFileSync(tmpPath, newBody, 'utf-8');
      const tmpBody = readFileSync(tmpPath, 'utf-8');
      const validate = parseFactsFence(tmpBody);
      if (validate.warnings.length > 0) {
        // Quarantine .tmp; leave the canonical file alone; fall back to
        // DB expire so the user's forget intent still succeeds.
        return legacyExpire(true);
      }
      renameSync(tmpPath, filePath);

      // Commit durable withdrawal and final page projection atomically.
      // A failure rolls back withdrawal plus only our own file bytes.
      try {
        await engine.transaction(async tx => {
          await recordFactWithdrawalInTransaction(tx, factId, row.source_id, opts.worldOnly === true);
          await tx.executeRaw(
            `UPDATE facts SET valid_until = $1
             WHERE id = $2 AND source_id = $3`,
            [today, factId, row.source_id],
          );
          await projectFactPageBody((sql, params) => tx.executeRaw(sql, params), row.source_id,
            factPageProjection(newBody, slug, relative(localPath, filePath)));
          // Preserve an existing index stamp, but never leave a legacy NULL or
          // empty hash looking like a completed body projection.
          await tx.executeRaw(
            "UPDATE pages SET content_hash=COALESCE(NULLIF(content_hash,''),$3) WHERE source_id=$1 AND slug=$2",
            [row.source_id, slug, contentHash(parseMarkdown(body, slug + '.md'))],
          );
        });
      } catch (error) {
        rollbackFactFile(filePath, newBody, body);
        throw error;
      }

      return { ok: true, path: 'fence', reason };
    }, { timeoutMs: 5_000 });
  };
  return hasSourceFilesystemLock(resolved.writeRoot)
    ? mirrorWithdrawal()
    : withSourceFilesystemLock(engine, resolved.writeRoot, mirrorWithdrawal);
}
