/**
 * v0.32.2 migration orchestrator — facts join the system-of-record invariant.
 *
 * Schema migration v51 (src/core/migrate.ts) added the two fence columns
 * (row_num, source_markdown_slug) and the partial UNIQUE index. The
 * orchestrator's job is the data half: walk every existing pre-v51 row
 * in the facts table (row_num IS NULL = "no fence yet") and append it
 * to its entity page's `## Facts` fence, atomically + idempotently.
 *
 * Phases:
 *   A. Schema       — assert migration v51 has run.
 *   B. Fence facts  — backfill DB facts → entity-page fences (dry-run
 *                     by default; explicit --write required).
 *   C. Verify       — re-parse each fence-owned page, count rows, compare
 *                     against the DB rows for that page; partial on
 *                     mismatch. Conversation-miner (`cli:`) facts are not
 *                     fence-owned (extract-conversation-facts writes the
 *                     chat log as source of truth) and are excluded.
 *   D. Record       — runner-owned ledger write (apply-migrations.ts).
 *
 * Idempotency: phase B only touches rows with row_num IS NULL. Re-runs
 * after a partial completion pick up where the previous run stopped.
 * Per-page atomic (.tmp + parse + rename, same primitive as
 * fence-write.ts). Dirty-tree refusal mirrors src/core/dry-fix.ts so
 * the user can review the diff before committing.
 *
 * Facts with NULL entity_slug are structurally unfenceable (no page to
 * fence onto). They're skipped with a warning; the operator decides
 * whether to hand-curate or delete them. Their row_num stays NULL
 * forever; they live in the legacy keyspace permanently.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

import type {
  Migration, OrchestratorOpts, OrchestratorResult, OrchestratorPhaseResult,
} from './types.ts';
import type { BrainEngine } from '../../core/engine.ts';
import { loadConfig, toEngineConfig } from '../../core/config.ts';
import { createEngine } from '../../core/engine-factory.ts';
import {
  FACTS_FENCE_BEGIN,
  FACTS_FENCE_END,
  parseFactsFence,
  renderFactsTable,
  type ParsedFact,
} from '../../core/facts-fence.ts';
import { importFromContent } from '../../core/import-file.ts';

let testEngineOverride: BrainEngine | null = null;
export function __setTestEngineOverride(engine: BrainEngine | null): void {
  testEngineOverride = engine;
}

async function getEngine(): Promise<BrainEngine | null> {
  if (testEngineOverride) return testEngineOverride;
  try {
    const cfg = loadConfig();
    if (!cfg) return null;
    const engineConfig = toEngineConfig(cfg);
    const engine = await createEngine(engineConfig);
    await engine.connect(engineConfig);
    return engine;
  } catch {
    return null;
  }
}

// ── Phase A — Schema verify ────────────────────────────────

async function phaseASchema(
  engine: BrainEngine | null,
  opts: OrchestratorOpts,
): Promise<OrchestratorPhaseResult> {
  if (opts.dryRun) return { name: 'schema', status: 'skipped', detail: 'dry-run' };
  if (!engine) {
    return { name: 'schema', status: 'skipped', detail: 'no_brain_configured' };
  }
  try {
    const versionStr = await engine.getConfig('version');
    const v = parseInt(versionStr || '0', 10);
    if (v < 51) {
      return {
        name: 'schema',
        status: 'failed',
        detail: `expected schema version >= 51 (facts_fence_columns); got ${v}. Run \`gbrain apply-migrations --yes\` to apply.`,
      };
    }
    // Quick post-condition: row_num + source_markdown_slug exist on facts.
    const rows = await engine.executeRaw<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'facts' AND column_name IN ('row_num', 'source_markdown_slug')`,
    );
    if (rows.length < 2) {
      return {
        name: 'schema',
        status: 'failed',
        detail: `expected columns row_num + source_markdown_slug on facts; found ${rows.map(r => r.column_name).join(', ') || 'none'}`,
      };
    }
    return { name: 'schema', status: 'complete' };
  } catch (e) {
    return { name: 'schema', status: 'failed', detail: e instanceof Error ? e.message : String(e) };
  }
}

// ── Phase B — Fence facts ──────────────────────────────────

interface LegacyFactRow {
  id: string;        // BIGSERIAL — string-typed on the wire for safety
  source_id: string;
  entity_slug: string | null;
  fact: string;
  kind: 'event' | 'preference' | 'commitment' | 'belief' | 'fact';
  visibility: 'private' | 'world';
  notability: 'high' | 'medium' | 'low';
  context: string | null;
  valid_from: Date;
  valid_until: Date | null;
  source: string;
  confidence: number;
  row_num?: number | null;
  expired_at?: Date | null;
  claim_metric?: string | null;
  claim_value?: number | null;
  claim_unit?: string | null;
  claim_period?: string | null;
}

interface SourceLookup {
  id: string;
  local_path: string | null;
}

interface PhaseBOutcome {
  scanned: number;
  fenced: number;
  skipped_no_entity: number;
  skipped_no_local_path: number;
  pages_touched: number;
  failed_pages: string[];
}

/**
 * Dirty-tree refusal: mirror src/core/dry-fix.ts behavior. Refuses to
 * write if any source's local_path has uncommitted changes. Dry-run
 * skips this check (no writes happen anyway).
 */
function isLocalPathDirty(localPath: string): boolean {
  try {
    const out = execFileSync('git', ['-C', localPath, 'status', '--porcelain'], {
      encoding: 'utf-8',
      timeout: 10_000,
    });
    return out.trim().length > 0;
  } catch {
    // Not a git repo OR git not on PATH → treat as "not dirty" (the
    // user opted out of git tracking, which is allowed). The fence
    // writes are still atomic via .tmp + rename.
    return false;
  }
}

async function phaseBFenceFacts(
  engine: BrainEngine | null,
  opts: OrchestratorOpts,
): Promise<OrchestratorPhaseResult> {
  if (opts.dryRun) {
    // Dry-run: report what WOULD happen without touching FS or DB.
    if (!engine) return { name: 'fence_facts', status: 'skipped', detail: 'no_brain_configured' };
    try {
      const counts = await engine.executeRaw<{ n: string }>(
        `SELECT COUNT(*) AS n
           FROM facts f
           JOIN sources s ON s.id = f.source_id AND s.local_path IS NOT NULL
          WHERE f.row_num IS NULL
            AND f.entity_slug IS NOT NULL
            AND f.expired_at IS NULL
            AND EXISTS (
              SELECT 1 FROM pages p
               WHERE p.source_id=f.source_id AND p.slug=f.entity_slug AND p.deleted_at IS NULL
            )`,
      );
      const total = parseInt(counts[0]?.n ?? '0', 10);
      return {
        name: 'fence_facts',
        status: 'skipped',
        detail: `dry-run: would fence ${total} guarded row(s) with a live backing page and writable source`,
      };
    } catch (e) {
      return { name: 'fence_facts', status: 'failed', detail: e instanceof Error ? e.message : String(e) };
    }
  }

  if (!engine) {
    return { name: 'fence_facts', status: 'skipped', detail: 'no_brain_configured' };
  }

  try {
    // Look up all sources + their local_paths.
    const sources = await engine.executeRaw<SourceLookup>(
      `SELECT id, local_path FROM sources`,
    );
    const localPathById = new Map<string, string | null>();
    for (const s of sources) localPathById.set(s.id, s.local_path);

    // Walk legacy rows in (source_id, entity_slug) groups for per-page
    // atomic writes.
    const legacy = await engine.executeRaw<LegacyFactRow>(
      `SELECT id, source_id, entity_slug, fact, kind, visibility, notability,
              context, valid_from, valid_until, source, confidence
         FROM facts f
        WHERE f.row_num IS NULL
          AND f.entity_slug IS NOT NULL
          AND f.expired_at IS NULL
          AND EXISTS (
            SELECT 1 FROM pages p
             WHERE p.source_id=f.source_id AND p.slug=f.entity_slug AND p.deleted_at IS NULL
          )
          AND EXISTS (
            SELECT 1 FROM sources s
             WHERE s.id=f.source_id AND s.local_path IS NOT NULL
          )
        ORDER BY source_id, entity_slug, id`,
    );

    const outcome: PhaseBOutcome = {
      scanned: legacy.length,
      fenced: 0,
      skipped_no_entity: 0,
      skipped_no_local_path: 0,
      pages_touched: 0,
      failed_pages: [],
    };

    // Group by (source_id, entity_slug) so each page's fence is updated
    // atomically with all its legacy rows.
    const groups = new Map<string, LegacyFactRow[]>();
    for (const row of legacy) {
      if (row.entity_slug === null) {
        outcome.skipped_no_entity += 1;
        continue;
      }
      const localPath = localPathById.get(row.source_id);
      if (!localPath) {
        outcome.skipped_no_local_path += 1;
        continue;
      }
      const key = `${row.source_id}\0${row.entity_slug}`;
      const list = groups.get(key) ?? [];
      list.push(row);
      groups.set(key, list);
    }

    // Dirty-tree refusal: check ONLY the sources we are about to write
    // into. A dirty tree in an unrelated source (or zero fenceable rows
    // at all) must not block a no-op or a targeted backfill (#927).
    const targetSourceIds = new Set([...groups.keys()].map(k => k.split('\0')[0]));
    for (const id of targetSourceIds) {
      const localPath = localPathById.get(id);
      const dirty = localPath ? isLocalPathDirty(localPath) : false;
      if (localPath && dirty && process.env.GBRAIN_MIGRATION_ALLOW_DIRTY_SOURCE !== '1') {
        return {
          name: 'fence_facts',
          status: 'failed',
          detail: `source "${id}" has uncommitted changes in ${localPath}. Commit or stash, then re-run.`,
        };
      }
      if (localPath && dirty) {
        console.warn(
          `[v0.32.2] explicit GBRAIN_MIGRATION_ALLOW_DIRTY_SOURCE=1: preserving current bytes and appending guarded facts in ${localPath}`,
        );
      }
    }

    for (const [key, group] of groups) {
      const [sourceId, entitySlug] = key.split('\0');
      const localPath = localPathById.get(sourceId)!;
      const filePath = join(localPath, `${entitySlug}.md`);
      const tmpPath = `${filePath}.tmp`;

      try {
        // Read existing body or stub-create with minimum frontmatter.
        let body: string;
        if (existsSync(filePath)) {
          body = readFileSync(filePath, 'utf-8');
        } else {
          mkdirSync(dirname(filePath), { recursive: true });
          const prefix = entitySlug.split('/')[0];
          const type =
            prefix === 'people'    ? 'person' :
            prefix === 'companies' ? 'company' :
            prefix === 'deals'     ? 'deal' :
            /* fallback */           'concept';
          const tail = entitySlug.split('/').slice(1).join('/');
          const title = tail.replace(/[-_/]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) || entitySlug;
          body = `---\ntype: ${type}\ntitle: ${title}\nslug: ${entitySlug}\n---\n\n# ${title}\n`;
        }

        // Reconcile the complete non-CLI fence inventory before assigning
        // legacy row numbers. Earlier versions considered only the markdown
        // fence, so a DB-indexed row whose file copy was stale could already
        // occupy #1 while the migration also assigned #1 to a legacy row.
        // The unique constraint then failed after the file rename. Include
        // indexed rows, reserve CLI row numbers, and rebuild one canonical
        // collision-free fence while preserving every current file row.
        const existingFence = parseFactsFence(body);
        const indexed = await engine.executeRaw<LegacyFactRow>(
          `SELECT id, source_id, entity_slug, fact, kind, visibility, notability,
                  context, valid_from, valid_until, source, confidence, row_num,
                  expired_at, claim_metric, claim_value, claim_unit, claim_period
             FROM facts
            WHERE source_id=$1 AND source_markdown_slug=$2 AND row_num IS NOT NULL
              AND COALESCE(source, '') NOT LIKE 'cli:%'
            ORDER BY row_num, id`,
          [sourceId, entitySlug],
        );
        const occupied = await engine.executeRaw<{ row_num: number }>(
          `SELECT row_num FROM facts
            WHERE source_id=$1 AND source_markdown_slug=$2 AND row_num IS NOT NULL`,
          [sourceId, entitySlug],
        );
        const occupiedNums = new Set(occupied.map(r => Number(r.row_num)));
        const indexedByKey = new Map(indexed.map(r => [`${r.fact}\0${r.source ?? ''}`, r]));
        const union = new Map<string, ParsedFact>();
        for (const fact of existingFence.facts) union.set(`${fact.claim}\0${fact.source ?? ''}`, fact);
        const toParsed = (row: LegacyFactRow): ParsedFact => ({
          rowNum: Number(row.row_num ?? 0),
          claim: row.fact,
          kind: row.kind,
          confidence: Number(row.confidence),
          visibility: row.visibility,
          notability: row.notability,
          validFrom: new Date(row.valid_from).toISOString().slice(0, 10),
          validUntil: row.valid_until ? new Date(row.valid_until).toISOString().slice(0, 10) : undefined,
          source: row.source || undefined,
          context: row.context ?? undefined,
          active: row.expired_at == null,
          claimMetric: row.claim_metric ?? undefined,
          claimValue: row.claim_value ?? undefined,
          claimUnit: row.claim_unit ?? undefined,
          claimPeriod: row.claim_period ?? undefined,
        });
        for (const row of indexed) {
          const key = `${row.fact}\0${row.source ?? ''}`;
          if (!union.has(key)) union.set(key, toParsed(row));
        }
        for (const row of group) {
          const key = `${row.fact}\0${row.source ?? ''}`;
          if (!union.has(key)) union.set(key, toParsed(row));
        }

        const used = new Set<number>();
        let next = Math.max(0, ...occupiedNums, ...[...union.values()].map(f => f.rowNum)) + 1;
        for (const [key, fact] of union) {
          const indexedRow = indexedByKey.get(key);
          if (indexedRow?.row_num != null) {
            fact.rowNum = Number(indexedRow.row_num);
          } else if (fact.rowNum <= 0 || occupiedNums.has(fact.rowNum) || used.has(fact.rowNum)) {
            while (occupiedNums.has(next) || used.has(next)) next += 1;
            fact.rowNum = next++;
          }
          used.add(fact.rowNum);
        }
        const canonicalFacts = [...union.values()].sort((a, b) => a.rowNum - b.rowNum);
        const rendered = renderFactsTable(canonicalFacts);
        const begin = body.indexOf(FACTS_FENCE_BEGIN);
        const end = body.indexOf(FACTS_FENCE_END, begin + FACTS_FENCE_BEGIN.length);
        body = begin >= 0 && end >= 0
          ? body.slice(0, begin) + rendered + body.slice(end + FACTS_FENCE_END.length)
          : `${body.trimEnd()}\n\n## Facts\n\n${rendered}\n`;
        const assignments = group.map(row => ({
          id: row.id,
          row_num: union.get(`${row.fact}\0${row.source ?? ''}`)!.rowNum,
        }));

        // Atomic write: .tmp + parse + rename.
        writeFileSync(tmpPath, body, 'utf-8');
        const tmpBody = readFileSync(tmpPath, 'utf-8');
        const parsed = parseFactsFence(tmpBody);
        if (parsed.warnings.length > 0) {
          outcome.failed_pages.push(`${entitySlug} (${parsed.warnings.join('; ')})`);
          // .tmp stays for inspection; do NOT rename.
          continue;
        }
        renameSync(tmpPath, filePath);

        // Markdown is canonical, but the production read/reconciliation path
        // consumes pages.compiled_truth. Keep that projection in lock-step
        // with the just-renamed file before publishing row_num ownership.
        // noEmbed deliberately avoids unbounded provider work inside a data
        // migration; changed chunks are left honestly stale for the normal
        // bounded `gbrain embed --stale` lane.
        const imported = await importFromContent(engine, entitySlug, body, {
          noEmbed: true,
          sourceId,
          sourcePath: `${entitySlug}.md`,
        });
        if (imported.status === 'error' || !imported.parsedPage) {
          throw new Error(
            `page projection write-through failed (${imported.status}): ${imported.error ?? 'unknown error'}`,
          );
        }
        const projected = await engine.getPage(entitySlug, { sourceId });
        if (
          !projected ||
          projected.compiled_truth !== imported.parsedPage.compiled_truth ||
          projected.timeline !== imported.parsedPage.timeline
        ) {
          throw new Error('page projection write-through read-back mismatch');
        }

        // UPDATE the DB rows with their new row_nums + source_markdown_slug.
        for (const a of assignments) {
          await engine.executeRaw(
            `UPDATE facts SET row_num = $1, source_markdown_slug = $2 WHERE id = $3`,
            [a.row_num, entitySlug, a.id],
          );
        }
        outcome.fenced += assignments.length;
        outcome.pages_touched += 1;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        outcome.failed_pages.push(`${entitySlug} (${msg})`);
      }
    }

    const detail = `scanned=${outcome.scanned} fenced=${outcome.fenced} ` +
      `pages=${outcome.pages_touched} skipped_no_entity=${outcome.skipped_no_entity} ` +
      `skipped_no_local_path=${outcome.skipped_no_local_path}` +
      (outcome.failed_pages.length > 0 ? ` failed=${outcome.failed_pages.length}` : '');

    if (outcome.failed_pages.length > 0) {
      return {
        name: 'fence_facts',
        status: 'failed',
        detail: `${detail} :: ${outcome.failed_pages.slice(0, 3).join(' | ')}${outcome.failed_pages.length > 3 ? '...' : ''}`,
      };
    }
    return { name: 'fence_facts', status: 'complete', detail };
  } catch (e) {
    return { name: 'fence_facts', status: 'failed', detail: e instanceof Error ? e.message : String(e) };
  }
}

// ── Phase C — Verify ────────────────────────────────────────

async function phaseCVerify(
  engine: BrainEngine | null,
  opts: OrchestratorOpts,
): Promise<OrchestratorPhaseResult> {
  if (opts.dryRun) return { name: 'verify', status: 'skipped', detail: 'dry-run' };
  if (!engine) return { name: 'verify', status: 'skipped', detail: 'no_brain_configured' };

  try {
    // Per touched page (= any page with a fenced row in the DB), re-parse
    // the fence from disk and compare row counts to the DB.
    const sources = await engine.executeRaw<SourceLookup>(
      `SELECT id, local_path FROM sources`,
    );
    const localPathById = new Map<string, string | null>();
    for (const s of sources) localPathById.set(s.id, s.local_path);

    // Conversation-miner rows stamp row_num without a ## Facts fence
    // (chat-log shape is the source of truth). Same cli: exclusion as
    // extract_facts reconciliation. Counting them here fails every brain
    // that ran extract-conversation-facts.
    const groups = await engine.executeRaw<{ source_id: string; source_markdown_slug: string; n: string }>(
      `SELECT source_id, source_markdown_slug, COUNT(*) AS n
         FROM facts
        WHERE row_num IS NOT NULL
          AND COALESCE(source, '') NOT LIKE 'cli:%'
        GROUP BY source_id, source_markdown_slug`,
    );

    const mismatches: string[] = [];
    let pagesChecked = 0;

    for (const g of groups) {
      const localPath = localPathById.get(g.source_id);
      if (!localPath) continue;
      const filePath = join(localPath, `${g.source_markdown_slug}.md`);
      if (!existsSync(filePath)) {
        mismatches.push(`${g.source_markdown_slug} (file missing)`);
        continue;
      }
      const body = readFileSync(filePath, 'utf-8');
      const parsed = parseFactsFence(body);
      const fenceCount = parsed.facts.length;
      const dbCount = parseInt(g.n, 10);
      if (fenceCount !== dbCount) {
        mismatches.push(`${g.source_markdown_slug} (fence=${fenceCount}, db=${dbCount})`);
      }
      pagesChecked += 1;
    }

    if (mismatches.length > 0) {
      return {
        name: 'verify',
        status: 'failed',
        detail: `${mismatches.length} pages drifted: ${mismatches.slice(0, 3).join(' | ')}${mismatches.length > 3 ? '...' : ''}`,
      };
    }
    return { name: 'verify', status: 'complete', detail: `pages_checked=${pagesChecked}` };
  } catch (e) {
    return { name: 'verify', status: 'failed', detail: e instanceof Error ? e.message : String(e) };
  }
}

// ── Orchestrator ────────────────────────────────────────────

async function orchestrator(opts: OrchestratorOpts): Promise<OrchestratorResult> {
  console.log('');
  console.log('=== v0.32.2 — facts join the system-of-record invariant ===');
  if (opts.dryRun) console.log('  (dry-run; no side effects)');
  console.log('');

  const engine = await getEngine();
  const phases: OrchestratorPhaseResult[] = [];

  const a = await phaseASchema(engine, opts);
  phases.push(a);
  if (a.status === 'failed') return finalizeResult(phases, 'failed', engine);

  const b = await phaseBFenceFacts(engine, opts);
  phases.push(b);
  if (b.status === 'failed') return finalizeResult(phases, 'failed', engine);

  const c = await phaseCVerify(engine, opts);
  phases.push(c);

  const overallStatus: 'complete' | 'partial' | 'failed' =
    c.status === 'failed' ? 'partial' : 'complete';

  return finalizeResult(phases, overallStatus, engine);
}

function finalizeResult(
  phases: OrchestratorPhaseResult[],
  status: 'complete' | 'partial' | 'failed',
  engine: BrainEngine | null,
): OrchestratorResult {
  // Best-effort disconnect of the engine we created. testEngineOverride
  // is owned by the test, never disconnected here.
  if (engine && !testEngineOverride) {
    engine.disconnect().catch(() => { /* best-effort */ });
  }
  return {
    version: '0.32.2',
    status,
    phases,
  };
}

export const v0_32_2: Migration = {
  version: '0.32.2',
  featurePitch: {
    headline: 'Facts join the system-of-record — your hot memory now lives in markdown, indexed by the DB',
    description:
      'v0.31 added hot-memory facts but they lived only in the database. v0.32.2 makes the ' +
      'fenced `## Facts` table on each entity page canonical: every new fact writes to markdown ' +
      'first, then stamps the DB index. Existing v0.31 facts are backfilled to fences on this ' +
      'migration. `gbrain rebuild` (v0.32.3) becomes a one-line disaster-recovery flow because ' +
      'the DB is now fully derivable from the repo. Migration is dry-run by default; pass ' +
      '`--write` to apply.',
  },
  orchestrator,
};

/** Exported for unit tests. */
export const __testing = {
  phaseASchema,
  phaseBFenceFacts,
  phaseCVerify,
  isLocalPathDirty,
};
