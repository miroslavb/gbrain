import { describe, expect, test } from 'bun:test';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { selectSingleReadSource } from '../src/core/single-source-read.ts';

describe('single-source read selection preserves compatibility within grants', () => {
  for (const remote of [false, true, undefined]) {
    test(`scalar, empty grant, default and __all__ remain unchanged for remote=${remote}`, () => {
      for (const sourceId of ['default', 'example-source', '__all__', undefined]) {
        for (const allowedSources of [undefined, []]) {
          const ctx = { remote, sourceId, auth: { allowedSources } } as OperationContext;
          if (remote !== false && sourceId === undefined && allowedSources !== undefined) {
            expect(() => selectSingleReadSource(ctx)).toThrow('No readable source');
          } else {
            expect(selectSingleReadSource(ctx)).toBe(sourceId ?? 'default');
          }
        }
      }
    });
    test(`sole grant overrides conflicting scalar/sentinel for remote=${remote}`, () => {
      for (const sourceId of ['foreign', '__all__', undefined]) {
        const ctx = { remote, sourceId, auth: { allowedSources: ['allowed'] } } as OperationContext;
        expect(selectSingleReadSource(ctx)).toBe('allowed');
      }
    });
    test(`multiple grants require a member scalar for remote=${remote}`, () => {
      for (const sourceId of ['allowed-a', 'allowed-b', 'foreign', '__all__', undefined]) {
        const ctx = { remote, sourceId, auth: { allowedSources: ['allowed-a', 'allowed-b'] } } as OperationContext;
        expect(selectSingleReadSource(ctx)).toBe(sourceId?.startsWith('allowed-') ? sourceId : null);
      }
    });
  }
});
