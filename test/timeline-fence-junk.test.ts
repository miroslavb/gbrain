// Timeline rows whose summary is a facts-fence header ("| # | claim | kind | ...") are projection junk.
// They used to be written back into pages as materialized bullets on every database-rendered write,
// and `--prune-orphans` kept them because no stored page version produced them. Now the renderer
// refuses them and the orphan reconciliation retracts them; ordinary database-only rows are kept.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { renderMaterializedBullet } from '../src/core/persistence/canonical-projections.ts';
import { retractRemovedTimelineEntries } from '../src/core/timeline-extract.ts';
import { isFenceJunkSummary } from '../src/core/timeline-marker.ts';

const JUNK = '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context | |---|-------|------|';
const MARKER_JUNK = '<!--- gbrain:facts:begin --> | # | claim | kind | confidence |';

describe('fence-header timeline junk', () => {
  test('is recognised; ordinary summaries are not', () => {
    expect(isFenceJunkSummary(JUNK)).toBe(true);
    expect(isFenceJunkSummary(MARKER_JUNK)).toBe(true);
    expect(isFenceJunkSummary('Released 1.2 | a pipe inside an ordinary summary')).toBe(false);
  });

  test('is never rendered back into a page; an ordinary row still is', () => {
    expect(renderMaterializedBullet({ date: '2026-10-02', source: 'User', summary: JUNK }, 'notes/a')).toBeNull();
    expect(renderMaterializedBullet({ date: '2026-10-02', source: 'User', summary: 'Kickoff held' }, 'notes/a')).not.toBeNull();
  });

  describe('orphan reconciliation', () => {
    let engine: PGLiteEngine;
    beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
    afterAll(async () => { await engine.disconnect(); });

    test('retracts database-only junk and keeps an ordinary database-only row', async () => {
      await engine.putPage('notes/a', { type: 'note', title: 'A', compiled_truth: 'Body without a timeline.' } as never, { sourceId: 'default' });
      const [page] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE source_id='default' AND slug='notes/a'");
      await engine.executeRaw(`INSERT INTO timeline_entries (page_id, date, source, summary, detail) VALUES
        ($1, '2026-10-02', 'User', $2, ''), ($1, '2026-10-03', 'enrichment', 'Kickoff held', '')`, [page!.id, JUNK]);
      const preview = await retractRemovedTimelineEntries(engine, 'notes/a', 'default', 'Body without a timeline.', { dryRun: true });
      expect(preview.map(r => r.summary)).toEqual([JUNK]);
      await retractRemovedTimelineEntries(engine, 'notes/a', 'default', 'Body without a timeline.');
      const left = await engine.executeRaw<{ summary: string }>('SELECT summary FROM timeline_entries WHERE page_id=$1', [page!.id]);
      expect(left.map(r => r.summary)).toEqual(['Kickoff held']);
    });
  });
});
