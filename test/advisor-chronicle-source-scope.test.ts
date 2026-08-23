/**
 * Source-scope containment for the advisor chronicle collector
 * (post-cutover P0 review follow-up): a source-scoped MCP caller must not
 * receive coverage-gap findings computed from pages outside its grant.
 *
 * The collector's SQL binds the caller's sourceId/allowedSources; this test
 * captures the bound parameters from a stub engine and asserts:
 *   1. unscoped (local CLI) ctx → no source filter params appended;
 *   2. scalar sourceId ctx → that exact id is bound;
 *   3. allowedSources union ctx → the array is bound (fail-closed on empty);
 *   4. rows outside the grant can never reach the finding because the filter
 *      is part of the query itself (stub returns only in-grant rows shape).
 */
import { describe, test, expect } from 'bun:test';
import { collectChronicle } from '../src/core/advisor/collect-chronicle.ts';
import type { AdvisorContext } from '../src/core/advisor/types.ts';

function ctx(engine: AdvisorContext['engine'], over: Partial<AdvisorContext> = {}): AdvisorContext {
  return {
    engine,
    config: {} as AdvisorContext['config'],
    version: '0.46.28.0',
    workspace: null,
    skillsDir: null,
    now: new Date('2026-08-23T00:00:00Z'),
    remote: false,
    ...over,
  };
}

interface CapturedCall {
  sql: string;
  params: unknown[];
}

function capturingEngine(calls: CapturedCall[]): AdvisorContext['engine'] {
  return {
    executeRaw: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return [];
    },
    findOntologyConflicts: async () => [],
  } as never as AdvisorContext['engine'];
}

describe('collect-chronicle source scoping', () => {
  test('unscoped local CLI ctx → no source filter, brain-global', async () => {
    const calls: CapturedCall[] = [];
    await collectChronicle.collect(ctx(capturingEngine(calls)));
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const chronicleCall = calls.find((c) => c.sql.includes('timeline_entries'));
    expect(chronicleCall).toBeDefined();
    expect(chronicleCall!.params.length).toBe(1); // only rescue prefixes
    expect(chronicleCall!.sql).not.toContain('source_id');
  });

  test('scalar sourceId ctx → binds exactly that source', async () => {
    const calls: CapturedCall[] = [];
    await collectChronicle.collect(ctx(capturingEngine(calls), { sourceId: 'dept-x' }));
    const chronicleCall = calls.find((c) => c.sql.includes('timeline_entries'))!;
    expect(chronicleCall.params.length).toBe(2);
    expect(chronicleCall.params[1]).toBe('dept-x');
    expect(chronicleCall.sql).toContain('p.source_id = $2::text');
  });

  test('allowedSources union ctx → binds array; [] stays fail-closed deny-all', async () => {
    const calls: CapturedCall[] = [];
    await collectChronicle.collect(
      ctx(capturingEngine(calls), { allowedSources: ['dept-x', 'shared'] }),
    );
    let call = calls.find((c) => c.sql.includes('timeline_entries'))!;
    expect(call.params.length).toBe(2);
    expect(call.params[1]).toEqual(['dept-x', 'shared']);
    expect(call.sql).toContain('p.source_id = ANY($2::text[])');

    calls.length = 0;
    await collectChronicle.collect(ctx(capturingEngine(calls), { allowedSources: [] }));
    call = calls.find((c) => c.sql.includes('timeline_entries'))!;
    expect(call.params[1]).toEqual([]); // ANY(empty) matches nothing → no leak
  });

  test('out-of-grant rows cannot appear: filter is in-query, not post-hoc', async () => {
    // Stub engine returns one row for whatever it is asked; with a scope
    // bound, the query itself excludes foreign sources — simulate by
    // returning only what an in-grant row set would look like and asserting
    // the finding counts it, while the SQL carries the fence.
    const calls: CapturedCall[] = [];
    const engine = {
      executeRaw: async (sql: string, params: unknown[]) => {
        calls.push({ sql, params });
        return [
          {
            type: 'meeting',
            slug: 'meetings/in-grant-page',
            frontmatter: { message_count: 150 },
            body_chars: 5000,
          },
        ];
      },
      findOntologyConflicts: async () => [],
    } as never as AdvisorContext['engine'];
    const findings = await collectChronicle.collect(ctx(engine, { sourceId: 'dept-x' }));
    const gap = findings.find((f) => f.id === 'chronicle_coverage_gap');
    expect(gap).toBeDefined();
    const chronicleCall = calls.find((c) => c.sql.includes('timeline_entries'))!;
    // The fence is structural: any row reaching the reducer passed the filter.
    expect(chronicleCall.sql).toContain('p.source_id = $2::text');
  });
});
