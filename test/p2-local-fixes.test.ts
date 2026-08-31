/**
 * 2026-08-25 audit P2 — the five local MEDIUM fixes, pinned together:
 *   1. sources_status: a plain --path source (no remoteUrl) is judged by the
 *      #2707 isInsideGitRepo check, so a subdir-of-repo registration or a
 *      repo with no `origin` remote reads 'healthy' instead of
 *      'no-git'/'corrupted'.
 *   2. search_modes report derives its knob list from the bundle shape —
 *      knobs added after the old hardcoded list (reranker_*, relational,
 *      CR, autocut…) are all present.
 *   3. safeSynopsis: table rows are not prose — a fence-first entity page
 *      no longer yields the bare `| # | claim |` header as its synopsis.
 *   4. code_traversal_cache_clear: destructive scope must be explicit — a
 *      bare {} call errors instead of silently clearing the ambient source.
 *   5. traverse_graph: default per-BFS-layer frontier cap bounds hub fanout
 *      in both the node shape (traverseGraph) and the edge shape
 *      (traversePaths); depth alone never did.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { OperationError } from '../src/core/ops/contract.ts';

let engine: PGLiteEngine;
let tmpRepo: string;

function ctxOf(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: engine as never,
    config: {} as never,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
    dryRun: false,
    remote: false,
    ...overrides,
  } as OperationContext;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  tmpRepo = mkdtempSync(join(tmpdir(), 'gbrain-p2-git-'));
  execFileSync('git', ['-C', tmpRepo, 'init', '-q']);
  mkdirSync(join(tmpRepo, 'notes'), { recursive: true });
});

afterAll(async () => {
  await engine.disconnect();
  try { rmSync(tmpRepo, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── 1. sources_status --path clone_state ──────────────────────────────────

describe('sources_status clone_state for --path sources', () => {
  test('subdir-of-repo path with no origin remote reads healthy, not no-git/corrupted', async () => {
    const { getSourceStatus } = await import('../src/core/sources-ops.ts');
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config, created_at)
       VALUES ('p2-path-src', 'p2-path-src', $1, '{}'::jsonb, NOW())`,
      [join(tmpRepo, 'notes')],
    );
    const status = await getSourceStatus(engine, 'p2-path-src');
    expect(status.clone_state).toBe('healthy');
  });

  test('a genuinely missing path keeps its granular state', async () => {
    const { getSourceStatus } = await import('../src/core/sources-ops.ts');
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config, created_at)
       VALUES ('p2-missing-src', 'p2-missing-src', '/nonexistent/p2-missing', '{}'::jsonb, NOW())`,
    );
    const status = await getSourceStatus(engine, 'p2-missing-src');
    expect(status.clone_state).toBe('missing');
  });

  test('an existing directory OUTSIDE any git tree still reads no-git (real git)', async () => {
    const { getSourceStatus } = await import('../src/core/sources-ops.ts');
    // Anti-vacuity for the healthy case above: this dir is a sibling of the
    // fixture repo, not inside it, so the isInsideGitRepo probe must fail and
    // the granular validateRepoState reason must survive.
    const bare = mkdtempSync(join(tmpdir(), 'gbrain-p2-nogit-'));
    try {
      await engine.executeRaw(
        `INSERT INTO sources (id, name, local_path, config, created_at)
         VALUES ('p2-nogit-src', 'p2-nogit-src', $1, '{}'::jsonb, NOW())`,
        [bare],
      );
      const status = await getSourceStatus(engine, 'p2-nogit-src');
      expect(status.clone_state).toBe('no-git');
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

// ── 2. search_modes knob list derives from the bundle ─────────────────────

describe('search_modes report is knob-exhaustive', () => {
  test('resolved covers every MODE_BUNDLES key, incl. post-list additions', async () => {
    const { buildModesReport } = await import('../src/core/search/modes-report.ts');
    const { MODE_BUNDLES } = await import('../src/core/search/mode.ts');
    const report = await buildModesReport(engine);
    const bundleKeys = Object.keys(MODE_BUNDLES.balanced).sort();
    expect(Object.keys(report.resolved).sort()).toEqual(bundleKeys);
    // Spot-check knobs the old hardcoded list omitted.
    for (const k of ['reranker_enabled', 'relationalRetrieval', 'contextual_retrieval', 'graph_signals'] as const) {
      expect(report.resolved[k]).toBeDefined();
      expect(typeof report.resolved[k].description).toBe('string');
    }
  });
});

// ── 3. safeSynopsis skips table rows ──────────────────────────────────────

describe('safeSynopsis on fence-first pages', () => {
  test('table header is not prose; first real prose line wins', async () => {
    const { safeSynopsis } = await import('../src/core/context/retrieval-reflex.ts');
    const row = {
      slug: 'projects/p2-example', source_id: 'default', title: 'P2 Example', type: 'project',
      frontmatter: null,
      compiled_truth: '# P2 Example\n\n| # | claim | kind |\n|---|---|---|\n| 1 | world row | fact |\n\nReal prose about the project.',
    };
    const syn = safeSynopsis(row);
    expect(syn.startsWith('|')).toBe(false);
    expect(syn).toContain('Real prose');
  });

  test('table-only body yields empty, never the bare header', async () => {
    const { safeSynopsis } = await import('../src/core/context/retrieval-reflex.ts');
    const row = {
      slug: 'projects/p2-table-only', source_id: 'default', title: 'Tbl', type: 'project',
      frontmatter: null,
      compiled_truth: '# Tbl\n\n| # | claim | kind |\n|---|---|---|\n| 1 | only row | fact |',
    };
    expect(safeSynopsis(row)).toBe('');
  });
});

// ── 4. code_traversal_cache_clear explicit-scope guard ────────────────────

describe('code_traversal_cache_clear D8 guard', () => {
  test('bare call errors even with an ambient ctx.sourceId', async () => {
    let caught: unknown;
    try {
      await operationsByName.code_traversal_cache_clear!.handler(ctxOf({ sourceId: 'default' }), {});
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(OperationError);
    expect((caught as OperationError).code).toBe('invalid_params');
  });

  test('explicit all_sources passes the guard (dry-run)', async () => {
    const r = await operationsByName.code_traversal_cache_clear!.handler(
      ctxOf({ dryRun: true }), { all_sources: true },
    ) as Record<string, unknown>;
    expect(r.dry_run).toBe(true);
    expect(r.all_sources).toBe(true);
  });
});

// ── 5. traverse_graph frontier cap ────────────────────────────────────────

describe('traverse_graph frontier cap', () => {
  beforeAll(async () => {
    // Hub graph: root -> 30 children, each child -> 1 grandchild.
    const ids = new Map<string, number>();
    async function page(slug: string): Promise<number> {
      const r = await engine.executeRaw<{ id: number }>(
        `INSERT INTO pages (slug, source_id, title, type, compiled_truth, frontmatter, updated_at, created_at)
         VALUES ($1, 'default', $1, 'note', '', '{}'::jsonb, NOW(), NOW()) RETURNING id`,
        [slug],
      );
      ids.set(slug, r[0]!.id);
      return r[0]!.id;
    }
    const root = await page('p2hub/root');
    for (let i = 0; i < 30; i++) {
      const c = await page(`p2hub/child-${String(i).padStart(2, '0')}`);
      const g = await page(`p2hub/grand-${String(i).padStart(2, '0')}`);
      await engine.executeRaw(
        `INSERT INTO links (from_page_id, to_page_id, link_type) VALUES ($1, $2, 'ref'), ($2, $3, 'ref')`,
        [root, c, g],
      );
    }
  });

  test('node shape: frontier_cap bounds each BFS layer', async () => {
    const nodes = await operationsByName.traverse_graph!.handler(
      ctxOf({ sourceId: 'default' }), { slug: 'p2hub/root', depth: 2, frontier_cap: 5 },
    ) as Array<{ slug: string; depth: number }>;
    const d1 = nodes.filter((n) => n.depth === 1);
    expect(d1.length).toBeLessThanOrEqual(5);
    expect(d1.length).toBeGreaterThan(0);
  });

  test('edge shape: capped walk bounds transitive fanout (depth-2 sources ≤ cap)', async () => {
    const paths = await operationsByName.traverse_graph!.handler(
      ctxOf({ sourceId: 'default' }), { slug: 'p2hub/root', depth: 2, direction: 'out', frontier_cap: 5 },
    ) as Array<{ from_slug: string; to_slug: string; depth: number }>;
    const depth2Sources = new Set(paths.filter((e) => e.depth === 2).map((e) => e.from_slug));
    expect(depth2Sources.size).toBeLessThanOrEqual(5);
    expect(paths.length).toBeGreaterThan(0);
  });

  test('local caller can disable with frontier_cap 0; full fanout returns', async () => {
    const nodes = await operationsByName.traverse_graph!.handler(
      ctxOf({ remote: false, sourceId: 'default' }), { slug: 'p2hub/root', depth: 1, frontier_cap: 0 },
    ) as Array<{ slug: string; depth: number }>;
    expect(nodes.filter((n) => n.depth === 1).length).toBe(30);
  });
});
