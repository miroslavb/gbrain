import { describe, expect, test } from 'bun:test';
import { parsePruneCliOptions } from '../src/core/minions/prune-options.ts';

describe('parsePruneCliOptions', () => {
  test('scopes a dry-run to dead jobs without touching other terminal classes', () => {
    const parsed = parsePruneCliOptions(['--older-than', '7d', '--status', 'dead', '--dry-run'], 10_000_000_000);
    expect(parsed.days).toBe(7);
    expect(parsed.status).toEqual(['dead']);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.statusLabel).toBe(' dead');
  });

  test('rejects non-terminal and malformed retention inputs', () => {
    expect(() => parsePruneCliOptions(['--status', 'active'])).toThrow('--status must be one of');
    expect(() => parsePruneCliOptions(['--older-than', '0'])).toThrow('--older-than must be a positive');
  });
});
