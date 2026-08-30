import type { BrainEngine } from '../engine.ts';
import { contentHash } from '../utils.ts';

/**
 * Publish one source item's atom completion receipt atomically.
 *
 * The provisional `pending:<hash>` frontmatter is part of PageInput's
 * canonical content hash. Merely flipping the JSONB field to the final hash
 * leaves `pages.content_hash` describing bytes that no longer exist. Keep the
 * receipt's all-or-nothing guarantee while repairing that derived hash in the
 * SAME transaction: if any atom cannot be re-read/re-hashed, the provisional
 * rows remain provisional and discovery safely retries the item.
 *
 * Atom body/chunks do not change, so re-chunking/re-embedding would be wasted
 * spend. Compute the final hashes before publication, then condition every
 * UPDATE on the exact provisional source/content hash we read. A concurrent
 * edit makes the batch fail rather than publishing mixed state.
 */
export async function finalizeAtomCompletionReceipt(
  engine: BrainEngine,
  sourceId: string,
  hash16: string,
  importedSlugs: string[],
): Promise<void> {
  if (importedSlugs.length === 0) return;

  const pendingHash = `pending:${hash16}`;
  const plans: Array<{ slug: string; priorContentHash: string; finalContentHash: string }> = [];
  for (const slug of importedSlugs) {
    const page = await engine.getPage(slug, { sourceId });
    if (!page || !page.content_hash) {
      throw new Error(`atom completion receipt lost imported page ${sourceId}/${slug}`);
    }
    if (page.frontmatter?.source_hash !== pendingHash) {
      throw new Error(
        `atom completion receipt expected ${pendingHash} on ${sourceId}/${slug}, ` +
        `got ${String(page.frontmatter?.source_hash ?? '(missing)')}`,
      );
    }
    const finalFrontmatter = { ...page.frontmatter, source_hash: hash16 };
    plans.push({
      slug,
      priorContentHash: page.content_hash,
      finalContentHash: contentHash({ ...page, frontmatter: finalFrontmatter, content_hash: undefined }),
    });
  }

  const params: unknown[] = [hash16, sourceId, pendingHash];
  const matches: string[] = [];
  const finalHashCases: string[] = [];
  for (const plan of plans) {
    params.push(plan.slug);
    const slugParam = params.length;
    params.push(plan.priorContentHash);
    const priorHashParam = params.length;
    params.push(plan.finalContentHash);
    const finalHashParam = params.length;
    matches.push(`(slug = $${slugParam} AND content_hash = $${priorHashParam})`);
    finalHashCases.push(`WHEN $${slugParam} THEN $${finalHashParam}`);
  }
  const matchSql = matches.join(' OR ');
  const publishSql = `
    WITH eligible AS (
      SELECT COUNT(*)::int AS n
        FROM pages
       WHERE source_id = $2
         AND type = 'atom'
         AND deleted_at IS NULL
         AND frontmatter->>'source_hash' = $3
         AND (${matchSql})
    )
    UPDATE pages
       SET frontmatter = frontmatter || jsonb_build_object('source_hash', $1::text),
           content_hash = CASE slug ${finalHashCases.join(' ')} ELSE content_hash END
     WHERE source_id = $2
       AND type = 'atom'
       AND deleted_at IS NULL
       AND frontmatter->>'source_hash' = $3
       AND (${matchSql})
       AND (SELECT n FROM eligible) = ${plans.length}
    RETURNING slug`;

  const publish = async (target: BrainEngine): Promise<void> => {
    const updated = await target.executeRaw<{ slug: string }>(publishSql, params);
    if (updated.length !== plans.length) {
      throw new Error(
        `atom completion receipt raced on ${sourceId}: expected ${plans.length} rows, updated ${updated.length}`,
      );
    }
  };

  // Postgres may have concurrent writers: throw inside the transaction so a
  // short update caused by a raced row rolls the whole publication back.
  // PGLite is single-writer and the guarded CTE+UPDATE is itself one atomic
  // statement; avoiding an explicit tx here also prevents its transaction
  // object from stalling the next import in the same drain loop.
  if (engine.kind === 'postgres') await engine.transaction(publish);
  else await publish(engine);
}
