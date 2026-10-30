/** Source-scoped atom backlog counts and cycle evidence used by the doctor check. */
import type { BrainEngine } from '../../../core/engine.ts';
import { resolveHoursEnv as _resolveSyncFreshnessHours } from '../../../core/env-number.ts';

type ExtractAtomsBacklogCounter = (engine: BrainEngine, sourceId?: string) => Promise<number | null>;

export async function countExtractAtomsBacklogBySource(
  engine: BrainEngine,
  countBacklog: ExtractAtomsBacklogCounter,
  sourceIds?: string[],
): Promise<Array<{ source_id: string; backlog: number }> | null> {
  try {
    // Source isolation: a scoped caller (remote run_doctor with a source
    // grant) only ever sees its own ids — the brain-wide roster is for the
    // unscoped local/host path.
    const sources = sourceIds
      ? [...sourceIds].sort().map((source_id) => ({ source_id }))
      : await engine.executeRaw<{ source_id: string }>(
        `SELECT DISTINCT source_id FROM pages WHERE deleted_at IS NULL ORDER BY source_id`,
      );
    const rows: Array<{ source_id: string; backlog: number }> = [];
    for (const src of sources) {
      const backlog = await countBacklog(engine, src.source_id);
      if (backlog === null) return null;
      if (backlog > 0) rows.push({ source_id: src.source_id, backlog });
    }
    return rows;
  } catch {
    return null;
  }
}

/** Total backlog: brain-wide when unscoped, else the sum over the granted ids. */
export async function countExtractAtomsBacklogScoped(
  engine: BrainEngine,
  countBacklog: ExtractAtomsBacklogCounter,
  sourceIds?: string[],
): Promise<number | null> {
  if (!sourceIds) return countBacklog(engine);
  let total = 0;
  for (const id of sourceIds) {
    const n = await countBacklog(engine, id);
    if (n === null) return null;
    total += n;
  }
  return total;
}

export function buildExtractAtomsDrainCommand(
  bySource: Array<{ source_id: string; backlog: number }> | null,
): string {
  if (!bySource || bySource.length === 0) {
    return `gbrain dream --phase extract_atoms --drain --source <source-id> --window 120`;
  }
  if (bySource.length === 1) {
    return `gbrain dream --phase extract_atoms --drain --source ${bySource[0]!.source_id} --window 120`;
  }
  const sources = bySource.map((row) => row.source_id).join(', ');
  return `gbrain dream --phase extract_atoms --drain --source ${bySource[0]!.source_id} --window 120 (repeat for backlog source(s): ${sources})`;
}

export function buildExtractAtomsBacklogFixHint(
  bySource: Array<{ source_id: string; backlog: number }> | null,
): string {
  const drain = buildExtractAtomsDrainCommand(bySource);
  if (bySource && bySource.length > 1) {
    // Multi-source form already ends in a parenthetical — fold the
    // declare-suggestion into it.
    return drain.replace(/\)$/, '; or declare extract_atoms in your active schema pack)');
  }
  return `${drain} (or declare extract_atoms in your active schema pack)`;
}

/**
 * #4576 — evidence that a full routine cycle actually completes on this host.
 * Reads the most recent `last_full_cycle_at` across local_path sources — the
 * canonical "this whole cycle completed" stamp runCycle's exit hook writes
 * and `cycle_freshness` reads. Freshness window is the same
 * GBRAIN_CYCLE_FRESHNESS_WARN_HOURS knob (default 6h) cycle_freshness warns
 * at. `unknown` (sources unreadable) is fail-open: callers must not warn on it.
 */
type FullCycleEvidence =
  | { state: 'fresh' | 'stale'; latestIso: string; ageHours: number; warnHours: number }
  | { state: 'never'; latestIso: null; warnHours: number }
  | { state: 'unknown' };

export async function latestFullCycleEvidence(
  engine: BrainEngine,
  nowMs = Date.now(),
): Promise<FullCycleEvidence> {
  const warnHours = _resolveSyncFreshnessHours('GBRAIN_CYCLE_FRESHNESS_WARN_HOURS', 6);
  try {
    const sources = await engine.listAllSources({ localPathOnly: true });
    let latest = Number.NEGATIVE_INFINITY;
    let latestIso: string | null = null;
    for (const src of sources) {
      const raw = src.config?.last_full_cycle_at;
      if (typeof raw !== 'string') continue;
      const t = new Date(raw).getTime();
      if (Number.isFinite(t) && t > latest) {
        latest = t;
        latestIso = raw;
      }
    }
    if (latestIso === null) return { state: 'never', latestIso: null, warnHours };
    const ageHours = Math.max(0, Math.floor((nowMs - latest) / 3_600_000));
    // Future timestamps (clock skew) count as fresh — cycle_freshness owns
    // the clock-skew signal; this check only needs "does anything run?".
    const state = nowMs - latest <= warnHours * 3_600_000 ? 'fresh' : 'stale';
    return { state, latestIso, ageHours, warnHours };
  } catch {
    return { state: 'unknown' };
  }
}

/**
 * #4576 review fix: can this brain's shape produce per-source
 * last_full_cycle_at stamps at all? Two lanes write them:
 *   - the per-source cycle (autopilot fanout / dream --source / dream --dir
 *     matching a registered local_path) stamps that local_path source;
 *   - the #4700 implicit-default lane stamps the resolved implicit default.
 * A brain with ZERO local_path sources and NO implicit default (the legacy
 * unscoped-dream shape — everything in 'default', dir via sync.repo_path)
 * has neither lane, so evidence state 'never' is a property of the SHAPE,
 * not evidence that nothing runs. Fail-open: a probe error reads as
 * cannot-verify (false), keeping the pre-#4576 ok-with-reassurance.
 */
export async function brainShapeCanCarryCycleStamps(engine: BrainEngine): Promise<boolean> {
  try {
    const sources = await engine.listAllSources({ localPathOnly: true });
    if (sources.length > 0) return true;
    const { resolveImplicitDefaultSourceId } = await import('../../../core/source-resolver.ts');
    const implicitDefault = await resolveImplicitDefaultSourceId(engine);
    // dream only runs the stamping implicit lane for a NON-'default' target.
    return implicitDefault !== null && implicitDefault !== 'default';
  } catch {
    return false;
  }
}
