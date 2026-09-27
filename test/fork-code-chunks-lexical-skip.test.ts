/**
 * Fork 2026-09-27 — code pages the host code index marks
 * `embed_skip: {reason: 'finite_lexical_symbols'}` keep their chunks.
 *
 * Upstream prepareCodeChunks returns no chunks for any embed_skip page. The
 * v0.58 importer preserves existing frontmatter and the projection rebuild
 * re-chunks every page, so the 13 lexical-symbol code pages would lose the
 * chunks that keyword search and code_def/code_refs read. Vectors stay off:
 * the stale-chunk selectors already exclude embed_skip pages.
 */
import { describe, test, expect } from 'bun:test';
import { prepareCodeChunks, isFiniteLexicalSymbols } from '../src/core/code-chunks.ts';

const SRC = 'export function alphaHelper(x: number): number {\n  return x + 1;\n}\n\nexport class BetaWidget {\n  run(): string { return "beta"; }\n}\n';

describe('prepareCodeChunks with embed_skip', () => {
  test('finite lexical-symbol pages keep chunks with symbols', async () => {
    const fm = { embed_skip: { reason: 'finite_lexical_symbols', bytes: 120 } };
    expect(isFiniteLexicalSymbols(fm)).toBe(true);
    const r = await prepareCodeChunks({ compiled_truth: SRC, frontmatter: fm }, 'src/example.ts');
    expect(r.chunks.length).toBeGreaterThan(0);
    expect(r.chunks.map((c) => c.symbol_name)).toContain('alphaHelper');
  });

  test('any other embed_skip reason and quarantined pages still get no chunks', async () => {
    for (const fm of [{ embed_skip: { reason: 'oversized', bytes: 9_000_000 } }, { embed_skip: true }]) {
      expect(isFiniteLexicalSymbols(fm as Record<string, unknown>)).toBe(false);
      expect((await prepareCodeChunks({ compiled_truth: SRC, frontmatter: fm as Record<string, unknown> }, 'src/example.ts')).chunks).toEqual([]);
    }
  });

  test('an unmarked page is chunked normally', async () => {
    const r = await prepareCodeChunks({ compiled_truth: SRC, frontmatter: {} }, 'src/example.ts');
    expect(r.chunks.length).toBeGreaterThan(0);
  });
});
