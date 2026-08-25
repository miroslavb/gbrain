import type { BrainHealth } from '../../../core/types.ts';

type GraphScopeCheck = {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  message: string;
  details?: Record<string, unknown>;
};

const pct = (numerator: number, denominator: number): number =>
  denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : 0;

/** Truthful, disjoint graph denominators: curated knowledge vs session archive. */
export function buildGraphScopeChecks(health: BrainHealth): GraphScopeCheck[] {
  const scope = health.graph_scope;
  if (!scope) return [];
  const curatedIslandPct = pct(scope.curated_islands, scope.curated_pages);
  const curatedNoInboundPct = pct(scope.curated_no_inbound, scope.curated_pages);
  const sessionIslandPct = pct(scope.session_islands, scope.session_pages);
  const parentEntityPct = pct(
    scope.session_parents_entity_linked,
    scope.session_parents_entity_eligible,
  );
  const details = { ...scope };
  return [
    {
      name: 'curated_graph_health',
      status: curatedIslandPct > 50 || curatedNoInboundPct > 50 ? 'warn' : 'ok',
      message: `Canonical curated graph: ${scope.curated_islands}/${scope.curated_pages} islands (${curatedIslandPct}%), ` +
        `${scope.curated_no_inbound}/${scope.curated_pages} without inbound links (${curatedNoInboundPct}%); ` +
        `${scope.curated_excluded_pages}/${scope.typed_curated_pages} typed generated/raw page(s) excluded.`,
      details,
    },
    {
      name: 'session_archive_isolation',
      status: 'ok',
      message: `Session archive: ${scope.session_islands}/${scope.session_pages} islands (${sessionIslandPct}%); excluded from brain-score graph denominators.`,
      details,
    },
    {
      name: 'parent_session_entity_coverage',
      status: scope.session_parents_entity_eligible > 0 && parentEntityPct < 70 ? 'warn' : 'ok',
      message: `Eligible parent-session curated links: ${scope.session_parents_entity_linked}/${scope.session_parents_entity_eligible} (${parentEntityPct}%); ` +
        `${scope.session_parents} raw parent session(s), ${scope.session_parents_entity_hinted} with independently resolvable project metadata.`,
      details,
    },
  ];
}
