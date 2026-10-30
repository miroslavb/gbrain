/** These refusals keep the fixture bridge from masquerading as a live-brain migration. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { v142 } from '../src/core/schema-migrations/v142-grounded-take-proposal-receipts.ts';
import { adaptUpstreamSchemaHistoryFixture } from './helpers/schema-history-fork-adapter.ts';
import { schemaHistoryForkManifest, verifiedSchemaHistoryFixture, verifyForkOverlayFiles } from './helpers/schema-history-fixture.ts';
import { withColdPglite } from './helpers/with-snapshot.ts';

function historyTest(name: string, run: (engine: PGLiteEngine) => Promise<void>) {
  describe(name, () => {
    let engine: PGLiteEngine;
    beforeAll(async () => withColdPglite(async () => {
      engine = new PGLiteEngine();
      await engine.connect({});
      await engine.db.exec(verifiedSchemaHistoryFixture('pglite', 275).sql);
    }));
    afterAll(async () => { await engine?.disconnect(); });
    test('guards the restored fixture', async () => run(engine));
  });
}

test('all 32 immutable dumps and eight exact fork modules match the reviewed manifest', () => {
  expect(schemaHistoryForkManifest.fixtures).toHaveLength(32);
  expect(schemaHistoryForkManifest.forkOverlays.map(m => m.version)).toEqual([141, 142, 143, 144, 145, 146, 147, 152]);
  for (const engine of ['pglite', 'postgres'] as const) {
    for (let version = 260; version <= 275; version++) {
      expect(verifiedSchemaHistoryFixture(engine, version).metadata.forkVersion).toBe(version + 8);
    }
  }
  expect(verifyForkOverlayFiles).not.toThrow();
});

test('unlisted metadata, swapped labels and modified compressed bytes refuse before restore', () => {
  const bytes = readFileSync(new URL('./fixtures/schema-history/pglite/v275.sql.gz', import.meta.url));
  expect(() => verifiedSchemaHistoryFixture('pglite', 259, bytes)).toThrow('unlisted');
  expect(() => verifiedSchemaHistoryFixture('postgres', 275, bytes)).toThrow('hash mismatch');
  expect(() => verifiedSchemaHistoryFixture('pglite', 274, bytes)).toThrow('hash mismatch');
  const changed = Buffer.from(bytes); changed[changed.length - 1] ^= 1;
  expect(() => verifiedSchemaHistoryFixture('pglite', 275, changed)).toThrow('hash mismatch');
});

historyTest('wrong restored version refuses without restamping or creating fork tables', async engine => {
  await engine.executeRaw("UPDATE config SET value='999' WHERE key='version'");
  await expect(adaptUpstreamSchemaHistoryFixture(engine, 275)).rejects.toThrow('restored version mismatch');
  expect(await engine.getConfig('version')).toBe('999');
  expect(await engine.executeRaw("SELECT to_regclass('public.proposal_page_runs') AS table_name")).toEqual([{ table_name: null }]);
});

historyTest('a canonical fact refuses before world conversion, schema changes or restamping', async engine => {
  await engine.executeRaw("INSERT INTO facts(fact,source,visibility) VALUES('must remain private','test:history','private')");
  await expect(adaptUpstreamSchemaHistoryFixture(engine, 275)).rejects.toThrow('unexpected rows in facts');
  expect(await engine.getConfig('version')).toBe('275');
  expect(await engine.executeRaw("SELECT visibility FROM facts WHERE fact='must remain private'")).toEqual([{ visibility: 'private' }]);
  expect(await engine.executeRaw("SELECT to_regclass('public.proposal_page_runs') AS table_name")).toEqual([{ table_name: null }]);
});

historyTest('same-count service-row mutation is rejected by typed row comparison', async engine => {
  await engine.executeRaw("UPDATE sources SET name='changed fixture' WHERE id='default'");
  await expect(adaptUpstreamSchemaHistoryFixture(engine, 275)).rejects.toThrow('seed row mismatch in sources');
  expect(await engine.getConfig('version')).toBe('275');
});

historyTest('a failed native verify rolls back the real v142 nested handler and all earlier overlay DDL', async engine => {
  const original = v142.verify;
  let verified = false;
  v142.verify = async tx => { verified = await original!(tx); return false; };
  try {
    await expect(adaptUpstreamSchemaHistoryFixture(engine, 275)).rejects.toThrow('fork v142 verify failed');
  } finally { v142.verify = original; }
  expect(verified).toBe(true); // actual handler and actual postcondition ran before the injected failure
  expect(await engine.getConfig('version')).toBe('275');
  expect(await engine.executeRaw("SELECT to_regclass('public.proposal_page_runs') AS table_name")).toEqual([{ table_name: null }]);
  expect(await engine.executeRaw("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='take_proposals' AND column_name='evidence_span'"))
    .toEqual([{ n: 0 }]);
});

historyTest('the exact empty fixture applies all eight native overlays before its conditional fork stamp', async engine => {
  expect(await adaptUpstreamSchemaHistoryFixture(engine, 275)).toBe(283);
  expect(await engine.getConfig('version')).toBe('283');
  expect(await engine.getConfig('facts.default_visibility')).toBe('world');
  expect(await engine.executeRaw("SELECT to_regclass('public.proposal_page_runs') IS NOT NULL AS receipts,to_regclass('public.extract_health_state') IS NOT NULL AS health"))
    .toEqual([{ receipts: true, health: true }]);
});
