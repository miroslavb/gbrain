import type { BrainEngine, NewFact } from '../engine.ts';
import { OperationError, type OperationContext } from '../ops/contract.ts';
import { currentSubmissionAuthority } from '../minions/submission-authority.ts';
import { withCoordinatedWrite } from './context.ts';
import { requestAttribution } from './attribution.ts';
import { currentVerifiedLocalWriter, registerLocalWriter } from './identity.ts';
import { submissionAuthority } from './authority.ts';
import { admitWriteInTransaction, completeWrite } from './journal.ts';
import { opError } from '../ops/contract.ts';
import { maintenanceTransaction } from './attribution.ts';
import { managedPersistenceEnabled } from './ownership.ts';
import { assertPersistenceAccepting } from './service.ts';

/**
 * Database-only fact rows derived from page text (the fence reconcile, the
 * conversation fact index) never touch a canonical file, so a managed brain
 * publishes them like derived links: inside the coordinator's source
 * capability, serialized on the page key. Returns false on an unmanaged brain.
 * Runs before any provider spend.
 */
export async function managedDerivedFactsPreflight(engine: BrainEngine, sourceId: string): Promise<boolean> {
  if (!await managedPersistenceEnabled(engine)) return false;
  assertPersistenceAccepting(engine);
  const job = currentSubmissionAuthority();
  if (job && job.kind !== 'application' || currentVerifiedLocalWriter()?.remote) {
    throw new OperationError('permission_denied', 'Managed fact maintenance requires a local writer; remote maintenance jobs are not supported.', 'Run the extraction from the verified local CLI or local application worker; a remote maintenance job cannot publish this batch.');
  }
  const [source] = await engine.executeRaw<{ archived: boolean }>('SELECT archived FROM sources WHERE id=$1', [sourceId]);
  if (!source || source.archived) throw new OperationError('source_changed', 'The fact maintenance source is not active.', 'Check the source status and select an active source before starting extraction again.');
  return true;
}


import { deriveTrust, recordTaintEdges } from '../trust/taint.ts';
import { applyGateDecision, derivedGateConfig, derivedGateInput, emptyGateTally, type GateTally } from '../trust/derived-gate.ts';
import { decideFactWrite, recordFlaggedRow } from '../write-gate-store.ts';
import { inheritRelinkedEntities } from '../facts/conversation-relink-carry.ts';

/**
 * #5575 I2: the conversation fact extractor's context is the page alone, so
 * its rows carry the page's stored tier capped at agent_written (an
 * own-session transcript import is agent_written, a third-party one
 * external_untrusted) and an edge to the page.
 */
export const conversationDerivation = (engine: BrainEngine, sourceId: string, slug: string) =>
  deriveTrust(engine, [{ table: 'pages', sourceId, slug }], { channel: 'derive:conversation_facts' });

/** Edges for the fact ids a batch insert returned (`{ ids }`); other results (deletes, counts) record none. */
async function recordInsertedEdges(tx: BrainEngine, sourceId: string, result: unknown, inputs: Awaited<ReturnType<typeof conversationDerivation>>['inputs']) {
  const ids = (result as { ids?: unknown } | null)?.ids;
  for (const id of Array.isArray(ids) ? ids : []) await recordTaintEdges(tx, { table: 'facts', id: Number(id), sourceId }, inputs);
}

/**
 * #5575 B3: one batch of extracted rows through the write gate at the page's
 * declared tier (ENG-18): allowed rows are inserted with their input edges
 * and flag receipts, held rows go to write_gate_holds, rejected rows are
 * counted and skipped.
 */
type FenceRow = NewFact & { row_num: number; source_markdown_slug: string };
export async function insertGatedFacts(tx: BrainEngine, sourceId: string, slug: string, batch: FenceRow[],
  derivation: Awaited<ReturnType<typeof conversationDerivation>>): Promise<{ inserted: number; ids: number[]; write_gate: GateTally }> {
  const rows = await inheritRelinkedEntities(tx, sourceId, slug, batch); // #6764: a cleared free-relinked claim keeps its entity
  const cfg = await derivedGateConfig(tx);
  const input = derivedGateInput(derivation.trust);
  const write_gate = emptyGateTally();
  const decisions = rows.map(row => decideFactWrite({ fact: row.fact, context: row.context, source: row.source },
    { sourceId, slug, payload: { ...row, embedding: null }, input, cfg }));
  for (const decision of decisions) if (decision.action !== 'insert') await applyGateDecision(tx, decision, { table: 'facts', sourceId }, async () => null, write_gate);
  const allowed = rows.filter((_, i) => decisions[i].action === 'insert');
  const flags = decisions.filter(decision => decision.action === 'insert');
  const result = allowed.length ? await tx.insertFacts(allowed, { source_id: sourceId }) : { inserted: 0, ids: [] }; // gbrain-allow-direct-insert: conversation fact rows that passed the write gate
  for (const [i, id] of result.ids.entries()) {
    await recordTaintEdges(tx, { table: 'facts', id, sourceId }, derivation.inputs);
    if (result.ids.length === allowed.length && await recordFlaggedRow(tx, flags[i], { table: 'facts', id, sourceId }) !== null) write_gate.flagged++;
  }
  return { inserted: result.inserted, ids: result.ids, write_gate };
}

/** The conversation fact index's gated batch insert, in writeDerivedFacts' transaction shape (unmanaged brains). */
export async function insertDerivedFacts(engine: BrainEngine, sourceId: string, slug: string, rows: FenceRow[]) {
  const derivation = await conversationDerivation(engine, sourceId, slug);
  return writeDerivedFacts(engine, sourceId, slug, db => insertGatedFacts(db, sourceId, slug, rows, derivation));
}

/**
 * One committed transaction holding the source capability and the page keys,
 * after revalidating (under a shared source lock, before the page locks) that
 * the source is still active: model work may have outlived an archive.
 */
export async function withDerivedFactsWrite<T>(engine: BrainEngine, sourceId: string, slugs: readonly string[],
  fn: (tx: BrainEngine) => Promise<T>): Promise<T> {
  await managedDerivedFactsPreflight(engine, sourceId);
  if (!currentVerifiedLocalWriter()) await registerLocalWriter(engine, 'cli');
  const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [sourceId]);
  if (!source) throw new OperationError('source_changed', 'The fact maintenance source is unavailable.', 'Check the source status and select an active source before starting extraction again.');
  const pages = [...new Set(slugs)].sort();
  const slug = pages[0] ?? 'maintenance/derived-facts';
  const authority = await submissionAuthority({ engine, sourceId, remote: false } as OperationContext,
    'submit_job', sourceId, source.incarnation, slug);
  if (authority.slugPrefixes !== null || authority.restrictedNamespace || authority.delegated) {
    throw new OperationError('permission_denied', 'Derived fact maintenance requires an unconfined source grant.', 'Ask the source owner to run this maintenance locally with source-wide authority; a delegated or slug-limited writer cannot publish it.');
  }
  // Derived rows never stage canonical files. Admission, all mutations and the
  // terminal receipt commit together: no observable queued request, no partial
  // epoch, and no receipt if the callback or its sidecar checks roll back.
  return engine.transaction(async tx => {
    const intent = { kind: 'derived_facts_transaction', pages };
    const row = await admitWriteInTransaction(tx, { principal: authority.principal,
      operation: 'submit_job', sourceId, sourceIncarnation: source.incarnation,
      slug, authority, callerIntent: intent, intent });
    return withCoordinatedWrite(tx, [sourceId], async () => {
      await tx.lockPageKeys(pages.map(page => ({ sourceId, slug: page })));
      const result = await fn(tx);
      await completeWrite(tx, row, 'committed', { kind: intent.kind, status: 'completed',
        derived_pages: pages.length, persistence: { mode: 'database' } });
      return result;
    }, requestAttribution(row));
  });
}

/**
 * Unmanaged brains: database-only fact rows derived from page text (the
 * conversation fact index) commit in one maintenance transaction under the
 * maintenance principal, at the page's derived tier (#5575 I2). A managed
 * brain publishes them as receipted maintenance requests instead
 * (facts/conversation-publication.ts, cycle/extract-facts.ts), so this
 * refuses there rather than write a guarded table without a receipt.
 */
export async function writeDerivedFacts<T>(engine: BrainEngine, sourceId: string, slug: string,
  fn: (db: BrainEngine) => Promise<T>): Promise<T> {
  if (await managedPersistenceEnabled(engine)) {
    throw opError('writer_coordinator_required', 'Managed brains publish derived facts through receipted maintenance requests.',
      `The derived facts of ${slug} in source ${sourceId} were not written: a managed brain publishes them through the coordinator, which this caller bypassed. Run the extraction command again; report this if it repeats.`);
  }
  const { trust, inputs } = await conversationDerivation(engine, sourceId, slug);
  return maintenanceTransaction(engine, async db => { const result = await fn(db); await recordInsertedEdges(db, sourceId, result, inputs); return result; }, trust);
}

/**
 * Managed replacement of one page's derived fact batch. Nothing is written
 * while the model runs; afterwards, under the source capability and page key,
 * `isCurrent` rechecks the page the batch was extracted from, then the rows
 * whose `source` starts with `sourcePrefix` are deleted and `build(tx)`'s rows
 * inserted in the same transaction. A failed extraction or a changed page
 * leaves the prior batch in place.
 */
export async function replaceDerivedFactsForPage(engine: BrainEngine, sourceId: string, slug: string, input: {
  sourcePrefix: string;
  isCurrent: (tx: BrainEngine) => Promise<boolean>;
  build: (tx: BrainEngine) => Promise<Array<NewFact & { row_num: number; source_markdown_slug: string }>>;
}): Promise<{ deleted: number; inserted: number }> {
  return withDerivedFactsWrite(engine, sourceId, [slug], async tx => {
    if (!await input.isCurrent(tx)) {
      throw new OperationError('revision_conflict', 'The page changed during fact extraction; its prior facts were kept.', 'Read the current page and rerun the bounded extraction; do not replay a batch derived from the old revision.');
    }
    const [deleted] = await tx.executeRaw<{ count: string }>(
      `WITH del AS (DELETE FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 AND starts_with(COALESCE(source,''),$3) RETURNING 1)
       SELECT COUNT(*)::text AS count FROM del`, [sourceId, slug, input.sourcePrefix]);
    const rows = await input.build(tx);
    const { inserted } = rows.length ? await insertGatedFacts(tx, sourceId, slug, rows, await conversationDerivation(tx, sourceId, slug)) : { inserted: 0 }; // gbrain-allow-direct-insert: managed replacement of a page's derived fact batch inside the coordinator transaction that deleted the prior batch
    return { deleted: Number(deleted?.count ?? 0), inserted };
  });
}
