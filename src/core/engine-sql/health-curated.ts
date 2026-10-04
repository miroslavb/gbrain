/** Host curated graph denominators with indexed endpoint lookups, including before ANALYZE. */
import { canonicalGraphSqlPredicate, summarizeGraphHealthScope, type GraphHealthRow } from '../graph-health-scope.ts';
import { QUARANTINE_FILTER_FRAGMENT } from '../quarantine.ts';
import type { LegacyUnscopedRead } from './brands.ts';
import { sqlFragment, trustedSql } from './fragment.ts';

export async function readCuratedGraphScope(exec: LegacyUnscopedRead, scope: string[] | null) {
  const liveSource = sqlFragment`(SELECT src.deleted_at IS NULL AND (${scope}::text[] IS NULL OR src.source_id = ANY(${scope})) FROM pages src WHERE src.id=l.from_page_id)`;
  const liveTarget = sqlFragment`(SELECT tgt.deleted_at IS NULL AND (${scope}::text[] IS NULL OR tgt.source_id = ANY(${scope})) FROM pages tgt WHERE tgt.id=l.to_page_id)`;
  const curatedSource = sqlFragment`(SELECT src.deleted_at IS NULL AND ${trustedSql(canonicalGraphSqlPredicate('src'))} AND (${scope}::text[] IS NULL OR src.source_id = ANY(${scope})) FROM pages src WHERE src.id=l.from_page_id)`;
  const curatedTarget = sqlFragment`(SELECT tgt.deleted_at IS NULL AND ${trustedSql(canonicalGraphSqlPredicate('tgt'))} AND (${scope}::text[] IS NULL OR tgt.source_id = ANY(${scope})) FROM pages tgt WHERE tgt.id=l.to_page_id)`;
  const { rows } = await exec.run<GraphHealthRow>(sqlFragment`
      SELECT p.slug, p.type,
             (SELECT count(*)::int FROM links l WHERE
               (l.from_page_id = p.id AND ${liveTarget}) OR
               (l.to_page_id = p.id AND ${liveSource})) AS link_count,
             EXISTS (SELECT 1 FROM links l WHERE l.to_page_id = p.id AND ${liveSource}) AS has_inbound,
             EXISTS (SELECT 1 FROM timeline_entries te WHERE te.page_id = p.id) AS has_timeline,
             (EXISTS (SELECT 1 FROM links l WHERE l.from_page_id = p.id AND ${curatedTarget}) OR
              EXISTS (SELECT 1 FROM links l WHERE l.to_page_id = p.id AND ${curatedSource})) AS has_entity_link,
             CASE WHEN NULLIF(btrim(p.frontmatter->>'project'), '') IS NULL THEN false ELSE EXISTS (
               SELECT 1 FROM pages target
                WHERE target.deleted_at IS NULL
                  AND target.type = 'project'
                  AND ${trustedSql(canonicalGraphSqlPredicate('target'))}
                  AND (${scope}::text[] IS NULL OR target.source_id = ANY(${scope}))
                  AND (lower(target.slug) = lower(btrim(p.frontmatter->>'project'))
                    OR lower(target.slug) = lower('projects/' || btrim(p.frontmatter->>'project'))
                    OR lower(target.title) = lower(btrim(p.frontmatter->>'project')))
             ) END AS has_resolvable_entity_hint
      FROM pages p
      WHERE p.deleted_at IS NULL
        AND ${trustedSql(QUARANTINE_FILTER_FRAGMENT)}
        AND (${scope}::text[] IS NULL OR p.source_id = ANY(${scope}))
    `);
  return summarizeGraphHealthScope(rows);
}
