import { describe, expect, test } from 'bun:test';
import { createGlobalMaintenanceProgress } from '../src/core/minions/global-maintenance-progress.ts';

describe('createGlobalMaintenanceProgress', () => {
  test('canonicalizes requested phases and publishes aggregate-only progress', async () => {
    const updates: Record<string, unknown>[] = [];
    const progress = createGlobalMaintenanceProgress(
      { updateProgress: (value) => updates.push(value) },
      ['first', 'second', 'third'] as const,
      ['third', 'first'],
    );

    expect(progress.phases).toEqual(['first', 'third']);
    await progress.start();
    await progress.completePhase();
    await progress.completePhase();
    expect(updates).toEqual([
      { phase: 'first', completed_phases: 0, total_phases: 2, last_completed_phase: null },
      { phase: 'third', completed_phases: 1, total_phases: 2, last_completed_phase: 'first' },
      { phase: 'complete', completed_phases: 2, total_phases: 2, last_completed_phase: 'third' },
    ]);
  });

  test('progress diagnostics fail open', async () => {
    const progress = createGlobalMaintenanceProgress(
      { updateProgress: () => { throw new Error('fenced'); } },
      ['only'] as const,
      [],
    );
    await expect(progress.start()).resolves.toBeUndefined();
    await expect(progress.completePhase()).resolves.toBeUndefined();
  });
});
