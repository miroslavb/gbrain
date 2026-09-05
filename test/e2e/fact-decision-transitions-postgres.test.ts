import { beforeAll, afterAll, describe, test, expect } from 'bun:test';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { writeFactsToFence } from '../../src/core/facts/fence-write.ts';
import { forgetFactInFence } from '../../src/core/facts/forget.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { parseMarkdown } from '../../src/core/markdown.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import gold from '../fixtures/fact-decision-transitions.json';

const url = process.env.DATABASE_URL;
describe.skipIf(!url)('versioned temporal decision gold via real MCP dispatch', () => {
  let engine: PostgresEngine;
  let root: string;
  const source = 'test-temporal-decisions';
  beforeAll(async () => {
    assertSafeE2eDatabaseUrl(url!);
    engine = new PostgresEngine(); await engine.connect({ database_url: url! }); await engine.initSchema();
    root = mkdtempSync(join(tmpdir(), 'decision-gold-'));
    await engine.executeRaw('INSERT INTO sources (id, name, local_path) VALUES ($1, $1, $2)', [source, root]);
  });
  afterAll(async () => {
    if (engine) { await engine.executeRaw('DELETE FROM sources WHERE id = $1', [source]); await engine.disconnect(); }
    if (root) rmSync(root, { recursive: true, force: true });
  });
  test('change → cancellation → rollback preserves history and API/file agreement', async () => {
    const slug = gold.entity;
    const file = join(root, slug + '.md');
    mkdirSync(join(root, 'projects'));
    writeFileSync(file, '---\ntype: project\ntitle: Decision transition\n---\n\n# Source-owned decision\n');
    const ids: number[] = [];
    const observations = [];
    for (const stage of gold.stages) {
      if (stage.action === 'forget') {
        await forgetFactInFence(engine, ids[ids.length - 1], { sourceId: source, reason: 'Decision cancelled; no replacement authorized.' });
      } else {
        const result = await writeFactsToFence(engine, { sourceId: source, localPath: root, slug, resolutionSource: 'exact_page' }, [{
          fact: stage.claim!, kind: 'belief', source: 'test:temporal-gold:' + stage.id,
          visibility: 'world', notability: 'high', embedding: null, sessionId: null,
          supersedesFactId: stage.action === 'supersede' ? ids[ids.length - 1] : undefined,
        }]);
        ids.push(result.ids[0]);
      }
      const ctx = { remote: false, sourceId: source };
      const payload = async (name: string, args: Record<string, unknown>) => {
        const result = await dispatchToolCall(engine, name, args, ctx);
        expect(result.isError).toBeFalsy();
        return JSON.parse((result.content[0] as { text: string }).text);
      };
      const active = await payload('recall', { entity: slug, limit: 100 });
      expect(active.facts.map((f: { fact: string }) => f.fact)).toEqual(stage.active);
      const history = await payload('recall', { entity: slug, include_expired: true, limit: 100 });
      expect(history.facts.length).toBe(stage.history_count);
      const page = await payload('get_page', { slug, include_content: true });
      const body = page.compiled_truth ?? page.content ?? page.body;
      expect(body).toContain(parseMarkdown(readFileSync(file, 'utf8'), slug + '.md').compiled_truth);
      observations.push({ id: stage.id, active: active.facts.map((f: { fact: string }) => f.fact),
        history_count: history.facts.length, active_ids: active.facts.map((f: { id: number }) => f.id),
        page_file_equal: body.includes(parseMarkdown(readFileSync(file, 'utf8'), slug + '.md').compiled_truth) });
      if (stage.id === 'rollback') {
        expect(active.facts[0].id).toBe(ids[2]);
        expect(active.facts[0].id).not.toBe(ids[0]);
      }
    }
    if (process.env.TEMPORAL_GOLD_RECEIPT) {
      writeFileSync(process.env.TEMPORAL_GOLD_RECEIPT, JSON.stringify({ version: gold.version, observations }, null, 2) + '\n', { mode: 0o600 });
    }
  });
});
