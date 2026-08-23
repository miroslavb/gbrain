// v0.42.x — Life Chronicle (#2390) advisor collector (Phase A.7).
// Brain-state (not workspace-dependent), so it runs over MCP too. Two signals:
//   - unresolved ontology conflicts (genuine disagreement, not supersession)
//   - recent meetings not yet swept into the timeline (coverage gap)
// Advisory display only (no dispatch_id) — the user runs the shown command.
import type { AdvisorCollector, AdvisorContext, AdvisorFinding } from './types.ts';
import { CHRONICLE_RESCUE_SLUG_PREFIXES, isChronicleEligible } from '../chronicle/eligibility.ts';

export const collectChronicle: AdvisorCollector = {
  id: 'chronicle',
  collect: async (ctx: AdvisorContext): Promise<AdvisorFinding[]> => {
    const findings: AdvisorFinding[] = [];

    // 1. Unresolved ontology conflicts.
    try {
      const conflicts = await ctx.engine.findOntologyConflicts({ minConfidence: 0.5 });
      if (conflicts.length > 0) {
        findings.push({
          id: 'ontology_conflicts',
          severity: 'warn',
          title: `${conflicts.length} entity dimension(s) have conflicting current values`,
          detail: conflicts.slice(0, 5).map((c) => `${c.entity_slug}.${c.dimension}`).join(', '),
          fix: { command_argv: ['gbrain', 'ontology-contradictions'] },
          collector: 'chronicle',
          ask_user: false,
        });
      }
    } catch {
      // Ontology columns may be absent on a brain that hasn't migrated; ignore.
    }

    // 2. Recent Chronicle-eligible pages not yet in the timeline. Enumerate
    // only the small metadata projection, then apply the exact shared JS
    // predicate so advisor, write backstop, and bulk backfill cannot drift.
    try {
      const rows = await ctx.engine.executeRaw<{
        type: string;
        slug: string;
        frontmatter: Record<string, unknown> | null;
        body_chars: number | string;
      }>(
        `SELECT p.type, p.slug, p.frontmatter,
                char_length(COALESCE(p.compiled_truth, ''))::int AS body_chars
           FROM pages p
          WHERE (
              p.type IN ('meeting','conversation','calendar-event')
              OR EXISTS (
                SELECT 1 FROM unnest($1::text[]) AS rescue(prefix)
                WHERE starts_with(p.slug, rescue.prefix)
              )
            )
            AND p.deleted_at IS NULL
            AND p.updated_at > now() - interval '30 days'
            AND NOT EXISTS (
              SELECT 1 FROM timeline_entries te
              WHERE te.page_id = p.id AND te.event_page_id IS NOT NULL
            )`,
        [Array.from(CHRONICLE_RESCUE_SLUG_PREFIXES)],
      );
      const gap = rows.reduce((count, row) => {
        const frontmatter = row.frontmatter ?? {};
        const bodyChars = Number(row.body_chars) || 0;
        const eligible = isChronicleEligible({
          type: row.type,
          slug: row.slug,
          body: bodyChars >= 80 ? 'x'.repeat(80) : '',
          dreamGenerated: frontmatter.dream_generated === true,
          messageCount: frontmatter.message_count,
        });
        return count + (eligible.ok ? 1 : 0);
      }, 0);
      if (gap > 0) {
        findings.push({
          id: 'chronicle_coverage_gap',
          severity: 'info',
          title: `${gap} recent meeting(s) aren't in the timeline yet`,
          detail: 'Sweep them into events with `gbrain chronicle-backfill`, or enable auto_chronicle.',
          fix: { command_argv: ['gbrain', 'chronicle-backfill'] },
          collector: 'chronicle',
          ask_user: true,
        });
      }
    } catch {
      // timeline_entries.event_page_id may be absent pre-migration; ignore.
    }

    return findings;
  },
};
