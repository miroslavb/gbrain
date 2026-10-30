import type { BrainEngine } from '../engine.ts';
import { type AtomPageInput, AtomPageStateError } from './extract-atoms-page-state.ts';
import { contentHash } from '../utils.ts';
import { assertInlineBody } from '../page-body/page-shape.ts';
import type { BodyStorage } from '../page-body/types.ts';

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
  origin?: AtomPageInput,
  opts: { inTransaction?: boolean; allowPreviousCompletion?: boolean } = {},
): Promise<void> {
  if (importedSlugs.length === 0) return;

  // Completion hashes the entire inline snapshot. Segmented outputs/origins
  // need a separate streamed receipt protocol; refuse before reading bodies or
  // flipping any receipt, even if this caller bypassed normal atom discovery.
  if (origin) {
    if (!origin.identity) throw new AtomPageStateError('unpinned');
    const [storedOrigin] = await engine.executeRaw<{ slug: string; source_id: string; body_storage: BodyStorage }>(
      `SELECT slug, source_id, body_storage FROM pages WHERE id=$1 AND source_id=$2 AND deleted_at IS NULL`,
      [origin.identity.pageId, sourceId]);
    if (!storedOrigin) throw new AtomPageStateError('changed');
    assertInlineBody(storedOrigin, 'finalizeAtomCompletionReceipt origin');
  }
  const pendingHash = `pending:${hash16}`;
  const plans: Array<{ slug: string; priorContentHash: string; priorSourceHash: string; finalContentHash: string; sealed: boolean }> = [];
  for (const slug of importedSlugs) {
    const page = await engine.getPage(slug, { sourceId });
    if (!page || !page.content_hash) {
      throw new Error(`atom completion receipt lost imported page ${sourceId}/${slug}`);
    }
    assertInlineBody(page, 'finalizeAtomCompletionReceipt atom');
    const priorSourceHash = page.frontmatter?.source_hash;
    // The generation planner keeps an unchanged atom without importing it again.
    // Its prior completed source receipt may advance only under this transaction's
    // page locks, and the UPDATE still pins both exact old hashes.
    const keptCompletion = opts.inTransaction && opts.allowPreviousCompletion
      && typeof priorSourceHash === 'string' && /^[a-f0-9]{16}$/.test(priorSourceHash);
    if (priorSourceHash !== pendingHash && !keptCompletion) {
      throw new Error(
        `atom completion receipt expected ${pendingHash} on ${sourceId}/${slug}, ` +
        `got ${String(page.frontmatter?.source_hash ?? '(missing)')}`,
      );
    }
    const finalFrontmatter = { ...page.frontmatter, source_hash: hash16 };
    plans.push({
      slug,
      sealed: page.text_projection_revision != null && page.text_projection_revision === page.knowledge_revision,
      priorContentHash: page.content_hash,
      priorSourceHash: priorSourceHash as string,
      finalContentHash: contentHash({ ...page, frontmatter: finalFrontmatter, content_hash: undefined }),
    });
  }

  const params: unknown[] = [hash16, sourceId];
  const matches: string[] = [];
  const finalHashCases: string[] = [];
  for (const plan of plans) {
    params.push(plan.slug);
    const slugParam = params.length;
    params.push(plan.priorContentHash);
    const priorHashParam = params.length;
    params.push(plan.finalContentHash);
    const finalHashParam = params.length;
    params.push(plan.priorSourceHash);
    const priorSourceParam = params.length;
    matches.push(`(slug = $${slugParam} AND content_hash = $${priorHashParam} AND frontmatter->>'source_hash' = $${priorSourceParam})`);
    finalHashCases.push(`WHEN $${slugParam} THEN $${finalHashParam}`);
  }
  let originGuard = '';
  if (origin) {
    if (!origin.identity) throw new AtomPageStateError('unpinned');
    const start = params.length;
    params.push(origin.identity.pageId, origin.identity.sourceIncarnation, origin.contentHash, origin.identity.revision, origin.content);
    originGuard = `AND EXISTS (SELECT 1 FROM pages origin JOIN sources s ON s.id=origin.source_id
      WHERE origin.id=$${start+1} AND s.incarnation=$${start+2}::uuid AND origin.source_id=$2
        AND origin.content_hash=$${start+3} AND origin.knowledge_revision=$${start+4}::uuid
        AND origin.body_storage='inline' AND origin.compiled_truth=$${start+5}
        AND origin.deleted_at IS NULL FOR SHARE OF origin, s)`;
  }
  const matchSql = matches.join(' OR ');
  const publishSql = `
    WITH eligible AS (
      SELECT COUNT(*)::int AS n
        FROM pages
       WHERE source_id = $2
         AND type = 'atom'
         AND body_storage = 'inline'
         AND deleted_at IS NULL
         AND (${matchSql})
    )
    UPDATE pages
       SET frontmatter = frontmatter || jsonb_build_object('source_hash', $1::text),
           content_hash = CASE slug ${finalHashCases.join(' ')} ELSE content_hash END
     WHERE source_id = $2
       AND type = 'atom'
       AND body_storage = 'inline'
       AND deleted_at IS NULL
       AND (${matchSql})
       AND (SELECT n FROM eligible) = ${plans.length}
       ${originGuard}
    RETURNING slug`;

  const publish = async (target: BrainEngine): Promise<void> => {
    const updated = await target.executeRaw<{ slug: string }>(publishSql, params);
    if (updated.length !== plans.length) {
      throw new Error(
        `atom completion receipt changed on ${sourceId}: expected ${plans.length} rows, updated ${updated.length}`,
      );
    }
    // Receipt metadata changes no chunk text. Preserve the seal only for rows
    // whose text projection was current immediately before the guarded flip.
    const sealed = plans.filter(plan => plan.sealed).map(plan => plan.slug);
    if (sealed.length) await target.executeRaw(`UPDATE pages SET text_projection_revision = knowledge_revision
      WHERE source_id=$1 AND slug=ANY($2::text[]) AND type='atom' AND deleted_at IS NULL
        AND frontmatter->>'source_hash'=$3 AND text_projection_revision IS NULL`, [sourceId, sealed, hash16]);
  };

  // Postgres may have concurrent writers: throw inside the transaction so a
  // short update caused by a raced row rolls the whole publication back.
  // PGLite is single-writer and the guarded CTE+UPDATE is itself one atomic
  // statement; avoiding an explicit tx here also prevents its transaction
  // object from stalling the next import in the same drain loop.
  if (engine.kind === 'postgres' && !opts.inTransaction) await engine.transaction(publish);
  else await publish(engine);
}
