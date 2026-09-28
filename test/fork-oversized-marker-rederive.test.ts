/**
 * Fork 2026-09-28: the gate-owned `oversized` embed_skip / content_flag
 * markers are re-derived on every import, so a page that is no longer over
 * bytes_block (it shrank, or bytes_block was raised) becomes searchable again
 * on its next import instead of staying embed-skipped for good.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { importFromContent } from '../src/core/import-file.ts';
import { isEmbedSkipped, EMBED_SKIP_KEY } from '../src/core/embed-skip.ts';
import { getContentFlag, CONTENT_FLAG_KEY, dropOversizedGateMarkers } from '../src/core/quarantine.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

/** Runs fn with an isolated GBRAIN_HOME and, when given, a DB-plane bytes_block (what `gbrain config set` writes). */
async function withBlock<T>(bytesBlock: number | null, fn: () => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'oversize-rederive-home-'));
  const audit = mkdtempSync(join(tmpdir(), 'oversize-rederive-audit-'));
  if (bytesBlock !== null) await engine.setConfig('content_sanity.bytes_block', String(bytesBlock));
  try {
    return await withEnv({ GBRAIN_HOME: home, GBRAIN_AUDIT_DIR: audit }, fn);
  } finally {
    if (bytesBlock !== null) await engine.unsetConfig('content_sanity.bytes_block');
    rmSync(home, { recursive: true, force: true });
    rmSync(audit, { recursive: true, force: true });
  }
}

const body = Array.from({ length: 400 }, (_, i) => `Sentence ${i} about the project state and its history.`).join(' ');

describe('fork: oversized markers are re-derived on import', () => {
  test('raising bytes_block makes an embed-skipped page searchable on its next import', async () => {
    const content = `---\ntitle: Grown\ntype: project\n---\n\n${body}`;
    await withBlock(10_000, async () => {
      const first = await importFromContent(engine, 'projects/grown', content, { noEmbed: true });
      expect(first.flag_reason).toBe('oversized');
    });
    const skipped = await engine.getPage('projects/grown');
    expect(isEmbedSkipped(skipped!.frontmatter as Record<string, unknown>)).toBe(true);
    expect(await engine.getChunks('projects/grown')).toHaveLength(0);

    // A trusted re-import of the stored page (markers included), as `quarantine clear` does.
    const stored = serializePageToMarkdown(skipped!, await engine.getTags('projects/grown'));
    await withBlock(1_500_000, async () => {
      const again = await importFromContent(engine, 'projects/grown', stored, { noEmbed: true, forceRechunk: true });
      expect(again.flagged ?? false).toBe(false);
    });
    const healed = await engine.getPage('projects/grown');
    const fm = healed!.frontmatter as Record<string, unknown>;
    expect(isEmbedSkipped(fm)).toBe(false);
    expect(getContentFlag(fm)).toBeNull();
    expect((await engine.getChunks('projects/grown')).length).toBeGreaterThan(0);
  });

  test('a page still over bytes_block keeps both markers and no chunks', async () => {
    const content = `---\ntitle: Big\ntype: note\n---\n\n${body}`;
    await withBlock(10_000, async () => {
      await importFromContent(engine, 'notes/big', content, { noEmbed: true });
      const stored = serializePageToMarkdown((await engine.getPage('notes/big'))!, []);
      await importFromContent(engine, 'notes/big', stored, { noEmbed: true, forceRechunk: true });
    });
    const fm = (await engine.getPage('notes/big'))!.frontmatter as Record<string, unknown>;
    expect((fm[EMBED_SKIP_KEY] as Record<string, unknown>).reason).toBe('oversized');
    expect((fm[CONTENT_FLAG_KEY] as Record<string, unknown>).reason).toBe('oversized');
    expect(await engine.getChunks('notes/big')).toHaveLength(0);
  });

  test('embed_skip with another reason is preserved', async () => {
    const content = `---\ntitle: Code\ntype: note\nembed_skip:\n  reason: finite_lexical_symbols\n---\n\nexport const a = 1;`;
    await withBlock(null, async () => {
      await importFromContent(engine, 'code/lexical', content, { noEmbed: true });
    });
    const fm = (await engine.getPage('code/lexical'))!.frontmatter as Record<string, unknown>;
    expect((fm[EMBED_SKIP_KEY] as Record<string, unknown>).reason).toBe('finite_lexical_symbols');
    expect(await engine.getChunks('code/lexical')).toHaveLength(0);
  });

  test('dropOversizedGateMarkers removes only oversized markers', () => {
    const fm: Record<string, unknown> = {
      [EMBED_SKIP_KEY]: { reason: 'oversized', bytes: 600_000 },
      [CONTENT_FLAG_KEY]: { reason: 'markup_heavy', detail: 'x' },
      title: 'kept',
    };
    dropOversizedGateMarkers(fm);
    expect(fm[EMBED_SKIP_KEY]).toBeUndefined();
    expect((fm[CONTENT_FLAG_KEY] as Record<string, unknown>).reason).toBe('markup_heavy');
    expect(fm.title).toBe('kept');
    dropOversizedGateMarkers(null);
  });
});
