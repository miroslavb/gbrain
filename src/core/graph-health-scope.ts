/** Canonical knowledge/entity types used for graph-health scoring. */
export const CURATED_GRAPH_TYPES = new Set([
  'concept', 'project', 'analysis', 'guide',
  'person', 'company', 'entity', 'organization',
]);

export interface GraphHealthRow {
  slug: string;
  type: string;
  link_count: number | string;
  has_inbound: boolean;
  has_timeline: boolean;
  has_entity_link: boolean;
}

export interface GraphScopeStats {
  curated_pages: number;
  curated_link_endpoints: number;
  curated_islands: number;
  curated_no_inbound: number;
  curated_timeline_pages: number;
  session_pages: number;
  session_islands: number;
  session_parents: number;
  session_parents_entity_linked: number;
}

export function summarizeGraphHealthScope(rows: readonly GraphHealthRow[]): GraphScopeStats {
  const curated = rows.filter((row) => CURATED_GRAPH_TYPES.has(row.type));
  const sessions = rows.filter((row) => row.slug.startsWith('sessions/'));
  const parents = sessions.filter((row) => !row.slug.includes('/segments/'));
  const isIsland = (row: GraphHealthRow) => Number(row.link_count) === 0;
  return {
    curated_pages: curated.length,
    curated_link_endpoints: curated.reduce((sum, row) => sum + Number(row.link_count), 0),
    curated_islands: curated.filter(isIsland).length,
    curated_no_inbound: curated.filter((row) => !row.has_inbound).length,
    curated_timeline_pages: curated.filter((row) => row.has_timeline).length,
    session_pages: sessions.length,
    session_islands: sessions.filter(isIsland).length,
    session_parents: parents.length,
    // "Entity" follows the broad curated-knowledge meaning used by the
    // audit: links to any canonical concept/project/entity type count.
    session_parents_entity_linked: parents.filter((row) => row.has_entity_link).length,
  };
}
