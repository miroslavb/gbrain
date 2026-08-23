/**
 * v0.32.7 CJK wave — `gbrain reindex --markdown` sweep.
 *
 * Walks markdown pages whose `chunker_version` is below
 * MARKDOWN_CHUNKER_VERSION and re-imports each through the standard
 * `importFromFile` / `importFromContent` path. Bumps `chunker_version` on
 * success so re-runs are idempotent and a partial sweep can resume.
 *
 * Driven by:
 *   - `gbrain upgrade` post-upgrade hook (after the cost-estimate prompt).
 *   - Operators running `gbrain reindex --markdown` directly.
 *
 * Performance: batched 100 at a time so a 50K-page brain reindex doesn't
 * hold a single transaction open. `--limit` caps total work for triage
 * runs; `--dry-run` reports the count without writing.
 *
 * Codex outside-voice C2 — the original PR #599 `MARKDOWN_CHUNKER_VERSION`
 * fold into content_hash was a no-op because `performSync` only re-imports
 * files whose content actually changed, not files whose hash WOULD change
 * if recomputed. This sweep + the migration v54 column are how the bump
 * actually reaches existing markdown pages.
 */

import type { BrainEngine } from '../core/engine.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { MARKDOWN_CHUNKER_VERSION } from '../core/chunkers/recursive.ts';
import { importFromContent, importFromFile } from '../core/import-file.ts';
import { serializeMarkdown } from '../core/markdown.ts';
import { createProgress } from '../core/progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';
import { existsSync } from 'fs';
import { resolve } from 'path';
// v0.41.15.0 (T10, D9): per-batch parallel workers.
import { runSlidingPool } from '../core/worker-pool.ts';
import { resolveWorkersWithClamp } from '../core/sync-concurrency.ts';
import {
  buildReindexScopeSql,
  normalizeReindexPrefix,
  normalizeRetrievedSince,
  reindexScopeLabel,
  toReindexHotCursor,
  type ReindexHotCursor,
  type ReindexScope,
} from './reindex-scope.ts';

interface ReindexOpts {
  /** Cap total pages reindexed. Useful for triage runs on huge brains. */
  limit?: number;
  /** Report would-do count; don't actually reindex. */
  dryRun?: boolean;
  /** Emit JSON envelope on stdout. */
  json?: boolean;
  /** Brain repo path (for reading source files). Falls back to sync.repo_path config or process.cwd(). */
  repoPath?: string;
  /**
   * Skip the embedding call during re-chunk. New chunks land with NULL
   * embedding and the next `gbrain embed --stale` pass fills them in.
   * Useful for offline / no-API-key brains and for tests.
   */
  noEmbed?: boolean;
  /** Optional open-world page type scope, e.g. atom. */
  type?: string;
  /** Restrict markdown rows to one federated source. */
  sourceId?: string;
  /** Restrict markdown rows to one canonical slug prefix. */
  prefix?: string;
  /** Include only pages retrieved on/after this UTC day. */
  retrievedSince?: string;
  /** Prioritize recently retrieved, then recently updated pages. */
  hotFirst?: boolean;
  /**
   * v0.41.15.0 (T10, D9): in-process per-batch parallel workers.
   * Default 1. PGLite clamps to 1. Recommended 4-8 for large brains.
   * Each worker calls importFromFile / importFromContent independently;
   * the counters (reindexed/skipped/failed) are JS-single-thread atomic.
   */
  workers?: number;
}

export interface ReindexResult {
  pending: number;
  pendingAfter: number;
  reindexed: number;
  skipped: number;
  failed: number;
  dryRun: boolean;
  chunkerVersion: number;
  type: string | null;
  sourceId: string | null;
  prefix: string | null;
  retrievedSince: string | null;
  hotFirst: boolean;
}

function emptyReindexResult(
  dryRun: boolean,
  scope: Partial<ReindexScope> & { hotFirst?: boolean } = {},
): ReindexResult {
  return {
    pending: 0,
    pendingAfter: 0,
    reindexed: 0,
    skipped: 0,
    failed: 0,
    dryRun,
    chunkerVersion: MARKDOWN_CHUNKER_VERSION,
    type: scope.type ?? null,
    sourceId: scope.sourceId ?? null,
    prefix: scope.prefix ?? null,
    retrievedSince: scope.retrievedSince ?? null,
    hotFirst: scope.hotFirst === true,
  };
}

// #3686: real usage, reachable via `gbrain reindex --help` (the generic
// one-line CLI_ONLY stub used to shadow every target flag). The --multimodal
// flags are parsed by the cli.ts dispatcher (reindex-multimodal routing) but
// documented here so the whole surface lives in one block.
const REINDEX_HELP = `gbrain reindex — re-chunk / re-embed existing pages after a pipeline upgrade

USAGE
  gbrain reindex --markdown   [--type PAGE_TYPE] [--source ID] [--prefix SLUG_PREFIX]
                              [--retrieved-since YYYY-MM-DD] [--hot-first]
                              [--limit N] [--workers N] [--dry-run] [--no-embed] [--json] [--repo PATH]
  gbrain reindex --multimodal [--limit N] [--workers N] [--dry-run] [--cost-estimate] [--no-embed] [--yes] [--json]
  gbrain reindex --aliases    [--limit N] [--dry-run] [--json] [--source <id>]

TARGETS (exactly one required)
  --markdown        Re-chunk markdown pages whose chunker_version lags the
                    current chunker (or whose contextual-retrieval state is
                    unset when embedding is on).
  --multimodal      Re-embed image/PDF chunks through the multimodal
                    embedding pipeline (Voyage batches).
  --aliases         Backfill the free-text alias layer (page_aliases) for
                    pages whose frontmatter aliases predate the projection.

OPTIONS
  --type <t>        --markdown only: restrict to one page type
  --source <id>     --markdown/--aliases: restrict to one source
  --prefix <slug>   --markdown only: restrict to an exact slug subtree
  --retrieved-since <YYYY-MM-DD>
                    --markdown only: include pages retrieved since UTC day
  --hot-first       --markdown only: newest retrieval, then update, then id
  --limit N         Cap pages/chunks processed this run
  --workers N       --markdown/--multimodal: parallel work per batch
                    (--concurrency is an alias)
  --dry-run         Report what would change; write nothing
  --cost-estimate   --multimodal only: print the embed cost estimate and stop
  --no-embed        Skip re-embedding (chunk-only reindex)
  --yes             --multimodal only: skip the cost confirm
  --repo PATH       --markdown only: brain repo override
  --json            Machine-readable output
  --help, -h        Show this help

Related: \`gbrain reindex-code --help\`, \`gbrain reindex-frontmatter --help\`,
\`gbrain reindex-search-vector --help\`.
`;

export function printReindexHelp(): void {
  console.log(REINDEX_HELP);
}

const REINDEX_VALUE_FLAGS = new Set([
  '--type', '--source', '--prefix', '--retrieved-since', '--limit', '--repo', '--workers', '--concurrency',
]);

export function normalizeReindexArgs(args: string[]): string[] {
  return args.flatMap((arg) => {
    const equals = arg.indexOf('=');
    if (equals <= 0) return [arg];
    const flag = arg.slice(0, equals);
    return REINDEX_VALUE_FLAGS.has(flag) ? [flag, arg.slice(equals + 1)] : [arg];
  });
}

function parsePageType(raw: string | undefined): string | null {
  // PageType is open-world at runtime. Only reject an absent/empty value or a
  // following CLI flag; SQL receives the exact remaining value as a bind.
  if (raw == null || raw.trim().length === 0 || raw.trimStart().startsWith('--')) return null;
  return raw;
}

export function validateReindexModeScope(args: string[]): string | null {
  args = normalizeReindexArgs(args);
  const markdownOnly = ['--type', '--prefix', '--retrieved-since', '--hot-first']
    .find((flag) => args.includes(flag));
  if (args.includes('--multimodal') && (markdownOnly || args.includes('--source'))) {
    return `${markdownOnly ?? '--source'} is not supported with reindex --multimodal`;
  }
  if (args.includes('--aliases') && markdownOnly) {
    return `${markdownOnly} is only supported with reindex --markdown, not --aliases`;
  }
  return null;
}

function invalidPositiveIntegerFlag(args: string[], flag: string): boolean {
  return args.some((arg, index) => {
    if (arg !== flag) return false;
    const raw = args[index + 1];
    return raw == null || raw.startsWith('--') || !/^\d+$/.test(raw) || Number(raw) <= 0;
  });
}

function invalidRequiredValueFlag(args: string[], flag: string): boolean {
  return args.some((arg, index) => {
    if (arg !== flag) return false;
    const raw = args[index + 1];
    return raw == null || raw.trim().length === 0 || raw.startsWith('--');
  });
}

function parseArgs(args: string[]): ReindexOpts {
  const out: ReindexOpts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--markdown') continue; // routing flag, no value
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--json') out.json = true;
    else if (a === '--no-embed') out.noEmbed = true;
    else if (a === '--limit') {
      const v = parseInt(args[++i] ?? '', 10);
      if (Number.isFinite(v) && v > 0) out.limit = v;
    } else if (a === '--repo') {
      out.repoPath = args[++i];
    } else if (a === '--type') {
      const type = parsePageType(args[++i]);
      if (type) out.type = type;
    } else if (a === '--source') {
      out.sourceId = args[++i];
    } else if (a === '--prefix') {
      const prefix = normalizeReindexPrefix(args[++i]);
      if (prefix) out.prefix = prefix;
    } else if (a === '--retrieved-since') {
      const since = normalizeRetrievedSince(args[++i]);
      if (since) out.retrievedSince = since;
    } else if (a === '--hot-first') {
      out.hotFirst = true;
    } else if (a === '--workers' || a === '--concurrency') {
      // v0.41.15.0 (T10, D9): per-batch parallel workers.
      const v = parseInt(args[++i] ?? '', 10);
      if (Number.isFinite(v) && v >= 1) out.workers = v;
    }
  }
  return out;
}

/**
 * Count markdown pages that need re-embedding. v0.40.3.0: predicate
 * extends from chunker_version drift alone to ALSO catch contextual
 * retrieval state drift (D26 P0-1). A page enters the sweep if either:
 *
 *   (a) chunker_version is below the current value — pre-v40 pages that
 *       haven't been touched by the wrapper bump yet
 *   (b) contextual_retrieval_mode is NULL — pages that have never been
 *       evaluated against the CR ladder (pre-v40 brains)
 *
 * D26 P0-4 IS DISTINCT FROM is used where comparing against a value; for
 * NULL detection we use IS NULL directly. Page-frontmatter overrides
 * (D5) are handled at re-import time: importFromFile re-parses the
 * frontmatter and the resolver picks the right tier for that page.
 *
 * Global-mode-vs-stamped-mode drift (e.g. user upgraded balanced→tokenmax,
 * skipped the post-upgrade prompt, then later ran reindex) is caught by
 * the IS NULL clause for pre-v81 brains AND by a future T10 mode-switch
 * hook for post-v81 brains. The simple `chunker_version OR mode IS NULL`
 * predicate covers the headline upgrade case the wave is shipping.
 */
async function countPending(engine: BrainEngine, scope: ReindexScope, noEmbed = false): Promise<number> {
  const scoped = buildReindexScopeSql(scope, noEmbed);
  const rows = await engine.executeRaw<{ count: string | number }>(
    `SELECT COUNT(*)::bigint AS count
       FROM pages
      WHERE ${scoped.where}`,
    scoped.params,
  );
  return Number(rows[0]?.count ?? 0);
}

/**
 * Read a single batch of pending rows. Ordered by id so re-runs after
 * partial completion pick up where they left off without re-doing pages
 * whose chunker_version was already bumped.
 */
async function readBatch(
  engine: BrainEngine,
  batchSize: number,
  scope: ReindexScope,
  noEmbed = false,
  afterId: number | null = null,
  hotFirst = false,
  hotCursor: ReindexHotCursor | null = null,
): Promise<Array<{
  id: number;
  slug: string;
  source_path: string | null;
  compiled_truth: string;
  source_id: string;
  hot_at: Date | string;
  updated_at: Date | string;
}>> {
  const scoped = buildReindexScopeSql(scope, noEmbed);
  if (hotFirst) {
    const cursorParams = hotCursor
      ? [hotCursor.hotAt, hotCursor.updatedAt, hotCursor.id]
      : [];
    const hotBind = scoped.params.length + 1;
    const updatedBind = scoped.params.length + 2;
    const idBind = scoped.params.length + 3;
    const cursorSql = hotCursor
      ? `AND (
           COALESCE(last_retrieved_at, 'epoch'::timestamptz) < $${hotBind}::timestamptz
           OR (COALESCE(last_retrieved_at, 'epoch'::timestamptz) = $${hotBind}::timestamptz AND updated_at < $${updatedBind}::timestamptz)
           OR (COALESCE(last_retrieved_at, 'epoch'::timestamptz) = $${hotBind}::timestamptz AND updated_at = $${updatedBind}::timestamptz AND id > $${idBind}::integer)
         )`
      : '';
    const limitBind = scoped.params.length + cursorParams.length + 1;
    return engine.executeRaw(
      `SELECT id, slug, source_path, compiled_truth, source_id,
              COALESCE(last_retrieved_at, 'epoch'::timestamptz) AS hot_at,
              updated_at
         FROM pages
        WHERE ${scoped.where}
          ${cursorSql}
        ORDER BY COALESCE(last_retrieved_at, 'epoch'::timestamptz) DESC,
                 updated_at DESC,
                 id ASC
        LIMIT $${limitBind}`,
      [...scoped.params, ...cursorParams, batchSize],
    );
  }
  const afterBind = scoped.params.length + 1;
  const limitBind = scoped.params.length + 2;
  return engine.executeRaw(
    `SELECT id, slug, source_path, compiled_truth, source_id,
            COALESCE(last_retrieved_at, 'epoch'::timestamptz) AS hot_at,
            updated_at
       FROM pages
      WHERE ${scoped.where}
        AND ($${afterBind}::integer IS NULL OR id > $${afterBind})
      ORDER BY id ASC
      LIMIT $${limitBind}`,
    [...scoped.params, afterId, batchSize],
  );
}

export async function runReindex(engine: BrainEngine, args: string[]): Promise<ReindexResult> {
  args = normalizeReindexArgs(args);
  const invalidType = args.some((arg, index) =>
    arg === '--type' && !parsePageType(args[index + 1]));
  if (invalidType) {
    const payload = { error: 'invalid --type: expected a non-empty value, not another flag' };
    if (args.includes('--json')) {
      process.stdout.write(JSON.stringify(payload) + '\n');
    } else {
      process.stderr.write(`[reindex] ${payload.error}\n`);
    }
    setCliExitVerdict(2);
    return emptyReindexResult(args.includes('--dry-run'));
  }
  const invalidSource = invalidRequiredValueFlag(args, '--source');
  const invalidPrefix = args.some((arg, index) =>
    arg === '--prefix' && !normalizeReindexPrefix(args[index + 1]));
  const invalidRetrievedSince = args.some((arg, index) =>
    arg === '--retrieved-since' && !normalizeRetrievedSince(args[index + 1]));
  if (invalidSource || invalidPrefix || invalidRetrievedSince) {
    const error = invalidSource
      ? 'invalid --source: expected a non-empty source id'
      : invalidPrefix
        ? 'invalid --prefix: expected a canonical slug prefix'
        : 'invalid --retrieved-since: expected a real YYYY-MM-DD date';
    if (args.includes('--json')) process.stdout.write(JSON.stringify({ error }) + '\n');
    else process.stderr.write(`[reindex] ${error}\n`);
    setCliExitVerdict(2);
    return emptyReindexResult(args.includes('--dry-run'));
  }
  if (invalidPositiveIntegerFlag(args, '--limit')) {
    const payload = { error: 'invalid --limit: expected a positive integer' };
    if (args.includes('--json')) {
      process.stdout.write(JSON.stringify(payload) + '\n');
    } else {
      process.stderr.write(`[reindex] ${payload.error}\n`);
    }
    setCliExitVerdict(2);
    return emptyReindexResult(args.includes('--dry-run'));
  }
  const invalidWorkerFlag = ['--workers', '--concurrency'].find((flag) =>
    invalidPositiveIntegerFlag(args, flag));
  const invalidRepo = invalidRequiredValueFlag(args, '--repo');
  if (invalidWorkerFlag || invalidRepo) {
    const error = invalidWorkerFlag
      ? `invalid ${invalidWorkerFlag}: expected a positive integer`
      : 'invalid --repo: expected a path';
    const payload = { error };
    if (args.includes('--json')) {
      process.stdout.write(JSON.stringify(payload) + '\n');
    } else {
      process.stderr.write(`[reindex] ${error}\n`);
    }
    setCliExitVerdict(2);
    return emptyReindexResult(args.includes('--dry-run'));
  }
  const opts = parseArgs(args);
  const type = opts.type ?? null;
  const selectionScope: ReindexScope = {
    type,
    sourceId: opts.sourceId ?? null,
    prefix: opts.prefix ?? null,
    retrievedSince: opts.retrievedSince ?? null,
  };
  const scopeJson = {
    type,
    source: selectionScope.sourceId,
    prefix: selectionScope.prefix,
    retrieved_since: selectionScope.retrievedSince,
    hot_first: opts.hotFirst === true,
  };
  const resultScope = { ...selectionScope, hotFirst: opts.hotFirst === true };

  // Require `--markdown` explicitly. Future modes (e.g. --code) get their
  // own routing here.
  if (!args.includes('--markdown')) {
    if (opts.json) {
      process.stdout.write(JSON.stringify({ error: 'gbrain reindex requires a target flag, e.g. --markdown' }) + '\n');
    } else {
      process.stderr.write('Usage: gbrain reindex --markdown [--type PAGE_TYPE] [--source ID] [--prefix SLUG_PREFIX] [--retrieved-since YYYY-MM-DD] [--hot-first] [--limit N] [--dry-run] [--json] [--repo PATH]\n');
    }
    setCliExitVerdict(2);
    return emptyReindexResult(!!opts.dryRun, resultScope);
  }

  const pending = await countPending(engine, selectionScope, !!opts.noEmbed);

  if (opts.json && pending === 0) {
    process.stdout.write(JSON.stringify({ pending: 0, pending_after: 0, reindexed: 0, skipped: 0, failed: 0, chunker_version: MARKDOWN_CHUNKER_VERSION, ...scopeJson }) + '\n');
    return emptyReindexResult(!!opts.dryRun, resultScope);
  }

  if (pending === 0) {
    const label = reindexScopeLabel(selectionScope, opts.hotFirst === true);
    process.stderr.write(`[reindex] All markdown pages${label ? ` ${label}` : ''} already at chunker_version ${MARKDOWN_CHUNKER_VERSION}. Nothing to do.\n`);
    return emptyReindexResult(!!opts.dryRun, resultScope);
  }

  const target = typeof opts.limit === 'number' ? Math.min(opts.limit, pending) : pending;

  if (opts.dryRun) {
    if (opts.json) {
      process.stdout.write(JSON.stringify({ pending, pending_after: pending, would_reindex: target, dry_run: true, chunker_version: MARKDOWN_CHUNKER_VERSION, ...scopeJson }) + '\n');
    } else {
      const label = reindexScopeLabel(selectionScope, opts.hotFirst === true);
      process.stderr.write(`[reindex] DRY-RUN: would re-chunk ${target} of ${pending} pending markdown pages${label ? ` (${label})` : ''}.\n`);
    }
    return { ...emptyReindexResult(true, resultScope), pending, pendingAfter: pending };
  }

  const reporter = createProgress(cliOptsToProgressOptions(getCliOptions()));
  reporter.start('reindex.markdown', target);

  let reindexed = 0;
  let skipped = 0;
  let failed = 0;
  let afterId: number | null = null;
  let hotCursor: ReindexHotCursor | null = null;
  const BATCH = 100;
  const repoPath = opts.repoPath ? resolve(opts.repoPath) : null;

  while (reindexed + skipped + failed < target) {
    const remaining = target - (reindexed + skipped + failed);
    const batchSize = Math.min(BATCH, remaining);
    const batch = await readBatch(
      engine,
      batchSize,
      selectionScope,
      !!opts.noEmbed,
      afterId,
      opts.hotFirst === true,
      hotCursor,
    );
    if (batch.length === 0) break;
    // Advance before processing so a failed row cannot be selected again in
    // this invocation and starve later IDs.
    afterId = batch[batch.length - 1]!.id;
    if (opts.hotFirst) hotCursor = toReindexHotCursor(batch[batch.length - 1]!);

    // v0.41.15.0 (T10, D9): per-batch sliding pool. Counters are JS-
    // single-thread atomic so reindexed++ / failed++ are race-free
    // across workers.
    const writersResolved = resolveWorkersWithClamp(
      engine,
      opts.workers,
      'reindex',
      batch.length,
    );
    await runSlidingPool({
      items: batch,
      workers: writersResolved.workers,
      failureLabel: (row) => row.slug,
      onItem: async (row) => {
        reporter.tick();
        try {
          if (row.source_path && repoPath) {
            const absPath = resolve(repoPath, row.source_path);
            if (existsSync(absPath)) {
              const imported = await importFromFile(engine, absPath, row.source_path, {
                noEmbed: !!opts.noEmbed,
                sourceId: row.source_id,
                inferFrontmatter: false,
                forceRechunk: true,
              });
              if (imported.status === 'imported') {
                reindexed++;
              } else if (imported.status === 'error') {
                process.stderr.write(`[reindex] ${row.slug}: ${imported.error ?? 'import failed'}\n`);
                failed++;
              } else if (imported.error) {
                process.stderr.write(`[reindex] ${row.slug}: ${imported.error}\n`);
                failed++;
              } else {
                skipped++;
              }
              return;
            }
          }
          // No source file on disk (DB-only page, or repo not available) —
          // re-chunk from the stored page. v0.41.37.0 #1621: reconstruct the
          // FULL markdown (frontmatter + body + timeline) via serializeMarkdown
          // and re-import THAT, instead of passing body-only `compiled_truth`
          // to importFromContent. The body-only path re-parsed with empty
          // frontmatter and OVERWROTE the page's real frontmatter / title /
          // timeline (codex catch). The round-trip preserves everything while
          // still re-chunking + bumping chunker_version.
          const page = await engine.getPage(row.slug, { sourceId: row.source_id });
          if (!page) { skipped++; return; }
          const tags = await engine.getTags(row.slug, { sourceId: row.source_id });
          const fullMarkdown = serializeMarkdown(
            page.frontmatter ?? {},
            page.compiled_truth ?? row.compiled_truth,
            page.timeline ?? '',
            { type: page.type, title: page.title, tags },
          );
          const imported = await importFromContent(engine, row.slug, fullMarkdown, {
            sourceId: row.source_id,
            noEmbed: !!opts.noEmbed,
            forceRechunk: true,
          });
          if (imported.status === 'imported') {
            reindexed++;
          } else if (imported.status === 'error') {
            process.stderr.write(`[reindex] ${row.slug}: ${imported.error ?? 'import failed'}\n`);
            failed++;
          } else if (imported.error) {
            process.stderr.write(`[reindex] ${row.slug}: ${imported.error}\n`);
            failed++;
          } else {
            skipped++;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[reindex] ${row.slug}: ${msg}\n`);
          failed++;
        }
      },
    });
  }

  reporter.finish();

  const pendingAfter = await countPending(engine, selectionScope, !!opts.noEmbed);
  if (failed > 0) setCliExitVerdict(1);

  const result: ReindexResult = {
    pending,
    pendingAfter,
    reindexed,
    skipped,
    failed,
    dryRun: false,
    chunkerVersion: MARKDOWN_CHUNKER_VERSION,
    type: selectionScope.type,
    sourceId: selectionScope.sourceId,
    prefix: selectionScope.prefix,
    retrievedSince: selectionScope.retrievedSince,
    hotFirst: opts.hotFirst === true,
  };

  if (opts.json) {
    process.stdout.write(JSON.stringify({
      pending, pending_after: pendingAfter, reindexed, skipped, failed,
      chunker_version: MARKDOWN_CHUNKER_VERSION,
      ...scopeJson,
    }) + '\n');
  } else {
    const label = reindexScopeLabel(selectionScope, opts.hotFirst === true);
    process.stderr.write(`[reindex] Done.${label ? ` ${label}` : ''} reindexed=${reindexed} skipped=${skipped} failed=${failed} pending_before=${pending} pending_after=${pendingAfter}\n`);
  }

  return result;
}
