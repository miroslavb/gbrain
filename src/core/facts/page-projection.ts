/** File body projection shared by fact writes and retirement. No LLM/backstop.
 * content_hash remains the last fully indexed hash: sync must still rechunk.
 */
import { parseMarkdown } from '../markdown.ts';

export interface FactPageProjection {
  slug: string;
  type: string;
  title: string;
  compiledTruth: string;
  timeline: string;
  frontmatter: Record<string, unknown>;
  sourcePath: string;
}

export function factPageProjection(body: string, slug: string, sourcePath: string): FactPageProjection {
  const parsed = parseMarkdown(body, slug + '.md');
  return { slug, type: parsed.type, title: parsed.title,
    compiledTruth: parsed.compiled_truth, timeline: parsed.timeline,
    frontmatter: parsed.frontmatter, sourcePath };
}

/** Called inside the SAME transaction as fact mutations, explicitly source scoped.
 * Existing metadata, chunks, links and index hash remain untouched. A tombstone
 * blocks the whole transaction; a verified new entity stub gets a body-only row.
 */
export async function projectFactPageBody(
  query: (sql: string, params: unknown[]) => Promise<unknown[]>,
  sourceId: string,
  page: FactPageProjection,
): Promise<void> {
  const rows = await query(
    `INSERT INTO pages (source_id, slug, type, title, compiled_truth, timeline, frontmatter, source_path)
     VALUES ($1, $2, $3, $4, $5, $6, $7::text::jsonb, $8)
     ON CONFLICT (source_id, slug) DO UPDATE
       SET compiled_truth = EXCLUDED.compiled_truth, timeline = EXCLUDED.timeline, updated_at = now()
       WHERE pages.deleted_at IS NULL
     RETURNING id`,
    [sourceId, page.slug, page.type, page.title, page.compiledTruth, page.timeline,
      JSON.stringify(page.frontmatter), page.sourcePath],
  );
  if (rows.length !== 1) throw new Error('Fact page projection refused a deleted page');
}
