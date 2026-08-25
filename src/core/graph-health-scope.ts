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
  has_resolvable_entity_hint: boolean;
}

export interface GraphScopeStats {
  typed_curated_pages: number;
  curated_excluded_pages: number;
  curated_pages: number;
  curated_link_endpoints: number;
  curated_islands: number;
  curated_no_inbound: number;
  curated_timeline_pages: number;
  session_pages: number;
  session_islands: number;
  session_parents: number;
  session_parents_entity_eligible: number;
  session_parents_entity_hinted: number;
  session_parents_entity_linked: number;
}

const CANONICAL_GRAPH_SEGMENT = /(^|\/)(?:concepts?|projects?|analysis|analyses|guides?|people|persons?|companies|entities?|organizations?)(?:\/|$)/i;
const GENERATED_GRAPH_SEGMENT = /(^|\/)(?:skills?|optional-skills|tests?|fixtures|website|i18n|node_modules|venv|embedding-venv|raw|imports?)(?:\/|$)/i;

/** Score only canonical memory contours, not type-misclassified repo artifacts. */
export function isCanonicalGraphPage(row: Pick<GraphHealthRow, 'slug' | 'type'>): boolean {
  if (!CURATED_GRAPH_TYPES.has(row.type)) return false;
  const slug = row.slug.toLowerCase();
  return CANONICAL_GRAPH_SEGMENT.test(slug)
    && !GENERATED_GRAPH_SEGMENT.test(slug)
    && !slug.startsWith('docs/inbox/');
}

/** Exact entity-card contour shared by health and onboard coverage. */
export function isCanonicalEntityPage(row: Pick<GraphHealthRow, 'slug' | 'type'>): boolean {
  const slug = row.slug.toLowerCase();
  if (slug.endsWith('/readme')) return false;
  if (row.type === 'person') return /^(?:people|persons?)\/[^/]+$/.test(slug);
  if (row.type === 'company') return /^companies\/[^/]+$/.test(slug);
  if (row.type === 'entity') return /^entities\/[^/]+$/.test(slug);
  if (row.type === 'organization') return /^organizations\/[^/]+$/.test(slug);
  return false;
}

function checkedAlias(alias: string): string {
  if (!/^[a-z][a-z0-9_]*$/i.test(alias)) throw new Error(`unsafe SQL alias: ${alias}`);
  return alias;
}

/** Postgres-compatible SQL twin of {@link isCanonicalGraphPage}. */
export function canonicalGraphSqlPredicate(alias: string): string {
  const a = checkedAlias(alias);
  return `${a}.type IN ('concept','project','analysis','guide','person','company','entity','organization')
    AND lower(${a}.slug) ~ '(^|/)(concepts?|projects?|analysis|analyses|guides?|people|persons?|companies|entities?|organizations?)(/|$)'
    AND lower(${a}.slug) !~ '(^|/)(skills?|optional-skills|tests?|fixtures|website|i18n|node_modules|venv|embedding-venv|raw|imports?)(/|$)'
    AND lower(${a}.slug) NOT LIKE 'docs/inbox/%'`;
}

/** Postgres-compatible SQL twin of {@link isCanonicalEntityPage}. */
export function canonicalEntitySqlPredicate(alias: string): string {
  const a = checkedAlias(alias);
  return `(
    (${a}.type = 'person' AND lower(${a}.slug) ~ '^(people|persons?)/[^/]+$') OR
    (${a}.type = 'company' AND lower(${a}.slug) ~ '^companies/[^/]+$') OR
    (${a}.type = 'entity' AND lower(${a}.slug) ~ '^entities/[^/]+$') OR
    (${a}.type = 'organization' AND lower(${a}.slug) ~ '^organizations/[^/]+$')
  ) AND lower(${a}.slug) !~ '/readme$'`;
}

/** Independently resolvable parent-session project hint (Postgres/PGLite parity). */
export function resolvableCanonicalProjectHintSqlPredicate(parentAlias: string, targetAlias: string): string {
  const p = checkedAlias(parentAlias);
  const target = checkedAlias(targetAlias);
  return `EXISTS (
    SELECT 1 FROM pages ${target}
     WHERE ${target}.deleted_at IS NULL
       AND ${target}.type = 'project'
       AND ${canonicalGraphSqlPredicate(target)}
       AND NULLIF(btrim(${p}.frontmatter->>'project'), '') IS NOT NULL
       AND (lower(${target}.slug) = lower(btrim(${p}.frontmatter->>'project'))
         OR lower(${target}.slug) = lower('projects/' || btrim(${p}.frontmatter->>'project'))
         OR lower(${target}.title) = lower(btrim(${p}.frontmatter->>'project')))
  )`;
}

export function summarizeGraphHealthScope(rows: readonly GraphHealthRow[]): GraphScopeStats {
  const typedCurated = rows.filter((row) => CURATED_GRAPH_TYPES.has(row.type));
  const curated = typedCurated.filter(isCanonicalGraphPage);
  const sessions = rows.filter((row) => row.slug.startsWith('sessions/'));
  const parents = sessions.filter((row) => !row.slug.includes('/segments/'));
  const eligibleParents = parents.filter((row) => row.has_entity_link || row.has_resolvable_entity_hint);
  const isIsland = (row: GraphHealthRow) => Number(row.link_count) === 0;
  return {
    typed_curated_pages: typedCurated.length,
    curated_excluded_pages: typedCurated.length - curated.length,
    curated_pages: curated.length,
    curated_link_endpoints: curated.reduce((sum, row) => sum + Number(row.link_count), 0),
    curated_islands: curated.filter(isIsland).length,
    curated_no_inbound: curated.filter((row) => !row.has_inbound).length,
    curated_timeline_pages: curated.filter((row) => row.has_timeline).length,
    session_pages: sessions.length,
    session_islands: sessions.filter(isIsland).length,
    session_parents: parents.length,
    session_parents_entity_eligible: eligibleParents.length,
    session_parents_entity_hinted: parents.filter((row) => row.has_resolvable_entity_hint).length,
    // "Entity" follows the broad curated-knowledge meaning used by the
    // audit: links to any canonical concept/project/entity type count.
    session_parents_entity_linked: eligibleParents.filter((row) => row.has_entity_link).length,
  };
}
