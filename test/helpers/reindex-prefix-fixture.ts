import { expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { runReindex } from '../../src/commands/reindex.ts';
import { MARKDOWN_CHUNKER_VERSION } from '../../src/core/chunkers/recursive.ts';

/** Exercise the real count and bounded write paths on either engine. */
export async function checkLiteralReindexPrefix(engine: BrainEngine): Promise<void> {
  for (const id of ['scope-test', 'scope-foreign']) {
    await engine.executeRaw(
      "INSERT INTO sources(id,name,config) VALUES($1,$1,'{}'::jsonb) ON CONFLICT(id) DO NOTHING", [id],
    );
  }
  const wanted = ['projects/repo_one', 'projects/repo_one/guide', 'projects/repo_one/nested/item'];
  const rows = [
    ...wanted.map(slug => ({ slug, source: 'scope-test', kind: 'markdown', version: 1, retired: false })),
    ...['projects/repoXone/decoy', 'projects/repo_one_more/decoy', 'projects/repo_one-other'].map(
      slug => ({ slug, source: 'scope-test', kind: 'markdown', version: 1, retired: false }),
    ),
    { slug: wanted[1]!, source: 'scope-foreign', kind: 'markdown', version: 1, retired: false },
    { slug: 'projects/repo_one/retired', source: 'scope-test', kind: 'markdown', version: 1, retired: true },
    { slug: 'projects/repo_one/code', source: 'scope-test', kind: 'code', version: 1, retired: false },
    { slug: 'projects/repo_one/current', source: 'scope-test', kind: 'markdown', version: MARKDOWN_CHUNKER_VERSION, retired: false },
  ];
  for (const row of rows) {
    await engine.executeRaw(
      `INSERT INTO pages(source_id,slug,type,title,compiled_truth,page_kind,chunker_version,deleted_at)
       VALUES($1,$2,'note',$2,'Synthetic scope fixture paragraph.',$3,$4,
              CASE WHEN $5::boolean THEN now() ELSE NULL END)`,
      [row.source, row.slug, row.kind, row.version, row.retired],
    );
  }
  const snapshot = () => engine.executeRaw<{ source_id: string; slug: string; row_hash: string; chunker_version: number }>(
    `SELECT source_id,slug,chunker_version,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') AS row_hash
       FROM pages p WHERE source_id IN ('scope-test','scope-foreign') ORDER BY source_id,slug`,
  );
  const before = await snapshot();
  const args = ['--markdown', '--source', 'scope-test', '--prefix', '//projects//repo_one///', '--no-embed'];
  const dry = await runReindex(engine, [...args, '--dry-run']);
  expect(dry.pending).toBe(3);
  expect(await snapshot()).toEqual(before);
  const first = await runReindex(engine, [...args, '--hot-first', '--limit', '2']);
  expect(first).toMatchObject({ reindexed: 2, failed: 0, pendingAfter: 1 });
  const second = await runReindex(engine, [...args, '--limit', '2']);
  expect(second).toMatchObject({ reindexed: 1, failed: 0, pendingAfter: 0 });
  const after = await snapshot();
  expect(after.map(row => [row.source_id, row.slug])).toEqual(before.map(row => [row.source_id, row.slug]));
  for (const row of after) {
    if (row.source_id === 'scope-test' && wanted.includes(row.slug)) {
      expect(Number(row.chunker_version)).toBe(MARKDOWN_CHUNKER_VERSION);
    } else {
      expect(row).toEqual(before.find(old => old.source_id === row.source_id && old.slug === row.slug)!);
    }
  }
  expect((await runReindex(engine, [...args, '--dry-run'])).pending).toBe(0);
}
