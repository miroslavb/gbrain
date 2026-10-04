import type { BrainEngine, NewFact } from '../engine.ts';
import { OperationError, type OperationContext } from '../ops/contract.ts';
import { currentSubmissionAuthority } from '../minions/submission-authority.ts';
import { withCoordinatedWrite } from './context.ts';
import { requestAttribution } from './attribution.ts';
import { currentVerifiedLocalWriter, registerLocalWriter } from './identity.ts';
import { submissionAuthority } from './authority.ts';
import { admitWriteInTransaction, completeWrite } from './journal.ts';
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
    throw new OperationError('permission_denied', 'Managed fact maintenance requires a local writer; remote maintenance jobs are not supported.');
  }
  const [source] = await engine.executeRaw<{ archived: boolean }>('SELECT archived FROM sources WHERE id=$1', [sourceId]);
  if (!source || source.archived) throw new OperationError('source_changed', 'The fact maintenance source is not active.');
  return true;
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
  if (!source) throw new OperationError('source_changed', 'The fact maintenance source is unavailable.');
  const pages = [...new Set(slugs)].sort();
  const slug = pages[0] ?? 'maintenance/derived-facts';
  const authority = await submissionAuthority({ engine, sourceId, remote: false } as OperationContext,
    'submit_job', sourceId, source.incarnation, slug);
  if (authority.slugPrefixes !== null || authority.restrictedNamespace || authority.delegated) {
    throw new OperationError('permission_denied', 'Derived fact maintenance requires an unconfined source grant.');
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
 * Legacy writers keep their own engine call on unmanaged brains. On a managed
 * brain the page must still be live under its lock, so rows are never
 * published for a page deleted or purged while the model ran.
 */
export async function writeDerivedFacts<T>(engine: BrainEngine, sourceId: string, slug: string,
  fn: (db: BrainEngine) => Promise<T>): Promise<T> {
  if (!await managedPersistenceEnabled(engine)) return fn(engine);
  return withDerivedFactsWrite(engine, sourceId, [slug], async tx => {
    const [page] = await tx.executeRaw('SELECT id FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [sourceId, slug]);
    if (!page) throw new OperationError('page_not_found', 'The page was deleted during fact extraction; nothing was written.');
    return fn(tx);
  });
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
      throw new OperationError('revision_conflict', 'The page changed during fact extraction; its prior facts were kept.');
    }
    const [deleted] = await tx.executeRaw<{ count: string }>(
      `WITH del AS (DELETE FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 AND source LIKE $3 RETURNING 1)
       SELECT COUNT(*)::text AS count FROM del`, [sourceId, slug, `${input.sourcePrefix}%`]);
    const rows = await input.build(tx);
    const { inserted } = rows.length ? await tx.insertFacts(rows, { source_id: sourceId }) : { inserted: 0 }; // gbrain-allow-direct-insert: managed replacement of a page's derived fact batch inside the coordinator transaction that deleted the prior batch
    return { deleted: Number(deleted?.count ?? 0), inserted };
  });
}
