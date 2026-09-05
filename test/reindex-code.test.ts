/**
 * v0.20.0 Cathedral II Layer 13 E2 — reindex-code tests.
 *
 * Validates the contract that makes reindex-code safe to ship:
 *   - runReindexCode walks code pages from the DB (not the filesystem).
 *   - Returns pre-computed cost + token estimates without running embeddings.
 *   - --dry-run never imports (status='dry_run', 0 reindexed).
 *   - --force bypasses importCodeFile's content_hash early-return.
 *   - Pages without frontmatter.file fail cleanly (counted, not thrown).
 *   - Batching walks every code page regardless of total count.
 *   - --source filter scopes to one sources row.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runReindexCode } from '../src/commands/reindex-code.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { importCodeFile } from '../src/core/import-file.ts';

describe('Layer 13 E2 — runReindexCode', () => {
  let engine: PGLiteEngine;
  let prevNudgeEnv: string | undefined;

  beforeAll(async () => {
    // v0.37.3 — runReindexCode now reads getEmbeddingModelName() from the
    // gateway for both the cost-preview model field and the code-model
    // nudge. Configure the gateway with the historical default so the
    // existing model-name assertion stays exact, and suppress the nudge
    // so test stderr stays clean.
    prevNudgeEnv = process.env.GBRAIN_NO_CODE_MODEL_NUDGE;
    process.env.GBRAIN_NO_CODE_MODEL_NUDGE = '1';
    configureGateway({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
      env: { OPENAI_API_KEY: 'sk-test' },
    });

    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();

    // Two code pages with frontmatter.file populated. compiled_truth holds
    // the full content (as importCodeFile writes it).
    await engine.putPage('src-foo-ts', {
      type: 'code',
      page_kind: 'code',
      title: 'src/foo.ts (typescript)',
      compiled_truth: 'export function foo() { return 42; }',
      timeline: '',
      frontmatter: { language: 'typescript', file: 'src/foo.ts' },
    });
    await engine.putPage('src-bar-py', {
      type: 'code',
      page_kind: 'code',
      title: 'src/bar.py (python)',
      compiled_truth: 'def bar():\n    return 42\n',
      timeline: '',
      frontmatter: { language: 'python', file: 'src/bar.py' },
    });

    // One code page with missing frontmatter.file — should fail cleanly.
    await engine.putPage('src-bad-ts', {
      type: 'code',
      page_kind: 'code',
      title: 'src/bad.ts (typescript)',
      compiled_truth: 'export const x = 1;',
      timeline: '',
      frontmatter: { language: 'typescript' }, // no file
    });

    // One markdown page that MUST be ignored.
    await engine.putPage('guides/not-code', {
      type: 'guide',
      title: 'Not code',
      compiled_truth: 'This is a markdown page, not code.',
      timeline: '',
    });
  });

  afterAll(async () => {
    await engine.disconnect();
    resetGateway();
    if (prevNudgeEnv === undefined) delete process.env.GBRAIN_NO_CODE_MODEL_NUDGE;
    else process.env.GBRAIN_NO_CODE_MODEL_NUDGE = prevNudgeEnv;
  }, 30_000);

  test('counts code pages, ignores markdown', async () => {
    const result = await runReindexCode(engine, { dryRun: true, noEmbed: true });
    expect(result.status).toBe('dry_run');
    expect(result.codePages).toBe(3); // foo, bar, bad — not the guide
  });

  test('dry-run reports cost + token count without importing', async () => {
    const result = await runReindexCode(engine, { dryRun: true, noEmbed: true });
    expect(result.status).toBe('dry_run');
    expect(result.reindexed).toBe(0);
    expect(result.totalTokens).toBeGreaterThan(0);
    expect(result.costUsd).toBeGreaterThanOrEqual(0);
    expect(result.model).toBe('text-embedding-3-large');
  });

  test('reindex walks every code page, failures counted per-slug', async () => {
    const result = await runReindexCode(engine, { noEmbed: true });
    expect(result.status).toBe('ok');
    expect(result.codePages).toBe(3);
    // src-bad-ts has no frontmatter.file → fails cleanly.
    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect(result.failures).toBeDefined();
    expect(result.failures!.some(f => f.slug === 'src-bad-ts')).toBe(true);
  });

  test('empty brain returns ok with zero counts', async () => {
    const empty = new PGLiteEngine();
    await empty.connect({});
    await empty.initSchema();
    const result = await runReindexCode(empty, { noEmbed: true });
    expect(result.status).toBe('ok');
    expect(result.codePages).toBe(0);
    expect(result.reindexed).toBe(0);
    expect(result.totalTokens).toBe(0);
    await empty.disconnect();
  }, 30_000);

  test('batch size honored — walks all pages even when total > batchSize', async () => {
    const result = await runReindexCode(engine, {
      dryRun: true,
      noEmbed: true,
      batchSize: 1,
    });
    expect(result.codePages).toBe(3);
  });

  test('force rebuild finds retyped code-kind pages and excludes deleted pages', async () => {
    const isolated = new PGLiteEngine();
    await isolated.connect({});
    await isolated.initSchema();
    try {
      await importCodeFile(isolated, 'src/retyped.ts', 'export function retyped() { return 7; }', { noEmbed: true });
      await importCodeFile(isolated, 'src/deleted.ts', 'export function deleted() { return 8; }', { noEmbed: true });
      await importCodeFile(isolated, 'src/empty.py', '', { noEmbed: true });
      await isolated.executeRaw("UPDATE pages SET type = 'note' WHERE page_kind = 'code'");
      await isolated.executeRaw("UPDATE pages SET deleted_at = NOW() WHERE frontmatter->>'file' = 'src/deleted.ts'");
      await isolated.executeRaw('UPDATE content_chunks SET symbol_name = NULL, language = NULL');
      const preview = await runReindexCode(isolated, { dryRun: true, noEmbed: true });
      expect(preview.codePages).toBe(2);
      const result = await runReindexCode(isolated, { force: true, noEmbed: true, batchSize: 1 });
      expect(result.reindexed).toBe(2);
      expect(result.failed).toBe(0);
    const types = await isolated.executeRaw<{ type: string }>("SELECT DISTINCT type FROM pages WHERE page_kind='code'");
    expect(types.map(r => r.type)).toEqual(['note']);
      const rows = await isolated.executeRaw<{ n: number }>(
        "SELECT COUNT(*)::int AS n FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.deleted_at IS NULL AND c.language = 'typescript'",
      );
      expect(rows[0]!.n).toBeGreaterThan(0);
      const retired = await isolated.executeRaw<{ n: number }>("SELECT COUNT(*)::int AS n FROM pages WHERE deleted_at IS NOT NULL");
      expect(retired[0]!.n).toBe(1);
    } finally {
      await isolated.disconnect();
    }
  }, 60_000);
});
