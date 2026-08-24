/** Explicit, resumable backfill for active fact rows whose vector is NULL. */

import type { BrainEngine } from './engine.ts';
import { embedBatchWithBackoff } from './embed-retry.ts';
import { EmbedProviderFailureCircuit, isProviderWideEmbedFailure } from './embed-provider-circuit.ts';
import { slog } from './console-prefix.ts';

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

interface PendingFactRow { id: number; source_id: string; fact: string }
interface PendingStats { count: number; maxId: number }

function vectorLiteral(v: Float32Array): string {
  return `[${Array.from(v).join(',')}]`;
}

async function pendingStats(
  engine: BrainEngine,
  sourceId?: string,
  maxId?: number,
): Promise<PendingStats> {
  const params: unknown[] = [];
  const sourceClause = sourceId ? ` AND source_id = $${params.push(sourceId)}` : '';
  const watermarkClause = maxId === undefined ? '' : ` AND id <= $${params.push(maxId)}`;
  const rows = await engine.executeRaw<{ n: number; max_id: number | string }>(
    `SELECT count(*)::int AS n, COALESCE(max(id), 0) AS max_id FROM facts
      WHERE embedding IS NULL AND expired_at IS NULL${sourceClause}${watermarkClause}`,
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
  const params: unknown[] = [afterId, maxId];
  const sourceClause = sourceId ? ` AND source_id = $${params.push(sourceId)}` : '';
  const limitParam = `$${params.push(limit)}`;
  const rows = await engine.executeRaw<{ id: number; source_id: string; fact: string }>(
    `SELECT id, source_id, fact FROM facts
      WHERE embedding IS NULL AND expired_at IS NULL AND id > $1 AND id <= $2${sourceClause}
      ORDER BY id ASC LIMIT ${limitParam}`,
    params,
  );
  return rows.map((r) => ({ id: Number(r.id), source_id: r.source_id, fact: r.fact }));
}

async function resolveCast(engine: BrainEngine): Promise<'vector' | 'halfvec'> {
  if (engine.kind !== 'postgres') return 'vector';
  try {
    const rows = await engine.executeRaw<{ formatted: string | null }>(`
      SELECT format_type(a.atttypid, a.atttypmod) AS formatted
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'facts'
         AND a.attname = 'embedding' AND NOT a.attisdropped
    `);
    return /halfvec\(\d+\)/i.test(rows[0]?.formatted ?? '') ? 'halfvec' : 'vector';
  } catch {
    return 'vector';
  }
}

async function writeOne(
  engine: BrainEngine,
  row: PendingFactRow,
  embedding: Float32Array,
  cast: 'vector' | 'halfvec',
): Promise<boolean> {
  const rows = await engine.executeRaw<{ id: number }>(
    `UPDATE facts SET embedding = $2::${cast}, embedded_at = NOW()
      WHERE id = $1 AND source_id = $3 AND fact = $4
        AND embedding IS NULL AND expired_at IS NULL
      RETURNING id`,
    [row.id, vectorLiteral(embedding), row.source_id, row.fact],
  );
  return rows.length === 1;
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
  const cast = await resolveCast(engine);
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
        if (await writeOne(engine, row, vector, cast)) result.embedded++;
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
