/**
 * #7645 class closure, Postgres half (the PGLite half and the rationale are in
 * test/schema-history-upgrade.slow.test.ts): a pinned upstream Postgres fixture
 * since v260 plus explicit fork overlays upgrades through initSchema and ends with the
 * catalog a fresh install has. Each fixture loads into its own throwaway
 * database. Skips without DATABASE_URL. This does not represent a past fork
 * release or authorize adapting a nonempty brain (test/FORK_SCHEMA_HISTORY.md).
 */
import { describe, expect, test } from 'bun:test';
import postgres from '#postgres';
import { randomUUID } from 'node:crypto';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { LATEST_VERSION, MIGRATIONS, runMigrations } from '../../src/core/migrate.ts';
import { adaptUpstreamSchemaHistoryFixture, expectedHistoryPendingMigrations } from '../helpers/schema-history-fork-adapter.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { CATALOG_CONFIGS, FUNCTION_BODIES_SQL, postgresCatalogQuery, withCatalogConfig } from '../helpers/schema-catalog.ts';
import { snapshotCatalog } from '../helpers/schema-diff.ts';
import { schemaHistoryDrift, schemaHistorySql, schemaHistoryVersions, type InstalledSchema } from '../helpers/schema-history.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

function withDatabase(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

async function withFreshDatabase<T>(fn: (url: string) => Promise<T>): Promise<T> {
  assertSafeE2eDatabaseUrl(DATABASE_URL!);
  const name = `gbrain_test_history_${randomUUID().replace(/-/g, '')}`;
  const admin = postgres(DATABASE_URL!, { max: 1, prepare: false, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE ${name}`);
    try {
      return await fn(withDatabase(DATABASE_URL!, name));
    } finally {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    }
  } finally {
    await admin.end({ timeout: 5 });
  }
}

async function installedSchema(engine: PostgresEngine): Promise<InstalledSchema> {
  const bodies = await engine.sql.unsafe(FUNCTION_BODIES_SQL) as Array<{ key: string; body: string }>;
  return {
    catalog: await snapshotCatalog(postgresCatalogQuery(engine.sql)),
    functionBodies: new Map(bodies.map((r) => [r.key, r.body])),
  };
}

describe.skipIf(skip)('Postgres brains created by older releases upgrade to the latest schema (#7645, E2E)', () => {
  let fresh: InstalledSchema | undefined;
  for (const version of skip ? [] : schemaHistoryVersions('postgres')) {
    test(`upstream v${version} plus explicit fork overlays reaches v${LATEST_VERSION} through initSchema`, async () => {
      await withCatalogConfig(CATALOG_CONFIGS[0], async () => {
        fresh ??= await withFreshDatabase(async (url) => {
          const engine = new PostgresEngine();
          try {
            await engine.connect({ database_url: url, poolSize: 2 });
            await engine.initSchema();
            return await installedSchema(engine);
          } finally {
            await engine.disconnect();
          }
        });
        await withFreshDatabase(async (url) => {
          const loader = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
          try {
            await loader.unsafe(schemaHistorySql('postgres', version));
          } finally {
            await loader.end({ timeout: 5 });
          }
          const engine = new PostgresEngine();
          try {
            await engine.connect({ database_url: url, poolSize: 2 });
            expect(await engine.getConfig('version')).toBe(String(version));
            const forkVersion = await adaptUpstreamSchemaHistoryFixture(engine, version);
            const pending = MIGRATIONS.filter(m => m.version > forkVersion).map(({ version, name }) => ({ version, name }));
            expect(pending).toEqual(expectedHistoryPendingMigrations(version));
            expect(pending).toHaveLength(281 - version);
            await engine.initSchema();
            expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));
            expect(schemaHistoryDrift(fresh!, await installedSchema(engine))).toBe('');
            expect(await runMigrations(engine)).toEqual({ applied: 0, current: LATEST_VERSION });
            expect(schemaHistoryDrift(fresh!, await installedSchema(engine))).toBe('');
          } finally {
            await engine.disconnect();
          }
        });
      });
    }, 180_000);
  }
});
