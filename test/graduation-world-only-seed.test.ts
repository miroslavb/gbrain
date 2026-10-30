/** Fork schema seeds must not block graduation or hide existing target data. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { FACTS_DEFAULT_VISIBILITY_KEY, WORLD_VISIBILITY } from '../src/core/facts/visibility.ts';
import { planGraduation, runGraduation, type GraduationOptions } from '../src/core/persistence/engine-graduation.ts';
import { graduationFenceStatus } from '../src/core/persistence/graduation-schema.ts';
import { targetEmptiness } from '../src/core/persistence/graduation-target.ts';
import { makeHarness, openPglite, probeRows, TARGET_URL, type Harness } from './helpers/graduation-harness.ts';

const cases = [
  { name: 'the exact native world seed is empty and can graduate', kind: 'seed' },
  { name: 'a legacy private default remains target data', kind: 'value', value: 'private' },
  { name: 'an uppercase value is not the native seed', kind: 'value', value: 'WORLD' },
  { name: 'a padded value is not the native seed', kind: 'value', value: 'world ' },
  { name: 'an unrelated setting remains target data', kind: 'custom' },
  { name: 'a populated unrelated table remains target data', kind: 'table' },
] as const;

for (const scenario of cases) describe(scenario.name, () => {
  let h: Harness;
  beforeAll(async () => {
    h = await makeHarness();
    await h.target.initSchema();
    const probe = h.deps.probeTarget!;
    h.deps.probeTarget = async routes => ({ ...await probe(routes),
      ...await targetEmptiness(<T>(sql: string, params?: unknown[]) => h.target.executeRaw<T>(sql, params)),
    });
  });
  afterAll(async () => { await h.close(); });

  test('native plan and run preserve the target emptiness boundary', async () => h.inHome(async () => {
    expect(await h.target.getConfig(FACTS_DEFAULT_VISIBILITY_KEY)).toBe(WORLD_VISIBILITY);
    if (scenario.kind === 'value') await h.target.setConfig(FACTS_DEFAULT_VISIBILITY_KEY, scenario.value);
    if (scenario.kind === 'custom') await h.target.setConfig('fork.example.user_setting', 'keep-me');
    if (scenario.kind === 'table') {
      await h.target.executeRaw('CREATE TABLE graduation_foreign_data (id integer PRIMARY KEY, value text NOT NULL)');
      await h.target.executeRaw("INSERT INTO graduation_foreign_data VALUES (1, 'keep-me')");
    }
    const opts: GraduationOptions = { config: { engine: 'pglite', database_path: h.dataDir }, to: 'postgres',
      url: TARGET_URL, env: {}, force: false, deps: h.deps, handoffTimeoutMs: 1_000 };
    const plan = await planGraduation(opts);
    if (scenario.kind === 'seed') {
      expect(plan.blockers).toEqual([]);
      expect((await runGraduation({ ...opts, yes: true, expectPlanHash: plan.planHash })).state).toBe('authoritative');
      expect(await probeRows(h.target)).toEqual([{ id: 1, v: 'alpha' }, { id: 2, v: 'beta' }, { id: 3, v: 'gamma' }]);
      expect(await h.target.getConfig(FACTS_DEFAULT_VISIBILITY_KEY)).toBe(WORLD_VISIBILITY);
      return;
    }
    expect(plan.blockers.some(b => b.kind === 'target_not_empty')).toBe(true);
    await expect(runGraduation({ ...opts, yes: true, expectPlanHash: plan.planHash }))
      .rejects.toMatchObject({ code: 'graduation_target_not_empty' });
    expect((await graduationFenceStatus(h.target)).fenced).toBe(0);
    expect(h.calls.copy ?? 0).toBe(0);
    if (scenario.kind === 'value') expect(await h.target.getConfig(FACTS_DEFAULT_VISIBILITY_KEY)).toBe(scenario.value);
    if (scenario.kind === 'custom') expect(await h.target.getConfig('fork.example.user_setting')).toBe('keep-me');
    if (scenario.kind === 'table') expect(await h.target.executeRaw('SELECT * FROM graduation_foreign_data'))
      .toEqual([{ id: 1, value: 'keep-me' }]);
    const source = await openPglite(h.dataDir);
    try {
      expect(await probeRows(source)).toHaveLength(3);
      await source.executeRaw("INSERT INTO grad_probe VALUES (9, 'still-writable')");
      expect(await probeRows(source)).toHaveLength(4);
    } finally { await source.disconnect(); }
  }), 60_000);
});
