/**
 * Page-level visibility compatibility for a single-principal host.
 *
 * Legacy pages may still carry `frontmatter.visibility: private`. A brain in
 * the world-only posture exposes those pages to every agent; older brains keep
 * the legacy gate until bootstrap normalizes the shared policy key.
 *
 * The SQL predicate itself lives in buildVisibilityClause (sql-ranking.ts)
 * behind SearchOpts.excludePrivate; this resolver decides whether to set it.
 */

import type { BrainEngine } from '../engine.ts';
import { FACTS_DEFAULT_VISIBILITY_KEY } from '../facts/visibility.ts';

export const REMOTE_PRIVATE_PAGES_KEY = 'search.remote_private_pages';

/**
 * Raw SQL predicate hiding `visibility: private` pages (absent visibility
 * defaults to 'world'). Single source of truth for the fragment — consumed by
 * buildVisibilityClause (search paths), both engines' listPages, the
 * relational-arm hydrate, and get_page's fuzzy-candidate filter. `pageAlias`
 * is a code-provided literal, never user input.
 */
export function privatePagesFilterFragment(pageAlias: string): string {
  return `COALESCE(${pageAlias}.frontmatter->>'visibility', 'world') <> 'private'`;
}

/**
 * Row-side twin of privatePagesFilterFragment for pages already fetched
 * (get_page / fetch read one row by slug; re-querying just to filter would
 * be a second round-trip). Same semantics: only the exact string 'private'
 * hides a page; absent/other values default to world-visible.
 */
export function isPrivatePage(frontmatter: unknown): boolean {
  return (
    typeof frontmatter === 'object' &&
    frontmatter !== null &&
    (frontmatter as Record<string, unknown>).visibility === 'private'
  );
}

/**
 * Slugs an untrusted caller must not see enumerated: every in-scope page row
 * for the slug is `visibility: private`. A slug with at least one non-private
 * in-scope page stays visible (multi-source: private in one source, world in
 * another). Slugs with no page row at all (dangling link endpoints) are not
 * returned — they reveal nothing private. Shared by the #4352 read-op gates
 * (get_page fuzzy candidates, resolve_slugs, link/graph endpoint filtering,
 * and the content-op probes via slugHiddenFromCaller). `scope` follows the
 * canonical precedence (federated array > scalar > nothing); with
 * `includeDeleted` unset, only live rows are considered.
 */
export async function findPrivateOnlySlugs(
  engine: BrainEngine,
  slugs: string[],
  scope: { sourceId?: string; sourceIds?: string[] } = {},
  opts: { includeDeleted?: boolean } = {},
): Promise<Set<string>> {
  if (slugs.length === 0) return new Set();
  const params: unknown[] = [slugs];
  let scopeClause = '';
  if (scope.sourceIds && scope.sourceIds.length > 0) {
    params.push(scope.sourceIds);
    scopeClause = `AND p.source_id = ANY($${params.length}::text[])`;
  } else if (scope.sourceId) {
    params.push(scope.sourceId);
    scopeClause = `AND p.source_id = $${params.length}`;
  }
  const rows = await engine.executeRaw<{ slug: string }>(
    `SELECT p.slug FROM pages p
      WHERE p.slug = ANY($1::text[])
        ${opts.includeDeleted ? '' : 'AND p.deleted_at IS NULL'}
        ${scopeClause}
      GROUP BY p.slug
      HAVING bool_and(NOT (${privatePagesFilterFragment('p')}))`,
    params,
  );
  return new Set(rows.map(r => r.slug));
}

/**
 * One-slug trust + probe combo for the sibling content ops (#4352
 * remediation: get_chunks / get_versions / get_timeline / get_raw_data).
 * True ⇒ the caller's read of `slug` must behave exactly like a missing
 * page (no existence oracle). Trusted local + the operator opt-outs resolve
 * to false via resolveExcludePrivatePages before any query runs. The probe
 * considers DELETED rows too (fail-closed: a soft-deleted private page's
 * history/timeline/raw data stays hidden).
 */
export async function slugHiddenFromCaller(
  engine: BrainEngine,
  remote: boolean | undefined,
  slug: string,
  scope: { sourceId?: string; sourceIds?: string[] } = {},
): Promise<boolean> {
  if (!(await resolveExcludePrivatePages(engine, remote))) return false;
  const hidden = await findPrivateOnlySlugs(engine, [slug], scope, { includeDeleted: true });
  return hidden.has(slug);
}

/** Backward-compatible test helper; the world-only resolver has no cache. */
export function __resetPrivateVisibilityCacheForTests(): void {
  // no-op
}

/**
 * A brain configured with the single-principal `facts.default_visibility=world`
 * posture exposes every page too. Older/multi-principal brains retain the
 * legacy private-page gate until bootstrap normalizes that one policy key.
 */
export async function resolveExcludePrivatePages(
  engine: BrainEngine,
  remote: boolean | undefined,
): Promise<boolean> {
  if (remote === false) return false;
  try {
    const factsVisibility = await engine.getConfig(FACTS_DEFAULT_VISIBILITY_KEY);
    if (factsVisibility?.trim().toLowerCase() === 'world') return false;
    const legacyPageOverride = await engine.getConfig(REMOTE_PRIVATE_PAGES_KEY);
    if (legacyPageOverride === 'visible' || legacyPageOverride === 'true' || legacyPageOverride === '1') {
      return false;
    }
  } catch {
    // A pre-bootstrap/multi-principal brain retains the legacy fail-closed gate.
  }
  if (process.env.GBRAIN_REMOTE_PRIVATE_PAGES === '1') return false;
  return true;
}

/**
 * KEEP-list inverse of findPrivateOnlySlugs: of the given slugs, which have
 * at least one world-visible page row (deleted rows considered — see
 * findWorldVisibleSlugs' consumers for why)? Fail-closed by construction: a
 * slug with NO page row at all (e.g. hard-purged between a caller's list
 * read and this probe) is simply absent from the keep-set, so a
 * keep-list consumer drops it instead of serving it — the drop-list shape
 * fails OPEN on exactly that TOCTOU window.
 */
export async function findWorldVisibleSlugs(
  engine: BrainEngine,
  slugs: string[],
  scope: { sourceId?: string; sourceIds?: string[] } = {},
): Promise<Set<string>> {
  if (slugs.length === 0) return new Set();
  const params: unknown[] = [slugs];
  let scopeClause = '';
  if (scope.sourceIds && scope.sourceIds.length > 0) {
    params.push(scope.sourceIds);
    scopeClause = `AND p.source_id = ANY($${params.length}::text[])`;
  } else if (scope.sourceId) {
    params.push(scope.sourceId);
    scopeClause = `AND p.source_id = $${params.length}`;
  }
  const rows = await engine.executeRaw<{ slug: string }>(
    `SELECT p.slug FROM pages p
      WHERE p.slug = ANY($1::text[])
        ${scopeClause}
      GROUP BY p.slug
      HAVING bool_or(${privatePagesFilterFragment('p')})`,
    params,
  );
  return new Set(rows.map(r => r.slug));
}

/**
 * Shared post-filter for list-shaped read ops (find_orphans,
 * get_recent_salience, find_experts): one gate read + one batched KEEP-list
 * probe, keeping only rows whose slug has a world-visible page row.
 *
 * Deleted rows are considered by the probe on purpose: some callers' raw
 * list queries carry no `deleted_at` predicate, so a soft-deleted private
 * page can still be IN the rows — a live-rows-only probe would never see
 * it and the filter would fail open (same fail-closed reasoning as
 * slugHiddenFromCaller above). And the keep-list shape means a slug whose
 * page row vanished entirely (concurrent purge) drops out too, instead of
 * being served because "no row" looked like "not private".
 */
export async function dropPrivateOnlyRows<T>(
  engine: BrainEngine,
  remote: boolean | undefined,
  rows: T[],
  slugOf: (row: T) => string,
  scope: { sourceId?: string; sourceIds?: string[] } = {},
): Promise<T[]> {
  if (rows.length === 0) return rows;
  if (!(await resolveExcludePrivatePages(engine, remote))) return rows;
  const keep = await findWorldVisibleSlugs(engine, rows.map(slugOf), scope);
  if (keep.size === rows.length) return rows;
  return rows.filter(r => keep.has(slugOf(r)));
}
