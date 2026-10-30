/**
 * Test-only bridge from a pinned, empty upstream fixture to the matching shared
 * fork schema. This is not an import or migration path for an operator's brain.
 * The original SQL dumps and production migration modules stay immutable.
 */
import type { BrainEngine } from '../../src/core/engine.ts';
import { v141 } from '../../src/core/schema-migrations/v141-links-identity-nulls-not-distinct-repair.ts';
import { v142 } from '../../src/core/schema-migrations/v142-grounded-take-proposal-receipts.ts';
import { v143 } from '../../src/core/schema-migrations/v143-take-proposal-rejection-reason-receipts.ts';
import { v144 } from '../../src/core/schema-migrations/v144-take-proposal-rejection-reason-jsonb-object.ts';
import { v145 } from '../../src/core/schema-migrations/v145-legacy-extract-receipt-raw-trace-exemptions.ts';
import { v146 } from '../../src/core/schema-migrations/v146-extract-health-current-state.ts';
import { v147 } from '../../src/core/schema-migrations/v147-world-only-host-visibility.ts';
import { v152 } from '../../src/core/schema-migrations/v152-world-only-host-visibility-convergence-guard.ts';
import { historyRefuse, schemaHistoryForkManifest, verifiedSchemaHistoryFixture, verifyForkOverlayFiles } from './schema-history-fixture.ts';

const OVERLAYS = [v141, v142, v143, v144, v145, v146, v147, v152];
const ident = (name: string) => '"' + name.replaceAll('"', '""') + '"';
type Fixture = ReturnType<typeof verifiedSchemaHistoryFixture>;

/** Every row must be one the pinned dump actually inserted, not merely in an allowed table. */
async function assertRestoredPreimage(engine: BrainEngine, fixture: Fixture): Promise<void> {
  const rows = await engine.executeRaw<{ name: string }>(`SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e') ORDER BY c.relname`);
  if (JSON.stringify(rows.map(row => row.name)) !== JSON.stringify(fixture.tables)) historyRefuse('restored table inventory differs');
  const stamps = await engine.executeRaw<{ value: string }>("SELECT value FROM config WHERE key='version' FOR UPDATE");
  if (stamps.length !== 1 || stamps[0].value !== String(fixture.metadata.upstreamVersion)) historyRefuse('restored version mismatch');
  const counts = await engine.executeRaw<{ name: string; n: string }>(fixture.tables.map(table =>
    `SELECT '${table.replaceAll("'", "''")}' AS name,count(*)::text AS n FROM public.${ident(table)}`).join(' UNION ALL '));
  for (const { name, n } of counts) {
    if (Number(n) !== (fixture.seeds.get(name)?.length ?? 0)) historyRefuse(`unexpected rows in ${name}`);
  }
  for (const [table, seed] of fixture.seeds) {
    const [result] = await engine.executeRaw<{ matches: boolean }>(`SELECT NOT EXISTS (
      SELECT to_jsonb(actual) FROM public.${ident(table)} actual EXCEPT ALL
      SELECT to_jsonb(expected) FROM json_populate_recordset(NULL::public.${ident(table)},$1::text::json) expected
    ) AS matches`, [JSON.stringify(seed)]);
    if (result?.matches !== true) historyRefuse(`seed row mismatch in ${table}`);
  }
}

async function assertForkPostconditions(engine: BrainEngine): Promise<void> {
  for (const migration of OVERLAYS) {
    if (!migration.verify || await migration.verify(engine) !== true) historyRefuse(`fork v${migration.version} verify failed`);
  }
  const [columns] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM information_schema.columns
    WHERE table_schema='public' AND table_name='take_proposals' AND column_name IN ('evidence_span','source_hash') AND data_type='text'`);
  const [constraint] = await engine.executeRaw<{ definition: string }>(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
    WHERE conrelid='proposal_page_runs'::regclass AND conname='proposal_page_runs_rejection_reason_counts_object_check'`);
  if (columns?.n !== 2 || !/jsonb_typeof\(rejection_reason_counts\) = 'object'::text/.test(constraint?.definition ?? '')) {
    historyRefuse('fork proposal schema postcondition failed');
  }
  if (engine.kind === 'postgres') {
    const rls = await engine.executeRaw<{ name: string; enabled: boolean; forced: boolean }>(`SELECT relname AS name,relrowsecurity AS enabled,relforcerowsecurity AS forced
      FROM pg_class WHERE oid IN ('public.proposal_page_runs'::regclass,'public.extract_health_state'::regclass)`);
    if (rls.length !== 2 || rls.some(row => !row.enabled || row.forced)) historyRefuse('fork table RLS postcondition failed');
  }
}

/** Returns the honest shared-schema checkpoint; native initSchema must still run afterwards. */
export async function adaptUpstreamSchemaHistoryFixture(engine: BrainEngine, upstreamVersion: number): Promise<number> {
  const fixture = verifiedSchemaHistoryFixture(engine.kind, upstreamVersion);
  verifyForkOverlayFiles();
  if (JSON.stringify(OVERLAYS.map(({ version, name }) => ({ version, name }))) !==
    JSON.stringify(schemaHistoryForkManifest.forkOverlays.map(({ version, name }) => ({ version, name })))) historyRefuse('fork overlay identity mismatch');
  return engine.transaction(async tx => {
    await assertRestoredPreimage(tx, fixture);
    for (const migration of OVERLAYS) {
      const sql = migration.sqlFor?.[engine.kind] ?? migration.sql;
      if (sql) await tx.runMigration(migration.version, sql);
      if (migration.handler) await migration.handler(tx); // v142 retains its native nested transaction/savepoint.
      if (!migration.verify || await migration.verify(tx) !== true) historyRefuse(`fork v${migration.version} verify failed`);
    }
    if (engine.kind === 'postgres') {
      // The historical upstream RLS list predates these two fork tables. No policies or FORCE are added.
      await tx.executeRaw('ALTER TABLE public.proposal_page_runs ENABLE ROW LEVEL SECURITY');
      await tx.executeRaw('ALTER TABLE public.extract_health_state ENABLE ROW LEVEL SECURITY');
    }
    await assertForkPostconditions(tx);
    const stamped = await tx.executeRaw<{ value: string }>("UPDATE config SET value=$2 WHERE key='version' AND value=$1 RETURNING value",
      [String(upstreamVersion), String(fixture.metadata.forkVersion)]);
    if (stamped.length !== 1 || stamped[0].value !== String(fixture.metadata.forkVersion)) historyRefuse('conditional fork stamp failed');
    return fixture.metadata.forkVersion;
  });
}

/** Exact reviewed names and versions, rather than accepting any tail with the right count. */
export function expectedHistoryPendingMigrations(upstreamVersion: number) {
  return [...schemaHistoryForkManifest.sharedPendingMigrations.filter(m => m.upstreamVersion > upstreamVersion)
    .map(m => ({ version: m.forkVersion, name: m.name })), ...schemaHistoryForkManifest.forwardForkMigrations];
}
