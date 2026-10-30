/** Legacy visibility projection must not mask canonical edits or durable withdrawals. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { parseFactsFence } from '../src/core/facts-fence.ts';
import { recordFactWithdrawal } from '../src/core/facts/withdrawal.ts';

let engine: PGLiteEngine;
let root: string;
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'facts-canonical-world-'));
  mkdirSync(join(root, 'people'));
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
});
afterAll(async () => { await engine.disconnect(); rmSync(root, { recursive: true, force: true }); });

const fence = `## Facts

<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | Works at Example | fact | 1.0 | private | medium | 2026-01-01 |  | legacy-notes |  |
<!--- gbrain:facts:end -->`;

async function seed(section: 'body' | 'timeline', name: string) {
  const slug = `people/${section}-${name}`;
  const body = section === 'body' ? `Intro.\n\n${fence}` : 'Intro.';
  const timeline = section === 'timeline' ? `Timeline unchanged.\n\n${fence}` : 'Timeline unchanged.';
  const content = `${body}\n\n<!-- timeline -->\n\n${timeline}\n`;
  await engine.putPage(slug, { title: slug, type: 'person', compiled_truth: body, timeline, frontmatter: {} });
  const file = join(root, `${slug}.md`);
  writeFileSync(file, content);
  expect((await runExtractFacts(engine, { sourceId: 'default', slugs: [slug] })).factsInserted).toBe(1);
  const page = (await engine.getPage(slug, { sourceId: 'default' }))!;
  expect(parseFactsFence(section === 'body' ? page.compiled_truth : page.timeline).facts[0]!.visibility).toBe('world');
  await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, visibility, source, source_markdown_slug, row_num)
    VALUES ('default', $1, 'Stale indexed row', 'world', 'index-drift', $1, 999)`, [slug]);
  return { slug, file, content };
}

const rows = (slug: string) => engine.executeRaw<{ id: number; fact: string; row_num: number | null; expired: boolean }>(
  `SELECT id, fact, row_num, expired_at IS NOT NULL AS expired FROM facts
    WHERE source_id='default' AND source_markdown_slug=$1 ORDER BY id`, [slug]);
const rawPage = (slug: string) => engine.executeRaw(
  "SELECT compiled_truth, timeline, content_hash FROM pages WHERE source_id='default' AND slug=$1", [slug]);

for (const section of ['body', 'timeline'] as const) describe(`legacy private fence in ${section}`, () => {
  test('unchanged canonical text allows drift retirement without rewriting the file or stored body/hash', async () => {
    const { slug, file, content } = await seed(section, 'unchanged');
    const before = await rawPage(slug);
    const result = await runExtractFacts(engine, { sourceId: 'default', slugs: [slug] });
    expect(result.warnings.some(w => w.includes('FACTS_PAGE_CACHE_STALE'))).toBe(false);
    expect(result.factsDeleted).toBe(1);
    expect((await rows(slug)).map(({ fact, row_num, expired }) => ({ fact, row_num, expired }))).toEqual([
      { fact: 'Works at Example', row_num: 1, expired: false },
      { fact: 'Stale indexed row', row_num: null, expired: true },
    ]);
    expect(await rawPage(slug)).toEqual(before);
    expect(readFileSync(file, 'utf8')).toBe(content);
  });

  for (const [kind, oldText, newText] of [
    ['claim', 'Works at Example', 'Works at Different'],
    ['source', 'legacy-notes', 'new-evidence'],
    ['timeline', 'Timeline unchanged.', 'Timeline genuinely changed.'],
  ] as const) test(`a real ${kind} edit keeps the index and refuses destructive reconcile`, async () => {
    const { slug, file, content } = await seed(section, kind);
    const before = await rows(slug);
    writeFileSync(file, content.replace(oldText, newText));
    const result = await runExtractFacts(engine, { sourceId: 'default', slugs: [slug] });
    expect(result.warnings.some(w => w.includes('FACTS_PAGE_CACHE_STALE'))).toBe(true);
    expect(result.factsDeleted).toBe(0);
    expect(result.factsInserted).toBe(0);
    expect(await rows(slug)).toEqual(before);
  });

  test('a withdrawal overlay remains different from the old canonical fence and is never revived', async () => {
    const { slug, file, content } = await seed(section, 'withdrawn');
    const original = (await rows(slug)).find(row => row.fact === 'Works at Example')!;
    expect((await recordFactWithdrawal(engine, Number(original.id), 'default', false, { semanticReview: false })).withdrawn).toBe(true);
    const page = (await engine.getPage(slug, { sourceId: 'default' }))!;
    expect(parseFactsFence(section === 'body' ? page.compiled_truth : page.timeline).facts[0]!.forgotten).toBe(true);
    const before = await rows(slug);
    const result = await runExtractFacts(engine, { sourceId: 'default', slugs: [slug] });
    expect(result.warnings.some(w => w.includes('FACTS_PAGE_CACHE_STALE'))).toBe(true);
    expect(result.factsDeleted).toBe(0);
    expect(await rows(slug)).toEqual(before);
    expect((await rows(slug)).find(row => row.id === original.id)!.expired).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(content);
  });
});
