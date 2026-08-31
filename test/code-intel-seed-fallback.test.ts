/**
 * code_blast/code_flow symbol-edge seed fallback + not_found readiness
 * (2026-08-25 audit P1-2 #6).
 *
 * On a brain whose content_chunks carry NO symbol_name/symbol_name_qualified
 * (chunks predate symbol extraction — 0/6696 in the audited production
 * brain), disambiguateSymbol finds nothing, so every walk used to return a
 * bare not_found even though code_edges_symbol held a fully traversable
 * short-name graph. Pins:
 *   1. a bare-name walk with empty symbol columns seeds from
 *      code_edges_symbol and returns ok + seeded_via: 'symbol_edges',
 *   2. a genuinely absent symbol still returns not_found — now carrying the
 *      edge-grain readiness signal (status/ready),
 *   3. not_found envelopes are never written to code_traversal_cache
 *      (ok envelopes are).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;

function ctxOf(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: engine as never,
    config: {} as never,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
    dryRun: false,
    remote: false,
    sourceId: 'seedsrc',
    ...overrides,
  } as OperationContext;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config, created_at)
     VALUES ('seedsrc', 'seedsrc', '/fake/seedsrc', '{}'::jsonb, NOW())
     ON CONFLICT (id) DO NOTHING`,
  );
  const page = await engine.executeRaw<{ id: number }>(
    `INSERT INTO pages (slug, source_id, title, type, page_kind, compiled_truth, frontmatter, updated_at, created_at)
     VALUES ('code/seed', 'seedsrc', 'seed', 'code', 'code', '', '{}'::jsonb, NOW(), NOW())
     RETURNING id`,
  );
  const pageId = page[0]!.id;
  // Code chunks with NO symbol metadata — the audited production shape.
  const chunks: number[] = [];
  for (let i = 0; i < 2; i++) {
    const r = await engine.executeRaw<{ id: number }>(
      `INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source, language, symbol_name, symbol_name_qualified)
       VALUES ($1, $2, '// body', 'compiled_truth', 'typescript', NULL, NULL)
       RETURNING id`,
      [pageId, i],
    );
    chunks.push(r[0]!.id);
  }
  // Short-name call graph: beta_fn -> alpha_fn -> target_fn.
  await engine.executeRaw(
    `INSERT INTO code_edges_symbol (from_chunk_id, from_symbol_qualified, to_symbol_qualified, edge_type, source_id)
     VALUES ($1, 'alpha_fn', 'target_fn', 'call', 'seedsrc'),
            ($2, 'beta_fn', 'alpha_fn', 'call', 'seedsrc')`,
    [chunks[0], chunks[1]],
  );
});

afterAll(async () => {
  await engine.disconnect();
});

describe('code_blast symbol-edge seed fallback', () => {
  test('bare name with empty symbol columns walks the short-name graph', async () => {
    const r = await operationsByName.code_blast!.handler(ctxOf(), { symbol: 'target_fn' }) as {
      result: string;
      seeded_via?: string;
      depth_groups?: Array<{ depth: number; nodes: Array<{ symbol: string }> }>;
    };
    expect(r.result).toBe('ok');
    expect(r.seeded_via).toBe('symbol_edges');
    const d1 = r.depth_groups!.find((g) => g.depth === 1);
    const d2 = r.depth_groups!.find((g) => g.depth === 2);
    expect(d1!.nodes.map((n) => n.symbol)).toContain('alpha_fn');
    expect(d2!.nodes.map((n) => n.symbol)).toContain('beta_fn');
  });

  test('genuinely absent symbol reports not_found WITH readiness, and is not cached', async () => {
    const r = await operationsByName.code_blast!.handler(ctxOf(), { symbol: 'missing_fn' }) as {
      result: string; status?: string; ready?: boolean;
    };
    expect(r.result).toBe('not_found');
    // Fixture chunks have edges_backfilled_at NULL → edge grain 'indexing'.
    expect(r.status).toBe('indexing');
    expect(r.ready).toBe(false);

    const cached = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM code_traversal_cache WHERE symbol_qualified = 'missing_fn'`,
    );
    expect(cached[0]!.n).toBe(0);
    const okCached = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM code_traversal_cache WHERE symbol_qualified = 'target_fn'`,
    );
    expect(okCached[0]!.n).toBe(1);
  });

  test('code_flow seeds the callee direction the same way', async () => {
    const r = await operationsByName.code_flow!.handler(ctxOf(), { entry_point: 'beta_fn' }) as {
      result: string;
      seeded_via?: string;
      depth_groups?: Array<{ depth: number; nodes: Array<{ symbol: string }> }>;
    };
    expect(r.result).toBe('ok');
    expect(r.seeded_via).toBe('symbol_edges');
    expect(r.depth_groups!.find((g) => g.depth === 1)!.nodes.map((n) => n.symbol)).toContain('alpha_fn');
    expect(r.depth_groups!.find((g) => g.depth === 2)!.nodes.map((n) => n.symbol)).toContain('target_fn');
  });
});
