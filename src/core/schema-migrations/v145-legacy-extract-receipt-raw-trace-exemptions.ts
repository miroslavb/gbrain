import type { Migration } from './types.ts';

export const v145: Migration = {
    version: 145,
    name: 'legacy_extract_receipt_raw_trace_exemptions',
    // Legacy extraction receipts are operation records rather than synthesized
    // claims. Their durable provenance is the closed run_id/round/source_id
    // tuple already stored on every guarded row. Stamp that explicit policy so
    // doctor does not ask operators to invent a source URI or raw payload.
    idempotent: true,
    sql: `
      UPDATE pages
         SET frontmatter = COALESCE(frontmatter, '{}'::jsonb) || jsonb_build_object(
               'raw_trace_exempt', true,
               'raw_trace_exempt_reason',
               'legacy extraction operation receipt; run_id/round/source_id identify the source operation'
             )
       WHERE deleted_at IS NULL
         AND slug LIKE 'extracts/%'
         AND (type = 'extract_receipt' OR (
           type = 'note' AND frontmatter->>'kind' IN ('takes.proposed', 'facts.conversation')
         ))
         AND frontmatter->>'dream_generated' = 'true'
         AND frontmatter ?& ARRAY['run_id', 'round', 'source_id']
         AND NOT (frontmatter ?| ARRAY['raw_trace', 'raw_source', 'source_uri', 'raw_trace_exempt']);
    `,
    verify: async (engine) => {
      const rows = await engine.executeRaw<{ remaining: number }>(`
        SELECT COUNT(*)::int AS remaining
          FROM pages
         WHERE deleted_at IS NULL
           AND slug LIKE 'extracts/%'
           AND (type = 'extract_receipt' OR (
             type = 'note' AND frontmatter->>'kind' IN ('takes.proposed', 'facts.conversation')
           ))
           AND frontmatter->>'dream_generated' = 'true'
           AND frontmatter ?& ARRAY['run_id', 'round', 'source_id']
           AND NOT (frontmatter ?| ARRAY['raw_trace', 'raw_source', 'source_uri', 'raw_trace_exempt'])
      `);
      return rows[0]?.remaining === 0;
    },
  };
