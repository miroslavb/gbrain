import { describe, expect, test } from 'bun:test';
import { resolveInnerSearchLimit } from '../src/core/search/hybrid.ts';
import { KNOBS_HASH_VERSION } from '../src/core/search/mode.ts';

describe('hybrid candidate pool sizing', () => {
  test('cache rows from the pre-floor algorithm are unreachable', () => {
    expect(KNOBS_HASH_VERSION).toBeGreaterThanOrEqual(16);
  });

  test('reranker topNIn drives a 2x first-stage overfetch independent of output limit', () => {
    expect(resolveInnerSearchLimit(5, true, 30)).toBe(60);
    expect(resolveInnerSearchLimit(10, true, 30)).toBe(60);
  });

  test('reranker-disabled path preserves the legacy 2x pool', () => {
    expect(resolveInnerSearchLimit(5, false, 30)).toBe(10);
  });

  test('large output requests remain capped by the search maximum', () => {
    expect(resolveInnerSearchLimit(100, true, 30)).toBeLessThanOrEqual(100);
  });
});
