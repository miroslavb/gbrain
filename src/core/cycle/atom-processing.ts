import type { BrainEngine } from '../engine.ts';

// Opt-in aggregate telemetry. The operator creates one epoch row explicitly;
// neither this helper nor the collector enables work or initializes an epoch.
export const ATOM_PROCESSING_KEY = 'observability.atom_processing.v1';
export const ATOM_PROCESSING_COUNTERS = [
  'eligible_dispatches', 'attempted_scans', 'completed_scans', 'empty_scans',
  'failed_scans', 'published_atoms', 'phase_dispatches', 'no_work_dispatches',
] as const;
type Counter = typeof ATOM_PROCESSING_COUNTERS[number];
type Delta = Partial<Record<Counter, number>>;

export function emptyAtomProcessing(epoch: string) {
  if (!/^[a-f0-9]{64}$/.test(epoch)) throw new Error('Invalid atom processing epoch');
  return { version: 1, scope: 'brain_wide_pages', epoch_sha256: epoch,
    ...Object.fromEntries(ATOM_PROCESSING_COUNTERS.map(key => [key, 0])) };
}

export async function atomProcessingWriter(engine: BrainEngine, dryRun = false) {
  const noop = async (_delta: Delta) => {};
  if (dryRun) return noop;
  const raw = await engine.getConfig(ATOM_PROCESSING_KEY);
  if (raw == null) return noop;
  const state = JSON.parse(raw);
  if (state.version !== 1 || state.scope !== 'brain_wide_pages' ||
      !/^[a-f0-9]{64}$/.test(state.epoch_sha256) ||
      ATOM_PROCESSING_COUNTERS.some(key => !Number.isSafeInteger(state[key]) || state[key] < 0)) {
    throw new Error('Invalid atom processing ledger');
  }
  return async (delta: Delta) => {
    const keys = Object.keys(delta) as Counter[];
    if (!keys.length || keys.some(key => !ATOM_PROCESSING_COUNTERS.includes(key) ||
        !Number.isSafeInteger(delta[key]) || delta[key]! < 0)) throw new Error('Invalid processing delta');
    const params: unknown[] = [ATOM_PROCESSING_KEY, state.epoch_sha256];
    const terms = keys.map(key => {
      params.push(delta[key]);
      return `'${key}', (value::jsonb->>'${key}')::bigint + $${params.length}::bigint`;
    });
    // One atomic increment across processes; old epochs cannot overwrite a
    // reset. No text, source/page IDs, model response or credentials retained.
    const rows = await engine.executeRaw(`UPDATE config
      SET value = (value::jsonb || jsonb_build_object(${terms.join(', ')},
        'last_event_at', clock_timestamp()))::text
      WHERE key=$1 AND value::jsonb->>'epoch_sha256'=$2 RETURNING key`, params);
    if (rows.length !== 1) throw new Error('Atom processing epoch changed');
  };
}
