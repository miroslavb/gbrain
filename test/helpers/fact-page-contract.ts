import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BrainEngine } from '../../src/core/engine.ts';
import { writeFactsToFence, type FenceInputFact } from '../../src/core/facts/fence-write.ts';
import { forgetFactInFence } from '../../src/core/facts/forget.ts';
import { parseMarkdown } from '../../src/core/markdown.ts';
import { parseFactsFence } from '../../src/core/facts-fence.ts';
import { extractFactsFromFenceText } from '../../src/core/facts/extract-from-fence.ts';
import { writeTimelineEntryThrough } from '../../src/core/timeline-write-through.ts';

export function factPageContract(getEngine: () => BrainEngine) {
  for (const scenario of ['supersession-rebuild', 'insert-rollback', 'forget-rollback', 'source-isolation', 'timeline-tail']) {
    test(`fact projection contract: ${scenario}`, async () => {
      const engine = getEngine();
      const root = mkdtempSync(join(tmpdir(), 'fact-projection-'));
      const source = 'test-projection-' + scenario;
      const slug = 'projects/decision';
      const file = join(root, slug + '.md');
      mkdirSync(join(root, 'projects'));
      const input = (fact: string, supersedesFactId?: number): FenceInputFact => ({
        fact, supersedesFactId, kind: 'belief', notability: 'high', visibility: 'world',
        source: 'test:decision', embedding: null, sessionId: null,
      });
      const target = { sourceId: source, slug, localPath: root, resolutionSource: 'exact_page' as const };
      await engine.executeRaw('INSERT INTO sources (id, name, local_path) VALUES ($1, $1, $2)', [source, root]);
      try {
        writeFileSync(file, '---\ntype: project\ntitle: Decision\n---\n\n# Current\n\nKeep independent source evidence.\n'
          + (scenario === 'timeline-tail' ? '\n<!-- timeline -->\n## Timeline\n\n- **2026-07-01** | test — Started.\n' : ''));
        const first = await writeFactsToFence(engine, target, [input('Use manual mode.')]);
        const before = readFileSync(file, 'utf8');
        const pageBefore = await engine.getPage(slug, { sourceId: source });
        if (scenario === 'insert-rollback') {
          const original = engine.insertFacts;
          engine.insertFacts = (rows, ctx, opts) => original.call(engine, rows, ctx,
            { ...opts, postCommitCheck: () => { throw new Error('injected commit failure'); } });
          try {
            await expect(writeFactsToFence(engine, target, [input('Use automatic mode.', first.ids[0])])).rejects.toThrow('injected');
          } finally { engine.insertFacts = original; }
          expect(readFileSync(file, 'utf8')).toBe(before);
          expect((await engine.getPage(slug, { sourceId: source }))?.compiled_truth).toBe(pageBefore?.compiled_truth);
          expect((await engine.listFactsByEntity(source, slug)).map(f => f.id)).toEqual(first.ids);
          const retried = await writeFactsToFence(engine, target, [input('Use automatic mode.', first.ids[0])]);
          expect(retried.inserted).toBe(1);
        } else if (scenario === 'forget-rollback') {
          await engine.executeRaw('UPDATE pages SET deleted_at = now() WHERE source_id = $1 AND slug = $2', [source, slug]);
          await expect(forgetFactInFence(engine, first.ids[0], { sourceId: source })).rejects.toThrow('deleted page');
          expect(readFileSync(file, 'utf8')).toBe(before);
          expect((await engine.listFactsByEntity(source, slug)).map(f => f.id)).toEqual(first.ids);
        } else if (scenario === 'source-isolation') {
          await engine.putPage(slug, { type: 'project', title: 'Foreign', compiled_truth: 'Foreign body' }, { sourceId: 'default' });
          const result = await forgetFactInFence(engine, first.ids[0], { sourceId: 'default' });
          expect(result.path).toBe('not_found');
          expect(readFileSync(file, 'utf8')).toBe(before);
          await forgetFactInFence(engine, first.ids[0], { sourceId: source });
          expect((await engine.getPage(slug, { sourceId: 'default' }))?.compiled_truth).toBe('Foreign body');
        } else if (scenario === 'timeline-tail') {
          // A timeline followed by a managed fence must project the same
          // bullet placement on disk and through get_page, on both engines.
          const result = await writeTimelineEntryThrough(engine, slug, source,
            { date: '2026-07-02', source: 'test', summary: 'Changed the decision.' });
          expect(result.handled).toBe(true);
          const parsed = parseMarkdown(readFileSync(file, 'utf8'), slug + '.md');
          const page = await engine.getPage(slug, { sourceId: source });
          expect(page?.compiled_truth).toBe(parsed.compiled_truth);
          expect(page?.timeline).toBe(parsed.timeline);
          expect(parsed.timeline.indexOf('Changed the decision.'))
            .toBeLessThan(parsed.timeline.indexOf('gbrain:facts:begin'));
        } else {
          const second = await writeFactsToFence(engine, target, [input('Use automatic mode.', first.ids[0])]);
          const body = readFileSync(file, 'utf8');
          const fence = parseFactsFence(body);
          expect(fence.facts[0].supersededBy).toBe(fence.facts[1].rowNum);
          expect(fence.facts[0].active).toBe(false);
          expect((await engine.getPage(slug, { sourceId: source }))?.compiled_truth).toBe(parseMarkdown(body, slug + '.md').compiled_truth);
          expect((await engine.listFactsByEntity(source, slug)).map(f => f.id)).toEqual(second.ids);
          const old = await engine.executeRaw<{ superseded_by: number; valid_until: Date | string }>('SELECT superseded_by, valid_until FROM facts WHERE id = $1', first.ids);
          expect(Number(old[0].superseded_by)).toBe(second.ids[0]);
          expect(new Date(old[0].valid_until).toISOString().slice(0, 10)).toBe(fence.facts[0].validUntil!);
          await engine.insertFacts(extractFactsFromFenceText(fence.facts, slug, source), { source_id: source }, { deleteForPageFirst: { slug } });
          const current = await engine.listFactsByEntity(source, slug);
          expect(current.map(f => f.fact)).toEqual(['Use automatic mode.']);
          const all = await engine.listFactsByEntity(source, slug, { activeOnly: false });
          expect(all.find(f => f.fact === 'Use manual mode.')?.superseded_by).toBe(current[0].id);
        }
      } finally {
        await engine.executeRaw('DELETE FROM sources WHERE id = $1', [source]);
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}
