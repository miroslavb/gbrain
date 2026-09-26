import type { BrainEngine } from '../engine.ts';
import { renderFactsTable, type ParsedFact } from '../facts-fence.ts';
import { withdrawnFact, withdrawalFenceBlocks } from './withdrawal-overlay.ts';

export interface WithdrawalCommit {
  withdrawn: boolean;
  pages: Array<{ sourceId: string; slug: string; revision: string }>;
}

interface WithdrawalOptions {
  requestId?: string;
  /**
   * Throw instead of returning `withdrawn:false`, so a caller mirroring the
   * canonical file and page in the same transaction rolls back with it.
   */
  strict?: boolean;
}

/** DB-first: no filesystem ownership, provider work or root lock is required. */
export async function recordFactWithdrawal(
  engine: BrainEngine, id: number, sourceId: string, worldOnly = false,
  opts: WithdrawalOptions = {},
): Promise<WithdrawalCommit> {
  return engine.transaction(tx => recordFactWithdrawalInTransaction(tx, id, sourceId, worldOnly, opts));
}

/**
 * Pages that can render this claim: the recorded provenance of every row with
 * the same fingerprint, plus pages whose indexed chunks contain its terms.
 *
 * Fork contract: a withdrawal re-projects only these pages. Upstream v0.51
 * invalidated every page of the source and deleted all of its chunks, which
 * on this host's large default source would drop vector search for the whole
 * source and re-embed it after every forget. A page without current chunks is
 * already outside search; its pending projection applies the ledger overlay.
 */
async function withdrawalPageSlugs(
  tx: Pick<BrainEngine, 'executeRaw'>, sourceId: string, visibility: string, claim: string,
): Promise<string[]> {
  const rows = await tx.executeRaw<{ slug: string }>(
    `SELECT DISTINCT s.slug FROM (
       SELECT f.source_markdown_slug AS slug FROM facts f
        WHERE f.source_id=$1 AND f.visibility=$2 AND gbrain_fact_fingerprint(f.fact)=gbrain_fact_fingerprint($3)
       UNION ALL
       SELECT f.entity_slug FROM facts f
        WHERE f.source_id=$1 AND f.visibility=$2 AND gbrain_fact_fingerprint(f.fact)=gbrain_fact_fingerprint($3)
       UNION ALL
       SELECT p.slug FROM content_chunks cc JOIN pages p ON p.id=cc.page_id
        WHERE p.source_id=$1 AND cc.search_vector @@ plainto_tsquery('english', $3)
     ) s
     WHERE s.slug IS NOT NULL
       AND EXISTS (SELECT 1 FROM pages p WHERE p.source_id=$1 AND p.slug=s.slug)
     ORDER BY s.slug`,
    [sourceId, visibility, claim],
  );
  return rows.map(row => row.slug);
}

/**
 * Durable file-mirror effects belong to a canonical owner. An unmanaged,
 * unbound source (this host's legacy sync) has no owner to publish them; its
 * invalidated pages rebuild through the projection queue, embeddings through
 * the stale-embedding backfill, and every read overlays the ledger.
 */
async function sourceHasCanonicalOwner(tx: Pick<BrainEngine, 'executeRaw'>, sourceId: string): Promise<boolean> {
  const [row] = await tx.executeRaw<{ owned: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM persistence_brain WHERE singleton=1 AND enabled)
         OR EXISTS (SELECT 1 FROM sources s JOIN persistence_source_bindings b
                      ON b.source_id=s.id AND b.source_incarnation=s.incarnation
                     WHERE s.id=$1) AS owned`,
    [sourceId],
  );
  return row?.owned === true;
}

/** Use the caller's transaction when the canonical file and page are mirrored together. */
export async function recordFactWithdrawalInTransaction(
  tx: Pick<BrainEngine, 'executeRaw' | 'lockPageKeys'>, id: number, sourceId: string, worldOnly = false,
  opts: WithdrawalOptions = {},
): Promise<WithdrawalCommit> {
  const none = (message: string): WithdrawalCommit => {
    if (opts.strict) throw new Error(message);
    return { withdrawn: false, pages: [] };
  };
  // Same serialization point as the insert trigger; no disk IO under lock. A
  // managed caller takes this EXCLUSIVE source lock before authority,
  // counters and request rows. Repeating an already-held lock is safe.
  await tx.executeRaw('SELECT id FROM sources WHERE id=$1 FOR UPDATE', [sourceId]);
  const target = `SELECT visibility,fact,expired_at FROM facts WHERE id=$1 AND source_id=$2
    AND ($3::boolean=false OR visibility='world')`;
  const [visible] = await tx.executeRaw<{ visibility: string; fact: string; expired_at: unknown }>(
    target, [id, sourceId, worldOnly]);
  if (!visible) return none('Fact changed before withdrawal; retry with current fact id');
  // Fork contract: forgetting an already-expired id is a no-op. It must not
  // withdraw a live re-assertion of the same claim.
  if (visible.expired_at !== null) return none('Fact expired before withdrawal; refresh current facts');
  const slugs = await withdrawalPageSlugs(tx, sourceId, visible.visibility, visible.fact);
  await tx.lockPageKeys(slugs.map(slug => ({ sourceId, slug })));
  const [row] = await tx.executeRaw<{ visibility: string; fact: string; expired_at: unknown }>(
    `${target} FOR UPDATE`, [id, sourceId, worldOnly]);
  if (!row) return none('Fact changed before withdrawal; retry with current fact id');
  if (row.expired_at !== null) return none('Fact expired before withdrawal; refresh current facts');
  const inserted = await tx.executeRaw(`INSERT INTO fact_withdrawals(source_id,visibility,fact_hash)
    VALUES ($1,$2,gbrain_fact_fingerprint($3)) ON CONFLICT DO NOTHING RETURNING fact_hash`, [sourceId,row.visibility,row.fact]);
  // Repeated instances of the same claim cannot remain active after recall
  // forgets one of them. Visibility and source stay exact authorization axes.
  await tx.executeRaw(`UPDATE facts SET expired_at=now(),valid_until=LEAST(COALESCE(valid_until,now()),now())
    WHERE source_id=$1 AND visibility=$2 AND gbrain_fact_fingerprint(fact)=gbrain_fact_fingerprint($3)
      AND expired_at IS NULL`, [sourceId,row.visibility,row.fact]);
  if (!inserted.length) return none('Fact expired before withdrawal; refresh current facts');
  // Logical revision and projection invalidation commit with the withdrawal.
  // The revision trigger queues durable rebuild work even for unmanaged calls.
  const pages = slugs.length ? await tx.executeRaw<{ slug: string; knowledge_revision: string }>(
    `UPDATE pages SET knowledge_revision=gen_random_uuid(),text_projection_revision=NULL,embedding_signature=NULL
      WHERE source_id=$1 AND slug=ANY($2::text[]) RETURNING slug,knowledge_revision`, [sourceId, slugs]) : [];
  if (slugs.length) {
    await tx.executeRaw(`DELETE FROM content_chunks WHERE page_id IN
      (SELECT id FROM pages WHERE source_id=$1 AND slug=ANY($2::text[]))`, [sourceId, slugs]);
  }
  if (opts.requestId && await sourceHasCanonicalOwner(tx, sourceId)) {
    await tx.executeRaw(`INSERT INTO persistence_effects(request_id,kind,data,source_id,source_incarnation,worktree_id)
      SELECT $1::uuid,k.kind,jsonb_build_object('source_id',s.id,'source_scan',true),s.id,s.incarnation,b.worktree_id
      FROM sources s LEFT JOIN persistence_source_bindings b ON b.source_id=s.id AND b.source_incarnation=s.incarnation
      CROSS JOIN (VALUES ('withdrawal-mirror'),('git'),('embedding')) AS k(kind)
      WHERE s.id=$2 ON CONFLICT(request_id,kind) DO NOTHING`, [opts.requestId, sourceId]);
  }
  return { withdrawn: true, pages: pages.map(page => ({ sourceId, slug: page.slug, revision: page.knowledge_revision })) };
}

async function withdrawalDates(engine: BrainEngine, sourceId: string, facts: readonly ParsedFact[]): Promise<Map<number,string>> {
  if (!facts.length) return new Map();
  const rows = await engine.executeRaw<{ row_num: number; withdrawn_at: string }>(
    `SELECT incoming.row_num, w.withdrawn_at::text FROM jsonb_to_recordset($2::text::jsonb)
      AS incoming(row_num integer,claim text,visibility text)
      JOIN fact_withdrawals w ON w.source_id=$1 AND w.visibility=incoming.visibility
        AND w.fact_hash=gbrain_fact_fingerprint(incoming.claim)`,
    [sourceId, JSON.stringify(facts.map(f => ({ row_num:f.rowNum, claim:f.claim, visibility:f.visibility })))],
  );
  return new Map(rows.map(r => [r.row_num, new Date(r.withdrawn_at).toISOString().slice(0,10)]));
}

/** Overlay stale source files before hashing/chunking, retaining an explicit retraction. */
export async function preserveWithdrawnFenceRows(engine: BrainEngine, sourceId: string, body: string): Promise<string> {
  if (!body.includes('gbrain:facts:begin')) return body;
  const blocks = withdrawalFenceBlocks(body);
  for (const block of blocks.reverse()) {
    // Preserve malformed-fence diagnostics; never re-render a partial parse.
    if (block.parsed.warnings.length) continue;
    const dates = await withdrawalDates(engine, sourceId, block.parsed.facts);
    if (!dates.size) continue;
    const facts = block.parsed.facts.map(f => {
      const date = dates.get(f.rowNum);
      return date ? withdrawnFact(f, date) : f;
    });
    body = body.slice(0, block.start) + renderFactsTable(facts) + body.slice(block.end);
  }
  return body;
}

/** Explicit remember is not an implicit restore operation. */
export async function isFactWithdrawn(engine: BrainEngine, sourceId: string, visibility: string, claim: string): Promise<boolean> {
  const rows = await engine.executeRaw(`SELECT 1 FROM fact_withdrawals
    WHERE source_id=$1 AND visibility=$2 AND fact_hash=gbrain_fact_fingerprint($3)`, [sourceId,visibility,claim]);
  return rows.length > 0;
}
