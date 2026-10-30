/**
 * #7645 class closure (PGLite half; the Postgres half is
 * test/e2e/schema-history-upgrade.test.ts): an immutable upstream fixture
 * since upstream v260, plus eight explicitly verified host-fork overlays,
 * upgrades to the latest fork schema through the production path,
 * initSchema (forward-reference bootstrap, schema blob replay, migrations),
 * and ends with the catalog a fresh install has.
 *
 * The existing replay tests rewind schema_version on a LATEST-shaped brain,
 * so a blob statement that needs a column a later migration adds never meets
 * a table without it. That is how a v265 brain wedged on
 * derived_generation_items_pending (`WHERE pending`, a v266 column) while
 * every test stayed green. These fixtures are real older brains, captured
 * from each release's own engine, so the next missing forward reference
 * fails here. These are upstream shared-schema fixtures, not historical fork
 * releases; see test/FORK_SCHEMA_HISTORY.md for the guarded adapter boundary.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { LATEST_VERSION, MIGRATIONS, runMigrations } from '../src/core/migrate.ts';
import { adaptUpstreamSchemaHistoryFixture, expectedHistoryPendingMigrations } from './helpers/schema-history-fork-adapter.ts';
import { CATALOG_CONFIGS, capturePgliteFreshInstall, pgliteCatalogQuery, pgliteFunctionBodies, withCatalogConfig } from './helpers/schema-catalog.ts';
import { snapshotCatalog } from './helpers/schema-diff.ts';
import { withColdPglite } from './helpers/with-snapshot.ts';
import {
  FIRST_SCHEMA_HISTORY_VERSION, schemaHistoryDrift, schemaHistorySql, schemaHistoryVersions, type InstalledSchema,
} from './helpers/schema-history.ts';

const versions = schemaHistoryVersions('pglite');
let fresh: InstalledSchema;

beforeAll(async () => {
  fresh = await withCatalogConfig(CATALOG_CONFIGS[0], () => capturePgliteFreshInstall());
}, 120_000);

test('a schema-history fixture exists for every schema version from v260 to the newest captured one', () => {
  const newest = versions[versions.length - 1];
  expect(versions[0]).toBe(FIRST_SCHEMA_HISTORY_VERSION);
  expect(newest).toBeLessThanOrEqual(LATEST_VERSION);
  expect(versions).toEqual(Array.from({ length: newest - FIRST_SCHEMA_HISTORY_VERSION + 1 }, (_, i) => FIRST_SCHEMA_HISTORY_VERSION + i));
});

test('the Postgres fixtures cover the same schema versions as the PGLite ones', () => {
  expect(schemaHistoryVersions('postgres')).toEqual(versions);
});

for (const version of versions) {
  describe(`PGLite upstream v${version} plus explicit fork overlays (#7645)`, () => {
    let engine: PGLiteEngine;
    let upgrade: Promise<void>;

    beforeAll(async () => {
      engine = new PGLiteEngine();
      // Cold: a snapshot-restored engine would already hold the latest schema.
      upgrade = withCatalogConfig(CATALOG_CONFIGS[0], () => withColdPglite(async () => {
        await engine.connect({});
        await engine.db.exec(schemaHistorySql('pglite', version));
        const [{ value }] = (await engine.db.query<{ value: string }>(`SELECT value FROM config WHERE key = 'version'`)).rows;
        if (value !== String(version)) throw new Error(`fixture v${version} restored a brain at schema v${value}`);
        const forkVersion = await adaptUpstreamSchemaHistoryFixture(engine, version);
        const pending = MIGRATIONS.filter(m => m.version > forkVersion).map(({ version, name }) => ({ version, name }));
        expect(pending).toEqual(expectedHistoryPendingMigrations(version));
        expect(pending).toHaveLength(281 - version); // shared upstream tail through 279, then fork v288 and v289
        await engine.initSchema();
      }));
      await upgrade.catch(() => {});
    }, 120_000);

    afterAll(async () => {
      await engine.disconnect();
    });

    test(`reaches v${LATEST_VERSION} through initSchema with a fresh install's catalog`, async () => {
      await upgrade;
      expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));
      expect(schemaHistoryDrift(fresh, {
        catalog: await snapshotCatalog(pgliteCatalogQuery(engine)),
        functionBodies: await pgliteFunctionBodies(engine),
      })).toBe('');
      expect(await runMigrations(engine)).toEqual({ applied: 0, current: LATEST_VERSION });
      expect(schemaHistoryDrift(fresh, {
        catalog: await snapshotCatalog(pgliteCatalogQuery(engine)),
        functionBodies: await pgliteFunctionBodies(engine),
      })).toBe('');
    });
  });
}
