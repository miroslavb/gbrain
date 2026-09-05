import type { BrainEngine } from './engine.ts';

/** Taxonomy is independent of code storage. Read within the import transaction. */
export async function codePageType(tx: BrainEngine, slug: string, sourceId: string): Promise<string> {
  const [current] = await tx.executeRaw<{ type: string; page_kind: string }>(
    'SELECT type, page_kind FROM pages WHERE slug = $1 AND source_id = $2 AND deleted_at IS NULL FOR UPDATE',
    [slug, sourceId],
  );
  return current?.page_kind === 'code' ? current.type : 'code';
}
