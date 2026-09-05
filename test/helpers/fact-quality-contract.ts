import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { writeFactsToFence, type FenceInputFact } from '../../src/core/facts/fence-write.ts';
import { forgetFactInFence } from '../../src/core/facts/forget.ts';
import { resolveEntitySlug, resolveEntitySlugWithSource } from '../../src/core/entities/resolve.ts';
import { parseFactsFence } from '../../src/core/facts-fence.ts';
import { buildEntityCard } from '../../src/core/verbs/entity-card.ts';

export function factQualityContract(getEngine: () => BrainEngine) {
  test('exact replay dedup survives missing embeddings; provenance and occurrences remain separate', async () => {
    const engine = getEngine();
    const root = mkdtempSync(join(tmpdir(), 'fact-quality-'));
    const sourceId = 'test-fact-quality';
    const target = { sourceId, slug: 'projects/example', localPath: root, resolutionSource: 'exact_page' as const };
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
    const input = (extra: Partial<FenceInputFact> = {}): FenceInputFact => ({ fact: 'Choose manual mode.',
      kind: 'belief', notability: 'high', confidence: 0.95, visibility: 'world',
      source: 'test:review', context: 'analysis/example', validFrom: new Date('2026-01-01'),
      embedding: null, sessionId: null, ...extra });
    try {
      const first = await writeFactsToFence(engine, target, [input()]);
      const file = join(root, 'projects/example.md');
      const before = readFileSync(file, 'utf8');
      const replay = await writeFactsToFence(engine, target, [input()]);
      expect(replay.inserted).toBe(0); expect(replay.duplicate).toBe(1);
      expect(replay.ids).toEqual(first.ids); expect(readFileSync(file, 'utf8')).toBe(before);
      const mixed = await writeFactsToFence(engine, target,
        [input(), input({fact:'Keep a rollback.'}), input({fact:'Keep a rollback.'}), input()]);
      expect(mixed.inserted).toBe(1); expect(mixed.duplicate).toBe(3);
      expect(mixed.ids[0]).toBe(first.ids[0]); expect(mixed.ids[1]).toBe(mixed.ids[2]);
      expect(mixed.ids[3]).toBe(first.ids[0]);
      for (const extra of [{source:'test:independent'}, {context:'analysis/other'}, {sessionId:'other'},
        {kind:'fact' as const}, {fact:'choose manual mode.'}, {validFrom:new Date('2026-01-02')},
        {confidence:0.8}, {notability:'medium' as const}, {validUntil:new Date('2099-01-01')}]) {
        expect((await writeFactsToFence(engine, target, [input(extra)])).inserted).toBe(1);
      }
      const events = await writeFactsToFence(engine, target, [input({kind:'event'}), input({kind:'event'})]);
      expect(events.inserted).toBe(2); expect(events.ids[0]).not.toBe(events.ids[1]);
      const metric = input({fact:'Retain separately structured evidence.'});
      const typed = await writeFactsToFence(engine,target,[metric]);
      await engine.executeRaw('UPDATE facts SET claim_unit=$1 WHERE id=$2',['ms',typed.ids[0]]);
      expect((await writeFactsToFence(engine,target,[metric])).inserted).toBe(1);
      await forgetFactInFence(engine, first.ids[0], { sourceId, reason:'test retirement' });
      const returned = await writeFactsToFence(engine, target, [input()]);
      expect(returned.inserted).toBe(1); expect(returned.ids[0]).not.toBe(first.ids[0]);
      const fence = parseFactsFence(readFileSync(file, 'utf8'));
      expect(fence.warnings).toEqual([]);
      expect(fence.facts.filter(f=>!f.active)).toHaveLength(1);
    } finally { await engine.executeRaw('DELETE FROM sources WHERE id=$1', [sourceId]); rmSync(root,{recursive:true,force:true}); }
  });

  test('curated aliases outrank root stubs; canonical IDs, ambiguity and source boundaries remain strict', async () => {
    const engine = getEngine();
    const sourceId = 'test-quality-alias';
    const other = 'test-quality-foreign';
    for (const source of [sourceId,other]) {
      // page_aliases intentionally has no FK; source deletion alone does not
      // isolate a repeat PostgreSQL run with the same fixture coordinates.
      await engine.executeRaw('DELETE FROM page_aliases WHERE source_id=$1',[source]);
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [source]);
    }
    try {
      for (const slug of ['example','projects/example','projects/other']) {
        await engine.putPage(slug,{type:'project',title:slug,compiled_truth:'Alias fixture'}, {sourceId});
      }
      await engine.setPageAliases('projects/example',sourceId,['example','пример','projects/old-example']);
      expect(await resolveEntitySlug(engine,sourceId,'example')).toBe('projects/example');
      expect(await resolveEntitySlugWithSource(engine,sourceId,'example')).toEqual({slug:'projects/example',source:'alias_exact'});
      expect(await resolveEntitySlug(engine,sourceId,'пример')).toBe('projects/example');
      expect(await resolveEntitySlug(engine,sourceId,'projects/old-example')).toBe('projects/example');
      expect(await resolveEntitySlug(engine,other,'example')).toBe('example');
      await engine.setPageAliases('projects/other',sourceId,['projects/example','example']);
      expect(await resolveEntitySlug(engine,sourceId,'projects/example')).toBe('projects/example');
      const exact = await buildEntityCard(engine,sourceId,'projects/example',{remote:false});
      expect(exact.card?.entity.slug).toBe('projects/example'); expect(exact.ambiguous).toBe(false);
      const ambiguous = await buildEntityCard(engine,sourceId,'example',{remote:false});
      expect(ambiguous.found).toBe(true); expect(ambiguous.ambiguous).toBe(true);
      await expect(resolveEntitySlug(engine,sourceId,'example')).rejects.toThrow('Ambiguous');
      await expect(resolveEntitySlugWithSource(engine,sourceId,'example')).rejects.toThrow('Ambiguous');
      await engine.executeRaw('UPDATE pages SET deleted_at=now() WHERE source_id=$1 AND slug=$2',[sourceId,'projects/other']);
      expect(await resolveEntitySlug(engine,sourceId,'example')).toBe('projects/example');
    } finally { for(const source of [sourceId,other]) {
      await engine.executeRaw('DELETE FROM page_aliases WHERE source_id=$1',[source]);
      await engine.executeRaw('DELETE FROM sources WHERE id=$1',[source]);
    } }
  });
}
