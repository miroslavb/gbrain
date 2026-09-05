/** Exact replay detection under the caller's page lock; no embeddings or LLM.
 * Match the full persisted claim coordinates, never merely lowercased text.
 * Independent sources, contexts, sessions, dates, kinds and metrics stay distinct.
 */
import type { BrainEngine } from '../engine.ts';
import type { ParsedFact } from '../facts-fence.ts';
import type { FenceInputFact, FenceTarget } from './fence-write.ts';

const day = (value: Date | string | null | undefined): string | null =>
  value == null || value === '' ? null : new Date(value).toISOString().slice(0, 10);

function key(f: FenceInputFact, now: Date): string | null {
  // Supersession changes lineage; an identical replacement must still execute.
  // Event/commitment occurrences must not collapse at the fence's day precision.
  if (f.supersedesFactId !== undefined || f.kind === 'event' || f.kind === 'commitment') return null;
  return JSON.stringify([f.fact, f.kind ?? 'fact', f.confidence ?? 1,
    f.visibility, f.notability ?? 'medium', day(f.validFrom ?? now), day(f.validUntil),
    f.source, f.context ?? null, f.sessionId]);
}

type Ref = { id: number } | { index: number };
export interface ExactFenceSelection {
  facts: FenceInputFact[];
  duplicate: number;
  resolveIds(ids: number[]): number[];
}

export async function selectExactFenceFacts(
  engine: BrainEngine, target: FenceTarget, fence: ParsedFact[],
  inputs: FenceInputFact[], now = new Date(),
): Promise<ExactFenceSelection> {
  const possible = fence.filter(f => f.active && !f.claimMetric && f.claimValue == null
    && !f.claimUnit && !f.claimPeriod && inputs.some(i => i.fact === f.claim));
  const existing = new Map<string, number>();
  if (possible.length) {
    const rows = await engine.executeRaw<{
      id: string | number; row_num: number; fact: string; kind: FenceInputFact['kind'];
      confidence: number; visibility: FenceInputFact['visibility']; notability: FenceInputFact['notability'];
      valid_from: Date | string; valid_until: Date | string | null; source: string;
      context: string | null; source_session: string | null;
    }>(`SELECT id,row_num,fact,kind,confidence,visibility,notability,valid_from,
               valid_until,source,context,source_session FROM facts
        WHERE source_id=$1 AND entity_slug=$2 AND source_markdown_slug=$2
          AND row_num=ANY($3::int[]) AND expired_at IS NULL
          AND (valid_until IS NULL OR valid_until>now())
          AND claim_metric IS NULL AND claim_value IS NULL AND claim_unit IS NULL
          AND claim_period IS NULL AND dimension IS NULL AND event_type IS NULL
          AND value IS NULL AND value_hash IS NULL AND dim_status IS NULL
          AND consolidated_at IS NULL AND consolidated_into IS NULL AND superseded_by IS NULL`,
    [target.sourceId, target.slug, possible.map(f => f.rowNum)]);
    for (const row of rows) {
      const f = possible.find(f => f.rowNum === row.row_num);
      if (!f) continue;
      const dbKey = key({ fact: row.fact, kind: row.kind, confidence: row.confidence,
        visibility: row.visibility, notability: row.notability,
        validFrom: new Date(row.valid_from), validUntil: row.valid_until ? new Date(row.valid_until) : null,
        source: row.source, context: row.context, sessionId: row.source_session, embedding: null }, now);
      const fileKey = key({ fact: f.claim, kind: f.kind, confidence: f.confidence,
        visibility: 'world', notability: f.notability,
        validFrom: f.validFrom ? new Date(f.validFrom) : undefined,
        validUntil: f.validUntil ? new Date(f.validUntil) : null,
        source: f.source ?? '', context: f.context, sessionId: row.source_session, embedding: null }, now);
      const id = Number(row.id);
      if (dbKey && fileKey === dbKey && Number.isSafeInteger(id) && id > 0 && !existing.has(dbKey)) {
        existing.set(dbKey, id);
      }
    }
  }
  const facts: FenceInputFact[] = [];
  const refs: Ref[] = [];
  const seen = new Map<string, Ref>();
  for (const input of inputs) {
    // Freeze the date once: midnight between selection and serialization must
    // not turn a checked old-day duplicate into a new-day fact.
    const f = { ...input, validFrom: input.validFrom ?? now };
    const k = key(f, now);
    const id = k ? existing.get(k) : undefined;
    const repeated = k ? seen.get(k) : undefined;
    const ref: Ref = id !== undefined ? { id } : repeated ?? { index: facts.length };
    if (id === undefined && !repeated) facts.push(f);
    refs.push(ref);
    if (k) seen.set(k, ref);
  }
  return { facts, duplicate: inputs.length - facts.length, resolveIds(ids) {
    return refs.map(ref => {
      const id = 'id' in ref ? ref.id : ids[ref.index];
      if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Exact fact dedup lost an input receipt');
      return id;
    });
  } };
}
