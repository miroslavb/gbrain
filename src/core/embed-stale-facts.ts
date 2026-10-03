/** Explicit, resumable backfill for active fact rows whose vector is NULL. */

import type { BrainEngine } from './engine.ts';
import { embedBatchWithBackoff } from './embed-retry.ts';
import { EmbedProviderFailureCircuit, isProviderWideEmbedFailure } from './embed-provider-circuit.ts';
import { slog } from './console-prefix.ts';
import { getEmbeddingModel, getEmbeddingDimensions } from './ai/gateway.ts';
import { eligibleFactEmbedding } from './facts/embedding-identity.ts';
import { AUDIT_ROW_SOURCES } from './facts/audit-sources.ts';
import { readFactsEmbeddingDim } from './embedding-dim-check.ts';

const DEFAULT_BATCH_SIZE = 128;
const FAILURE_SAMPLE_CAP = 10;

export interface FactEmbeddingBackfillResult {
  pending_before: number;
  pending_after: number;
  snapshot_max_id: number;
  snapshot_remaining: number;
  considered: number;
  embedded: number;
  would_embed: number;
  skipped: number;
  failures: number;
  failure_samples: string[];
  provider_circuit_opened: boolean;
}

export interface FactEmbeddingBackfillOpts {
  sourceId?: string;
  dryRun?: boolean;
  signal?: AbortSignal;
  batchSize?: number;
  quiet?: boolean;
  /** Test seam; production uses the standard retrying embed batch. */
  embedBatch?: (texts: string[], signal?: AbortSignal) => Promise<Float32Array[]>;
}

interface PendingFactRow { id: number; source_id: string; fact: string; version: string; incarnation: string }
interface PendingStats { count: number; maxId: number }

function vectorLiteral(v: Float32Array): string {
  return `[${Array.from(v).join(',')}]`;
}

async function pendingStats(
  engine: BrainEngine,
  sourceId?: string,
  maxId?: number,
): Promise<PendingStats> {
  const params: unknown[] = [sourceId ?? null, [...AUDIT_ROW_SOURCES]];
  const sourceClause = ' AND ($1::text IS NULL OR f.source_id=$1)';
  const watermarkClause = maxId === undefined ? '' : ` AND id <= $${params.push(maxId)}`;
  const rows = await engine.executeRaw<{ n: number; max_id: number | string }>(
    `SELECT count(*)::int AS n, COALESCE(max(f.id), 0) AS max_id FROM facts f
      WHERE f.embedding IS NULL AND ${eligibleFactEmbedding}${sourceClause}${watermarkClause}`,
    params,
  );
  return { count: Number(rows[0]?.n ?? 0), maxId: Number(rows[0]?.max_id ?? 0) };
}

async function listPending(
  engine: BrainEngine,
  afterId: number,
  maxId: number,
  limit: number,
  sourceId?: string,
): Promise<PendingFactRow[]> {
  const params: unknown[] = [sourceId ?? null, [...AUDIT_ROW_SOURCES], afterId, maxId];
  const sourceClause = ' AND ($1::text IS NULL OR f.source_id=$1)';
  const limitParam = `$${params.push(limit)}`;
  const rows = await engine.executeRaw<PendingFactRow>(
    `SELECT f.id, f.source_id, f.fact, f.xmin::text AS version, s.incarnation::text FROM facts f
      JOIN sources s ON s.id=f.source_id
      WHERE f.embedding IS NULL AND ${eligibleFactEmbedding} AND f.id > $3 AND f.id <= $4${sourceClause}
      ORDER BY f.id ASC LIMIT ${limitParam}`,
    params,
  );
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}

async function assertModel(engine: BrainEngine, model: string, dimensions: number): Promise<void> {
  if (getEmbeddingModel() !== model || getEmbeddingDimensions() !== dimensions
    || await engine.getConfig('embedding_model') !== model
    || Number(await engine.getConfig('embedding_dimensions')) !== dimensions
    || await engine.getConfig('embedding_disabled') === 'true') {
    throw new Error('Fact embedding configuration changed or is disabled; finish the reviewed model migration first');
  }
}

async function writeOne(
  engine: BrainEngine, row: PendingFactRow, embedding: Float32Array,
  cast: 'vector' | 'halfvec', model: string, dimensions: number,
): Promise<boolean> {
  if (embedding.length !== dimensions || !Array.from(embedding).every(Number.isFinite)) {
    throw new Error('Fact embedding provider returned an invalid vector');
  }
  return engine.transaction(async tx => {
    await tx.executeRaw("SELECT key FROM config WHERE key IN ('embedding_model','embedding_dimensions','embedding_disabled') ORDER BY key FOR SHARE");
    await assertModel(tx, model, dimensions);
    const rows = await tx.executeRaw<{ id: number }>(
      `UPDATE facts f SET embedding=$3::${cast}, embedded_at=NOW(), embedding_model=$4, embedded_text_hash=md5(f.fact)
        WHERE f.id=$1 AND ${eligibleFactEmbedding} AND f.embedding IS NULL
          AND f.source_id=$5 AND f.fact=$6 AND f.xmin::text=$7
          AND EXISTS (SELECT 1 FROM sources s WHERE s.id=f.source_id AND s.incarnation::text=$8)
        RETURNING f.id`,
      [row.id, [...AUDIT_ROW_SOURCES], vectorLiteral(embedding), model, row.source_id, row.fact, row.version, row.incarnation],
    );
    return rows.length === 1;
  });
}

function sample(result: FactEmbeddingBackfillResult, row: PendingFactRow, error: unknown): void {
  if (result.failure_samples.length >= FAILURE_SAMPLE_CAP) return;
  result.failure_samples.push(
    `fact#${row.id} (${row.source_id}): ${error instanceof Error ? error.message : String(error)}`,
  );
}

async function embedIsolated(
  rows: PendingFactRow[],
  embedBatch: (texts: string[], signal?: AbortSignal) => Promise<Float32Array[]>,
  signal?: AbortSignal,
): Promise<{
  embeddings: Map<number, Float32Array>;
  contentFailures: Array<{ row: PendingFactRow; error: unknown }>;
  providerError?: unknown;
}> {
  const embeddings = new Map<number, Float32Array>();
  const contentFailures: Array<{ row: PendingFactRow; error: unknown }> = [];
  try {
    const vectors = await embedBatch(rows.map((r) => r.fact), signal);
    for (let i = 0; i < rows.length; i++) {
      const vector = vectors[i];
      if (vector) embeddings.set(rows[i].id, vector);
      else contentFailures.push({ row: rows[i], error: new Error('provider returned no embedding') });
    }
    return { embeddings, contentFailures };
  } catch (error) {
    if (isProviderWideEmbedFailure(error)) return { embeddings, contentFailures, providerError: error };
  }

  for (const row of rows) {
    if (signal?.aborted) break;
    try {
      const vector = (await embedBatch([row.fact], signal))[0];
      if (vector) embeddings.set(row.id, vector);
      else contentFailures.push({ row, error: new Error('provider returned no embedding') });
    } catch (error) {
      if (isProviderWideEmbedFailure(error)) return { embeddings, contentFailures, providerError: error };
      contentFailures.push({ row, error });
    }
  }
  return { embeddings, contentFailures };
}

/**
 * Backfill NULL active fact vectors only when explicitly requested by the
 * caller. The fact id is the checkpoint: successful rows become non-NULL and
 * naturally disappear from the next run; concurrent expiry/write wins via
 * guarded UPDATE predicates. No fact extraction or external chat LLM occurs.
 */
export async function backfillStaleFactEmbeddings(
  engine: BrainEngine,
  opts: FactEmbeddingBackfillOpts = {},
): Promise<FactEmbeddingBackfillResult> {
  const snapshot = await pendingStats(engine, opts.sourceId);
  const result: FactEmbeddingBackfillResult = {
    pending_before: snapshot.count,
    pending_after: snapshot.count,
    snapshot_max_id: snapshot.maxId,
    snapshot_remaining: snapshot.count,
    considered: 0,
    embedded: 0,
    would_embed: opts.dryRun ? snapshot.count : 0,
    skipped: 0,
    failures: 0,
    failure_samples: [],
    provider_circuit_opened: false,
  };
  if (opts.dryRun || snapshot.count === 0 || opts.signal?.aborted) {
    if (!opts.quiet) logReceipt(result, !!opts.dryRun);
    return result;
  }

  const batchSize = Math.max(1, Math.min(1_000, opts.batchSize ?? DEFAULT_BATCH_SIZE));
  const embed = opts.embedBatch
    ?? ((texts: string[], signal?: AbortSignal) => embedBatchWithBackoff(texts, { abortSignal: signal }));
  const baseSignal = opts.signal ?? new AbortController().signal;
  const circuit = new EmbedProviderFailureCircuit(baseSignal);
  const model = getEmbeddingModel(), dimensions = getEmbeddingDimensions();
  await assertModel(engine, model, dimensions);
  const shape = await readFactsEmbeddingDim(engine);
  if (!shape.exists || shape.dims !== dimensions || !shape.columnType) {
    throw new Error('Facts embedding dimensions differ from the configured model');
  }
  const cast = shape.columnType;
  let afterId = 0;

  while (!circuit.signal.aborted) {
    const rows = await listPending(engine, afterId, snapshot.maxId, batchSize, opts.sourceId);
    if (rows.length === 0) break;
    afterId = rows[rows.length - 1].id;
    result.considered += rows.length;

    const outcome = await embedIsolated(rows, embed, circuit.signal);
    for (const failure of outcome.contentFailures) {
      result.failures++;
      sample(result, failure.row, failure.error);
    }
    for (const row of rows) {
      const vector = outcome.embeddings.get(row.id);
      if (!vector) continue;
      try {
        if (await writeOne(engine, row, vector, cast, model, dimensions)) result.embedded++;
        else result.skipped++;
      } catch (error) {
        result.failures++;
        sample(result, row, error);
      }
    }

    if (outcome.providerError !== undefined) {
      const unresolved = rows.filter((row) =>
        !outcome.embeddings.has(row.id)
        && !outcome.contentFailures.some((failure) => failure.row.id === row.id));
      result.failures += unresolved.length;
      for (const row of unresolved) sample(result, row, outcome.providerError);
      circuit.recordFailure(outcome.providerError);
    } else {
      circuit.recordSuccess();
    }
  }
  result.provider_circuit_opened = circuit.opened;
  const [after, snapshotAfter] = await Promise.all([
    pendingStats(engine, opts.sourceId),
    pendingStats(engine, opts.sourceId, snapshot.maxId),
  ]);
  result.pending_after = after.count;
  result.snapshot_remaining = snapshotAfter.count;
  if (result.snapshot_remaining > 0 && result.failures === 0) result.failures = 1;
  if (!opts.quiet) logReceipt(result, false);
  return result;
}

function logReceipt(result: FactEmbeddingBackfillResult, dryRun: boolean): void {
  slog(
    `[embed] facts ${dryRun ? 'dry-run' : 'receipt'}: pending_before=${result.pending_before} ` +
    `watermark=${result.snapshot_max_id} considered=${result.considered} embedded=${result.embedded} ` +
    `would_embed=${result.would_embed} skipped=${result.skipped} failures=${result.failures} ` +
    `snapshot_remaining=${result.snapshot_remaining} pending_after=${result.pending_after}`,
  );
}
