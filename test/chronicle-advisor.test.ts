/**
 * v0.42.x — Life Chronicle (#2390) advisor collector (Phase A.7).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { collectChronicle } from '../src/core/advisor/collect-chronicle.ts';
import type { AdvisorContext } from '../src/core/advisor/types.ts';

let engine: PGLiteEngine;
const ctx = (): AdvisorContext => ({ engine, remote: false } as unknown as AdvisorContext);

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await engine.executeRaw('DELETE FROM timeline_entries');
  await engine.executeRaw('DELETE FROM facts');
  await engine.executeRaw(`DELETE FROM pages
    WHERE type IN ('meeting','conversation','calendar-event')
       OR slug LIKE 'conversations/rescue-%'`);
});

describe('collectChronicle', () => {
  test('flags recent meetings with no timeline coverage', async () => {
    await engine.putPage('meetings/recent', { type: 'meeting', title: 'recent', compiled_truth: 'x'.repeat(120) });
    const findings = await collectChronicle.collect(ctx());
    const gap = findings.find((f) => f.id === 'chronicle_coverage_gap');
    expect(gap).toBeTruthy();
    expect(gap!.severity).toBe('info');
    // #5876: every pointer is a scoped, previewed backfill (paid work needs the user's agreement).
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    expect(gap!.fix.command_argv).toEqual(['gbrain', 'chronicle-backfill', '--since', since, '--limit', '50', '--dry-run']);
  });

  test('flags unresolved ontology conflicts', async () => {
    await engine.mergeOntologyFact({ entitySlug: 'people/x', dimension: 'role', value: 'advisor', source: 'm/a', validFrom: '2026-05-01' });
    await engine.mergeOntologyFact({ entitySlug: 'people/x', dimension: 'role', value: 'founder', source: 'm/b', validFrom: '2026-01-01' });
    const findings = await collectChronicle.collect(ctx());
    const conflict = findings.find((f) => f.id === 'ontology_conflicts');
    expect(conflict).toBeTruthy();
    expect(conflict!.severity).toBe('warn');
  });

  test('does not report explicit sub-100 conversations as Chronicle coverage gaps', async () => {
    await engine.putPage('conversations/short', {
      type: 'conversation', title: 'short', compiled_truth: 'x'.repeat(120),
      frontmatter: { message_count: 99 },
    });
    const findings = await collectChronicle.collect(ctx());
    expect(findings.find((f) => f.id === 'chronicle_coverage_gap')).toBeUndefined();
  });

  test('reports threshold and legacy conversations through the same eligibility predicate', async () => {
    await engine.putPage('conversations/threshold', {
      type: 'conversation', title: 'threshold', compiled_truth: 'x'.repeat(120),
      frontmatter: { message_count: 100 },
    });
    await engine.putPage('conversations/legacy', {
      type: 'conversation', title: 'legacy', compiled_truth: 'x'.repeat(120),
      frontmatter: {},
    });
    const findings = await collectChronicle.collect(ctx());
    const gap = findings.find((f) => f.id === 'chronicle_coverage_gap');
    expect(gap?.title).toBe("2 recent meeting(s) aren't in the timeline yet");
  });

  test('advisor includes rescued conversation slugs while applying their threshold', async () => {
    await engine.putPage('conversations/rescue-short', {
      type: 'note', title: 'rescue short', compiled_truth: 'x'.repeat(120),
      frontmatter: { message_count: 99 },
    });
    await engine.putPage('conversations/rescue-threshold', {
      type: 'note', title: 'rescue threshold', compiled_truth: 'x'.repeat(120),
      frontmatter: { message_count: 100 },
    });
    const findings = await collectChronicle.collect(ctx());
    const gap = findings.find((f) => f.id === 'chronicle_coverage_gap');
    expect(gap?.title).toBe("1 recent meeting(s) aren't in the timeline yet");
  });

  test('no findings on a clean brain whose operator answered the auto_chronicle default', async () => {
    // #5876: until `config set auto_chronicle` answers it, the default-on notice is the only finding.
    await engine.unsetConfig('chronicle.default_on_acknowledged');
    expect((await collectChronicle.collect(ctx())).map((f) => f.id)).toEqual(['auto_chronicle_default_on']);
    await engine.setConfig('chronicle.default_on_acknowledged', '2026-10-04T00:00:00Z');
    try {
      expect(await collectChronicle.collect(ctx())).toHaveLength(0);
    } finally {
      await engine.unsetConfig('chronicle.default_on_acknowledged');
    }
  });
});
