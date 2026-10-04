import type { BrainEngine, NewFact } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
import { decideSingleFact, type FactCandidate, type FactDecision, type SingleFactIntent } from '../facts/single-prepare.ts';

/** Explicit IDs never bypass the source, subject, visibility or live-row boundary. */
export async function decideManagedFact(engine: BrainEngine, sourceId: string,
  fact: SingleFactIntent & Pick<NewFact, 'embedding_model' | 'source'> & { supersedes_fact_id?: number; entity_inferred?: unknown },
  embedding: Float32Array | null): Promise<FactDecision> {
  const id = fact.supersedes_fact_id;
  if (id === undefined) return decideSingleFact(engine, sourceId, fact, embedding, fact.embedding_model, fact.source);
  if (!Number.isSafeInteger(id) || id <= 0 || !fact.entity_slug || fact.entity_inferred) {
    throw new OperationError('invalid_params', 'Explicit supersession requires a valid fact ID and a resolved entity.');
  }
  const [candidate] = await engine.executeRaw<FactCandidate>(`SELECT * FROM facts WHERE id=$1 AND source_id=$2
    AND entity_slug=$3 AND visibility=$4 AND expired_at IS NULL AND superseded_by IS NULL
    AND (valid_until IS NULL OR valid_until>now())
    AND (source_markdown_slug IS NULL OR source_markdown_slug=$3)`, [id, sourceId, fact.entity_slug, fact.visibility]);
  if (!candidate) throw new OperationError('invalid_params', 'The explicit supersession target is unavailable in this fact scope.');
  // Refuse conflicting replay/duplicate intent instead of expiring a target
  // without publishing its replacement. Exact request replay is handled by the journal.
  const exact = await decideSingleFact(engine, sourceId, fact, null);
  if (exact.candidate) throw new OperationError('invalid_params', 'The replacement claim already exists in this fact scope.');
  return { status: 'superseded', candidate: { ...candidate, id: Number(candidate.id) } };
}
