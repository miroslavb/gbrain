import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { AUTOMATIC_CODE_CHUNKER_VERSION, CHUNKER_VERSION } from '../src/core/chunkers/code.ts';
import { positionalArgs } from '../src/commands/code-scope.ts';

describe('finite v7 admission', () => {
  test('v7 does not advance the automatic source recovery floor', () => {
    expect(CHUNKER_VERSION).toBe(7);
    expect(AUTOMATIC_CODE_CHUNKER_VERSION).toBe(6);
    for (const path of ['src/commands/sync.ts', 'src/core/sync-cost-gate.ts',
                        'src/commands/doctor/checks/extraction-sync.ts']) {
      const text = readFileSync(new URL('../' + path, import.meta.url), 'utf8');
      expect(text).toContain('String(AUTOMATIC_CODE_CHUNKER_VERSION)');
      expect(text).not.toMatch(/\bString\(CHUNKER_VERSION\)/);
    }
  });
  test('file flag before a reference symbol cannot become that symbol', () => {
    expect(positionalArgs(['--file', 'hooks/read.py', '--source', 'memory', 'read'])).toEqual(['read']);
    expect(positionalArgs(['--file=hooks/read.py', 'read'])).toEqual(['read']);
  });
});
