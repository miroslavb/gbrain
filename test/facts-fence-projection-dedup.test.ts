/**
 * Canonical fence projection must not materialize the same active claim twice
 * (fork 2026-10-07).
 *
 * Root cause (localized via prod instrumentation): a `## Facts` fence can carry
 * the same (claim, source) at two active rows (e.g. projects/gbrain P1-2 at
 * rows 397 and 405). compileCanonicalProjections mapped every fence row into a
 * DB fact, so the projection inserted both and every page render regenerated
 * the duplicate. The extract_facts reconcile already drops later duplicate
 * active rows via duplicateActiveFenceRows; the projection must do the same.
 *
 * Passes when: a fence with the claim at two active rows projects to ONE active
 * DB fact. Fails on the buggy baseline (two rows).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
const dataDir = mkdtempSync(join(tmpdir(), 'gbrain-projdedup-db-'));

beforeAll(async () => {
  configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536,
    env: { ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: 'sk-test' } });
  __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(() => Array(1536).fill(0.01)) })) as never);
  engine = new PGLiteEngine();
  await engine.connect({ database_path: dataDir }); await engine.initSchema();
}, 120_000);

afterAll(async () => {
  __setEmbedTransportForTests(null);
  await disposePersistenceConsumer(engine); await engine.disconnect(); resetGateway();
  rmSync(dataDir, { recursive: true, force: true });
});

const FENCE = (rows: string) => `## Facts\n\n<!--- gbrain:facts:begin -->\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|\n${rows}\n<!--- gbrain:facts:end -->\n`;
// Same claim + same source at two active rows (the prod shape).
const PAGE = `---\ntitle: Repro\ntype: person\n---\n# Repro\n\nbody\n` + FENCE([
  '| 1 | Repro fact one. | fact | 0.95 | world | high | 2026-08-31 |  | sync:import |  |',
  '| 2 | Repro fact one. | fact | 0.98 | world | high | 2026-09-01 |  | sync:import |  |',
].join('\n'));

test('a fence with the same active claim at two rows projects to one DB fact', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-projdedup-'));
  const root = join(dir, 'brain'); mkdirSync(root);
  const sourceId = `pd-${randomUUID().slice(0, 8)}`;
  try {
    await withEnv({ GBRAIN_HOME: join(dir, 'home'), GBRAIN_AUDIT_DIR: join(dir, 'audit') }, async () => {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
      await engine.setConfig('sync.write_through', 'true');
      await engine.setConfig('facts.extraction_enabled', 'true');
      await claimWorktree(engine, sourceId, root);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      const ctx = { engine, sourceId, remote: false as const, config: { engine: engine.kind, embedding_disabled: true },
        dryRun: false, logger: { info() {}, warn() {}, error() {} } };
      await submitPageMutation(ctx as never, { operation: 'put_page', params: { slug: 'people/repro', content: PAGE, request_id: randomUUID() } });

      const n = Number((await engine.executeRaw<{ n: string }>(
        "SELECT count(*)::text n FROM facts WHERE source_id=$1 AND entity_slug='people/repro' AND superseded_by IS NULL AND expired_at IS NULL AND gbrain_fact_fingerprint(fact)=gbrain_fact_fingerprint('Repro fact one.')", [sourceId]))[0].n);
      expect(n).toBe(1);
    });
  } finally {
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);
