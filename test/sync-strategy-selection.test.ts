import { describe, expect, test } from 'bun:test';
import { parseSyncStrategyArg, resolveSyncStrategy, selectSyncStrategy } from '../src/core/sync-strategy.ts';

describe('sync strategy boundary validation', () => {
  test('precedence is explicit, selected source, then legacy markdown', () => {
    expect(selectSyncStrategy('markdown', { strategy: 'auto' })).toBe('markdown');
    expect(selectSyncStrategy('auto', { strategy: 'code' })).toBe('auto');
    expect(selectSyncStrategy(undefined, { strategy: 'code' })).toBe('code');
    expect(selectSyncStrategy(undefined, '{"strategy":"auto"}')).toBe('auto');
    expect(selectSyncStrategy(undefined, {})).toBe('markdown');
    expect(selectSyncStrategy(undefined, undefined)).toBe('markdown');
    expect(selectSyncStrategy('code', { strategy: 'broken' })).toBe('code');
  });

  for (const invalid of ['', 'AUTO', 'typo', 0, false, null, {}, []]) {
    test(`rejects invalid selected strategy ${JSON.stringify(invalid)}`, () => {
      expect(() => selectSyncStrategy(invalid, { strategy: 'auto' })).toThrow('Invalid sync strategy');
      expect(() => selectSyncStrategy(undefined, { strategy: invalid })).toThrow('Invalid sync strategy');
    });
  }

  test('legacy configs without a recoverable strategy retain heal-on-write eligibility', () => {
    for (const legacy of ['{', 'null', '[]', 'false', 42, [], null, false, '"not-an-object"']) {
      expect(selectSyncStrategy(undefined, legacy)).toBe('markdown');
    }
  });

  test('recovers nested strings and array fragments without dropping a saved code strategy', () => {
    expect(selectSyncStrategy(undefined, JSON.stringify(JSON.stringify({ strategy: 'auto' })))).toBe('auto');
    expect(selectSyncStrategy(undefined, [false, { strategy: 'markdown' }, '{"strategy":"code"}'])).toBe('code');
    expect(selectSyncStrategy(undefined, JSON.stringify([{ strategy: 'auto' }, null]))).toBe('auto');
  });

  test('a recovered invalid strategy still fails closed unless explicitly overridden', () => {
    for (const config of [JSON.stringify(JSON.stringify({ strategy: 'typo' })), [null, { strategy: 'auto' }, { strategy: false }]]) {
      expect(() => selectSyncStrategy(undefined, config)).toThrow('Invalid sync strategy');
      expect(selectSyncStrategy('auto', config)).toBe('auto');
    }
  });

  test('CLI omission differs from a malformed or bare flag', () => {
    expect(parseSyncStrategyArg(['--no-pull'])).toBeUndefined();
    expect(parseSyncStrategyArg(['--strategy', 'auto'])).toBe('auto');
    for (const args of [['--strategy'], ['--strategy', '--no-pull'], ['--strategy', 'typo']]) {
      expect(() => parseSyncStrategyArg(args)).toThrow();
    }
  });

  test('the saved strategy query is bound to the selected source and errors propagate', async () => {
    const calls: unknown[][] = [];
    const engine = {
      async executeRaw<T>(sql: string, params?: unknown[]): Promise<T[]> {
        calls.push([sql, params]);
        return [{ config: { strategy: params?.[0] === 'code-source' ? 'auto' : 'markdown' } }] as T[];
      },
    };
    expect(await resolveSyncStrategy(engine, undefined, 'code-source')).toBe('auto');
    expect(await resolveSyncStrategy(engine, undefined, 'notes-source')).toBe('markdown');
    expect(calls.map(c => c[1])).toEqual([['code-source'], ['notes-source']]);
    expect(await resolveSyncStrategy(engine, 'code', 'notes-source')).toBe('code');
    expect(calls).toHaveLength(2);
    await expect(resolveSyncStrategy({ executeRaw: async () => { throw new Error('database read failed'); } }, undefined, 'code-source')).rejects.toThrow('database read failed');
  });
});
