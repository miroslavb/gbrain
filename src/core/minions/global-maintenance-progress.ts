/** Aggregate-only, best-effort progress for the brain-wide maintenance job. */
export function createGlobalMaintenanceProgress<T extends string>(
  job: { updateProgress?: (value: Record<string, unknown>) => unknown },
  canonicalPhases: readonly T[],
  requestedPhases: readonly string[],
): {
  phases: T[];
  start: () => Promise<void>;
  completePhase: () => Promise<void>;
} {
  const requested = new Set(requestedPhases.length > 0 ? requestedPhases : canonicalPhases);
  const phases = canonicalPhases.filter((phase) => requested.has(phase));
  let completed = 0;
  const publish = async (phase: string): Promise<void> => {
    try {
      await job.updateProgress?.({
        phase,
        completed_phases: completed,
        total_phases: phases.length,
        last_completed_phase: completed > 0 ? phases[completed - 1] : null,
      });
    } catch {
      // Diagnostics must never turn successful maintenance into a failure.
    }
  };
  return {
    phases,
    start: () => publish(phases[0] ?? 'complete'),
    completePhase: async () => {
      completed++;
      await publish(phases[completed] ?? 'complete');
    },
  };
}
