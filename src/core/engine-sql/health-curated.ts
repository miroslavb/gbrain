/** Host curated graph denominators; source scope and both-endpoint liveness are preserved. */
import { canonicalGraphSqlPredicate, summarizeGraphHealthScope, type GraphHealthRow } from '../graph-health-scope.ts';
import { QUARANTINE_FILTER_FRAGMENT } from '../quarantine.ts';
import type { LegacyUnscopedRead } from './brands.ts';
import { sqlFragment, trustedSql } from './fragment.ts';

export async function readCuratedGraphScope(exec: LegacyUnscopedRead, scope: string[] | null) {
  const { rows } = await exec.run<GraphHealthRow>(sqlFragment`
      SELECT p.slug, p.type,
             (SELECT count(*)::int FROM links l WHERE
               (l.from_page_id = p.id AND EXISTS (
                 SELECT 1 FROM pages tgt WHERE tgt.id = l.to_page_id AND tgt.deleted_at IS NULL
                   AND (${scope}::text[] IS NULL OR tgt.source_id = ANY(${scope})))) OR
               (l.to_page_id = p.id AND EXISTS (
                 SELECT 1 FROM pages src WHERE src.id = l.from_page_id AND src.deleted_at IS NULL
                   AND (${scope}::text[] IS NULL OR src.source_id = ANY(${scope}))))) AS link_count,
             EXISTS (SELECT 1 FROM links l JOIN pages src ON src.id = l.from_page_id
               WHERE l.to_page_id = p.id AND src.deleted_at IS NULL
                 AND (${scope}::text[] IS NULL OR src.source_id = ANY(${scope}))) AS has_inbound,
             EXISTS (SELECT 1 FROM timeline_entries te WHERE te.page_id = p.id) AS has_timeline,
             EXISTS (SELECT 1 FROM links l JOIN pages other ON
               (l.from_page_id = p.id AND other.id = l.to_page_id) OR (l.to_page_id = p.id AND other.id = l.from_page_id)
               WHERE other.deleted_at IS NULL AND ${trustedSql(canonicalGraphSqlPredicate('other'))}
                 AND (${scope}::text[] IS NULL OR other.source_id = ANY(${scope}))) AS has_entity_link,
             EXISTS (
               SELECT 1 FROM pages target
                WHERE target.deleted_at IS NULL
                  AND target.type = 'project'
                  AND ${trustedSql(canonicalGraphSqlPredicate('target'))}
                  AND (${scope}::text[] IS NULL OR target.source_id = ANY(${scope}))
                  AND NULLIF(btrim(p.frontmatter->>'project'), '') IS NOT NULL
                  AND (lower(target.slug) = lower(btrim(p.frontmatter->>'project'))
                    OR lower(target.slug) = lower('projects/' || btrim(p.frontmatter->>'project'))
                    OR lower(target.title) = lower(btrim(p.frontmatter->>'project')))
             ) AS has_resolvable_entity_hint
      FROM pages p
      WHERE p.deleted_at IS NULL
        AND ${trustedSql(QUARANTINE_FILTER_FRAGMENT)}
        AND (${scope}::text[] IS NULL OR p.source_id = ANY(${scope}))
    `);
  return summarizeGraphHealthScope(rows);
}
