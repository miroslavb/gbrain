import { findCodeDef } from '../../src/commands/code-def.ts';
import { findCodeRefs } from '../../src/commands/code-refs.ts';
import { beforeAll, afterAll, describe, expect, test } from 'bun:test';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { importCodeFile } from '../../src/core/import-file.ts';
import { runReindexCode } from '../../src/commands/reindex-code.ts';
import { checkCodeChunkMetadata } from '../../src/commands/doctor/checks/extraction-sync.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';

describe.skipIf(!hasDatabase())('retyped code metadata on Postgres', () => {
  let engine: PostgresEngine;
  beforeAll(async () => {
    engine = await setupDB();
    configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  }, 120_000);
  afterAll(async () => { resetGateway(); await teardownDB(); }, 30_000);
  test('doctor detects and reindex repairs note-typed code without resurrecting deleted pages', async () => {
    await importCodeFile(engine, 'src/active.ts', 'export function active() { return 1; }', { noEmbed: true });
    await importCodeFile(engine, 'src/retired.ts', 'export function retired() { return 2; }', { noEmbed: true });
    await importCodeFile(engine, 'src/empty.py', '', { noEmbed: true });
    await engine.executeRaw("UPDATE pages SET type='note' WHERE page_kind='code'");
    await engine.executeRaw("UPDATE pages SET deleted_at=NOW() WHERE frontmatter->>'file'='src/retired.ts'");
    await engine.executeRaw('UPDATE content_chunks SET symbol_name=NULL, language=NULL');
    expect((await checkCodeChunkMetadata(engine)).status).toBe('warn');
    expect((await runReindexCode(engine, { dryRun: true, noEmbed: true })).codePages).toBe(2);
    const result = await runReindexCode(engine, { force: true, noEmbed: true });
    expect(result.reindexed).toBe(2);
    expect(result.failed).toBe(0);
    const types = await engine.executeRaw<{ type: string }>("SELECT DISTINCT type FROM pages WHERE page_kind='code'");
    expect(types.map(r => r.type)).toEqual(['note']);
    expect((await checkCodeChunkMetadata(engine)).status).toBe('ok');
    const rows = await engine.executeRaw<{ n: number }>("SELECT count(*)::int n FROM pages WHERE deleted_at IS NOT NULL");
    expect(rows[0]!.n).toBe(1);
    for (const lookup of [findCodeDef, findCodeRefs]) {
      const live = await lookup(engine, 'active', { sourceId: 'default', limit: 1 });
      expect(live).toHaveLength(1);
      expect(live[0]!.source_id).toBe('default');
      expect(await lookup(engine, 'active', { sourceId: 'unindexed', limit: 1 })).toEqual([]);
      expect(await lookup(engine, 'retired', { sourceId: 'default', limit: 1 })).toEqual([]);
    }
  }, 60_000);
});
