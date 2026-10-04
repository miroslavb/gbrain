/** Independent oracle copied from accepted fork b7be8cc3:src/core/pglite-engine.ts.
 * Only the engine transport adapter changed; preserve all old SQL, scope rules
 * and score fields. This is intentionally not derived from the new helper. */
import type { BrainEngine } from '../../src/core/engine.ts';
import type { BrainHealth } from '../../src/core/types.ts';
import { MIN_ENTITY_PAGES_FOR_COVERAGE } from '../../src/core/types.ts';
import { LINK_EXTRACTOR_VERSION_TS } from '../../src/core/link-extraction.ts';
import { QUARANTINE_FILTER_FRAGMENT, quarantineFilterFragment } from '../../src/core/quarantine.ts';
import { shouldExcludeFromOrphanReporting, loadOrphanPolicyOverrides } from '../../src/core/orphan-policy.ts';
import { resolveActiveEmbeddingColumnFromEngine, quoteIdentifier } from '../../src/core/search/embedding-column.ts';
import { canonicalEntitySqlPredicate, canonicalGraphSqlPredicate, summarizeGraphHealthScope, type GraphHealthRow } from '../../src/core/graph-health-scope.ts';
export async function legacyGetHealth(engine: BrainEngine, opts?: { sourceId?: string; sourceIds?: string[] }): Promise<BrainHealth> {
    const query = async (sql: string, params: unknown[]) => ({ rows: await engine.executeRaw(sql, params) });
    // Combined metrics from master (brain_score components: dead_links, link_count,
    // pages_with_timeline) and v0.10.3 graph layer (link_coverage, timeline_coverage,
    // most_connected). Both coexist: master's brain_score is the composite
    // dashboard, v0.10.3 metrics give entity-page-level granularity.
    // #1305: every page-scoped count here excludes soft-deleted rows — same
    // posture as getStats — so brain_score moves when the user deletes pages.
    // Chunk/link counts stay raw (storage until the purge phase), matching
    // getStats, and destructive-removal counts elsewhere deliberately stay raw.
    // S2: coverage + missing_embeddings key on the registry-ACTIVE column.
    // #4592: optional source scope — parity with postgres-engine.getHealth
    // (bound as $1, never interpolated; both-endpoint rule for link-derived
    // numbers; out-of-scope endpoints can't rescue a page from orphan-hood).
    const scope: string[] | null = opts?.sourceIds ?? (opts?.sourceId ? [opts.sourceId] : null);
    const colId = quoteIdentifier((await resolveActiveEmbeddingColumnFromEngine(engine, { fallbackToLegacy: true })).name);
    const canonicalEntity = canonicalEntitySqlPredicate('p');
    const canonicalOther = canonicalGraphSqlPredicate('other');
    const canonicalProjectTarget = canonicalGraphSqlPredicate('target');
    const { rows: [h] } = await query(`
      WITH scoped_pages AS (
        SELECT id, slug, type, title, frontmatter, deleted_at, source_id FROM pages p
        WHERE ($1::text[] IS NULL OR p.source_id = ANY($1))
      ),
      entity_pages AS (
        -- #4280: quarantined entity shells are not served memory — keep them
        -- out of the link/timeline coverage denominators (parity with
        -- onboard's VISIBLE_ENTITY_PREDICATE); canonical slug+type predicate
        -- keeps nested/generated rows out (fork graph-health contract).
        SELECT p.id, p.slug FROM scoped_pages p
        WHERE ${canonicalEntity} AND p.deleted_at IS NULL
          AND ${quarantineFilterFragment('p')}
      )
      SELECT
        (SELECT count(*) FROM scoped_pages WHERE deleted_at IS NULL) as page_count,
        -- Parity with postgres-engine: stored-VECTOR truth over ELIGIBLE
        -- chunks (embedding, not embedded_at; embed_skip excluded from BOTH
        -- sides; zero eligible = vacuous 100%).
        (SELECT CASE
           WHEN count(*) FILTER (WHERE NOT jsonb_exists(COALESCE(p.frontmatter, '{}'::jsonb), 'embed_skip')) = 0
           THEN 1.0
           ELSE count(*) FILTER (WHERE cc.${colId} IS NOT NULL
                                   AND NOT jsonb_exists(COALESCE(p.frontmatter, '{}'::jsonb), 'embed_skip'))::float
              / count(*) FILTER (WHERE NOT jsonb_exists(COALESCE(p.frontmatter, '{}'::jsonb), 'embed_skip'))::float
         END
         FROM content_chunks cc
         JOIN scoped_pages p ON p.id = cc.page_id) as embed_coverage,
        0 as stale_pages,
        -- Bug 11 — orphan = islanded (no inbound AND no outbound). The raw
        -- list is filtered in TS using the shared orphan-reporting policy.
        0 as orphan_pages,
        (SELECT count(*) FROM links l
         WHERE NOT EXISTS (SELECT 1 FROM pages p WHERE p.id = l.to_page_id)
           AND ($1::text[] IS NULL
                OR EXISTS (SELECT 1 FROM scoped_pages sp WHERE sp.id = l.from_page_id))
        ) as dead_links,
        -- Parity with postgres-engine.ts: same predicate as
        -- buildStaleChunkWhere / countStaleChunks, i.e. what 'embed --stale'
        -- actually processes. 'embedding IS NULL' (not embedded_at, which can
        -- be non-NULL while embedding is NULL) and embed_skip excluded, so the
        -- count can reach zero and the embed.stale remediation can converge.
        (SELECT count(*) FROM content_chunks cc
           JOIN scoped_pages p ON p.id = cc.page_id
          WHERE cc.${colId} IS NULL AND p.deleted_at IS NULL
            AND NOT jsonb_exists(COALESCE(p.frontmatter, '{}'::jsonb), 'embed_skip')
        ) as missing_embeddings,
        (SELECT count(*) FROM links l
          WHERE ($1::text[] IS NULL
             OR (EXISTS (SELECT 1 FROM scoped_pages sp WHERE sp.id = l.from_page_id)
                 AND EXISTS (SELECT 1 FROM scoped_pages sp WHERE sp.id = l.to_page_id)))) as link_count,
        (SELECT count(*) FROM entity_pages) as entity_page_count,
        -- gbrain#4153 consistency: an inbound link counts toward coverage
        -- only when its SOURCE page is live — the same endpoint-liveness rule
        -- the islanded predicate below applies, so an entity whose only
        -- inbound link comes from a soft-deleted page can't read as covered
        -- AND islanded in one payload.
        (SELECT count(*) FROM entity_pages e
         WHERE EXISTS (SELECT 1 FROM links l
                       JOIN scoped_pages src ON src.id = l.from_page_id
                       WHERE l.to_page_id = e.id AND src.deleted_at IS NULL))::float /
          GREATEST((SELECT count(*) FROM entity_pages), 1)::float as link_coverage,
        (SELECT count(*) FROM entity_pages e
         WHERE EXISTS (SELECT 1 FROM timeline_entries te WHERE te.page_id = e.id))::float /
          GREATEST((SELECT count(*) FROM entity_pages), 1)::float as timeline_coverage
    `, [scope]);

    // Top 5 most connected entities by total link count (in + out).
    // X8 (#4592): a degree counts an edge only when its FAR endpoint is in
    // scope too — parity with postgres-engine's rule and comment.
    const { rows: connected } = await query(`
      SELECT p.slug,
             (SELECT count(*) FROM links l
               WHERE (l.from_page_id = p.id
                      AND ($1::text[] IS NULL
                           OR EXISTS (SELECT 1 FROM pages fp WHERE fp.id = l.to_page_id AND fp.source_id = ANY($1))))
                  OR (l.to_page_id = p.id
                      AND ($1::text[] IS NULL
                           OR EXISTS (SELECT 1 FROM pages fp WHERE fp.id = l.from_page_id AND fp.source_id = ANY($1))))
             )::int as link_count
      FROM pages p
      WHERE ${canonicalEntity} AND p.deleted_at IS NULL
        AND ${quarantineFilterFragment('p')}
        AND ($1::text[] IS NULL OR p.source_id = ANY($1))
      ORDER BY link_count DESC
      LIMIT 5
    `, [scope]);

    // Per-page graph flags feed two explicitly separate scopes: the broad
    // operational orphan report and curated knowledge score denominators.
    // Archive (raw/), generated, and daily-log pages are not expected to
    // participate in the curated graph. Filtered in TS because the policy
    // includes per-brain config overrides.
    // gbrain#4153: endpoint liveness in BOTH directions — an inbound link
    // only counts when its SOURCE page is live (the invariant
    // findOrphanPages documents), and an outbound link only counts when its
    // TARGET is live. Without this, get_health's orphan_pages disagreed with
    // `gbrain orphans` whenever a soft-deleted page still linked to (or was
    // linked from) a live one.
    // #4592: out-of-scope endpoints cannot rescue a page from orphan-hood.
    // #4280: quarantined pages drop out of the linkable scope in SQL;
    // machine leaf types (atom/conversation/source) drop out through the
    // shared policy below via p.type.
    const { rows: pageScopeRows } = await query(`
      SELECT p.slug, p.type,
             (SELECT count(*)::int FROM links l WHERE
               (l.from_page_id = p.id AND EXISTS (
                 SELECT 1 FROM pages tgt WHERE tgt.id = l.to_page_id AND tgt.deleted_at IS NULL
                   AND ($1::text[] IS NULL OR tgt.source_id = ANY($1)))) OR
               (l.to_page_id = p.id AND EXISTS (
                 SELECT 1 FROM pages src WHERE src.id = l.from_page_id AND src.deleted_at IS NULL
                   AND ($1::text[] IS NULL OR src.source_id = ANY($1))))) AS link_count,
             EXISTS (SELECT 1 FROM links l JOIN pages src ON src.id = l.from_page_id
               WHERE l.to_page_id = p.id AND src.deleted_at IS NULL
                 AND ($1::text[] IS NULL OR src.source_id = ANY($1))) AS has_inbound,
             EXISTS (SELECT 1 FROM timeline_entries te WHERE te.page_id = p.id) AS has_timeline,
             EXISTS (SELECT 1 FROM links l JOIN pages other ON
               (l.from_page_id = p.id AND other.id = l.to_page_id) OR (l.to_page_id = p.id AND other.id = l.from_page_id)
               WHERE other.deleted_at IS NULL AND ${canonicalOther}
                 AND ($1::text[] IS NULL OR other.source_id = ANY($1))) AS has_entity_link,
             EXISTS (
               SELECT 1 FROM pages target
                WHERE target.deleted_at IS NULL
                  AND target.type = 'project'
                  AND ${canonicalProjectTarget}
                  AND ($1::text[] IS NULL OR target.source_id = ANY($1))
                  AND NULLIF(btrim(p.frontmatter->>'project'), '') IS NOT NULL
                  AND (lower(target.slug) = lower(btrim(p.frontmatter->>'project'))
                    OR lower(target.slug) = lower('projects/' || btrim(p.frontmatter->>'project'))
                    OR lower(target.title) = lower(btrim(p.frontmatter->>'project')))
             ) AS has_resolvable_entity_hint
      FROM pages p
      WHERE p.deleted_at IS NULL
        AND ${QUARANTINE_FILTER_FRAGMENT}
        AND ($1::text[] IS NULL OR p.source_id = ANY($1))
    `, [scope]);

    const r = h as Record<string, unknown>;
    const pageCount = Number(r.page_count);
    const embedCoverage = Number(r.embed_coverage);
    // Scoped: sum the scalar-sourceId counter per grant (parity with
    // postgres-engine; the unmatchable __all__ scalar fail-closes to 0).
    const stalePages = scope === null
      ? await engine.countStalePagesForExtraction({ versionTs: LINK_EXTRACTOR_VERSION_TS })
      : (await Promise.all(scope.map(sid =>
          engine.countStalePagesForExtraction({ sourceId: sid, versionTs: LINK_EXTRACTOR_VERSION_TS }),
        ))).reduce((a, b) => a + b, 0);
    const orphanOverrides = await loadOrphanPolicyOverrides(engine);
    const graphRows = pageScopeRows as unknown as GraphHealthRow[];
    const linkablePages = graphRows
      .filter(row => !shouldExcludeFromOrphanReporting(row.slug, orphanOverrides, { type: row.type }));
    const linkablePageCount = linkablePages.length;
    const orphanPages = linkablePages.filter(row => Number(row.link_count) === 0).length;
    const deadLinks = Number(r.dead_links);
    const graphScope = summarizeGraphHealthScope(graphRows);
    const linkDensity = graphScope.curated_pages > 0 ? Math.min(graphScope.curated_link_endpoints / graphScope.curated_pages, 1) : 1;
    // A brain with no curated pages gets full graph marks: archive/session
    // material has no curated graph to penalize.
    const timelineCoverageDensity = graphScope.curated_pages > 0 ? graphScope.curated_timeline_pages / graphScope.curated_pages : 1;
    const noOrphans = graphScope.curated_pages > 0 ? 1 - (graphScope.curated_islands / graphScope.curated_pages) : 1;
    const noDeadLinks = pageCount > 0 ? 1 - Math.min(deadLinks / pageCount, 1) : 1;
    // Per-component points sum to brainScore by construction.
    //
    // v0.37.10.0: empty brains (pageCount === 0) get FULL marks (100/100),
    // not 0. Semantically an empty brain has no coverage problem to penalize
    // — there's nothing to embed, nothing to link, nothing to orphan. The
    // pre-fix "empty = 0" caused fresh-init brains to score as critically
    // unhealthy on `gbrain doctor`, which was a structural surprise to users
    // who'd just successfully run init.
    const embedCoverageScore = pageCount === 0 ? 35 : Math.round(embedCoverage * 35);
    const linkDensityScore = pageCount === 0 ? 25 : Math.round(linkDensity * 25);
    const timelineCoverageScore = pageCount === 0 ? 15 : Math.round(timelineCoverageDensity * 15);
    const noOrphansScore = pageCount === 0 ? 15 : Math.round(noOrphans * 15);
    const noDeadLinksScore = pageCount === 0 ? 10 : Math.round(noDeadLinks * 10);
    const brainScore = embedCoverageScore + linkDensityScore + timelineCoverageScore + noOrphansScore + noDeadLinksScore;

    return {
      page_count: pageCount,
      linkable_page_count: linkablePageCount,
      embed_coverage: embedCoverage,
      stale_pages: stalePages,
      orphan_pages: orphanPages,
      missing_embeddings: Number(r.missing_embeddings),
      brain_score: brainScore,
      dead_links: deadLinks,
      entity_page_count: Number(r.entity_page_count),
      // gbrain#4147: below the small-N floor the ratio is statistically
      // meaningless (0/0 used to read as a hard 0%), so it reports null and
      // consumers suppress both the percentage and its remediation actions.
      link_coverage: Number(r.entity_page_count) >= MIN_ENTITY_PAGES_FOR_COVERAGE ? Number(r.link_coverage) : null,
      timeline_coverage: Number(r.entity_page_count) >= MIN_ENTITY_PAGES_FOR_COVERAGE ? Number(r.timeline_coverage) : null,
      most_connected: (connected as { slug: string; link_count: number }[]).map(c => ({
        slug: c.slug,
        link_count: Number(c.link_count),
      })),
      embed_coverage_score: embedCoverageScore,
      link_density_score: linkDensityScore,
      timeline_coverage_score: timelineCoverageScore,
      no_orphans_score: noOrphansScore,
      no_dead_links_score: noDeadLinksScore,
      graph_scope: graphScope,
    };
  }

