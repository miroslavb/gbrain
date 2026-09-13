/**
 * World-only fact projection, private take stripping, and durable forget history.
 *
 * Three layers under test:
 *   - Layer A (chunker): chunkText normalizes legacy private facts to world;
 *     private takes remain excluded from content_chunks
 *   - Layer B: get_page/fetch project legacy facts in body and timeline;
 *     private takes retain their independent holder boundary
 *   - Forget-as-fence: forgetFactInFence rewrites the fence row instead of
 *     the DB-only expire path so forgets survive gbrain rebuild (Codex R2-#3)
 *
 * Real PGLite + tempdir filesystem.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { chunkText } from '../src/core/chunkers/recursive.ts';
import { forgetFactInFence } from '../src/core/facts/forget.ts';
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END, parseFactsFence } from '../src/core/facts-fence.ts';
import { operations } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';

let engine: PGLiteEngine;
let brainDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM fact_withdrawals');
  brainDir = mkdtempSync(join(tmpdir(), 'privacy-test-'));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).db.query('DELETE FROM facts');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).db.query(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [brainDir]);
});

const FENCE_BODY = (rows: string): string => `# Page

Some text.

## Facts

${FACTS_FENCE_BEGIN}
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
${rows}
${FACTS_FENCE_END}
`;

// ─────────────────────────────────────────────────────────────────
// Layer A: chunker normalizes legacy private fact rows into the world view
// ─────────────────────────────────────────────────────────────────

describe('Layer A — chunker world-only fact rows', () => {
  test('chunkText retains and normalizes legacy private fact text', () => {
    const body = FENCE_BODY(
      `| 1 | PUBLIC_FACT_PROOF | fact | 1.0 | world | high | 2026-01-01 |  | s |  |
| 2 | PRIVATE_FACT_PROOF | fact | 1.0 | private | high | 2026-01-01 |  | s |  |`,
    );
    const chunks = chunkText(body);
    const allText = chunks.map(c => c.text).join('\n');

    expect(allText).toContain('PUBLIC_FACT_PROOF');
    expect(allText).toContain('PRIVATE_FACT_PROOF');
    expect(allText).not.toContain('| private |');
  });

  test('legacy-private-only fence and surrounding prose both survive', () => {
    const body = FENCE_BODY(
      `| 1 | SECRET | fact | 1.0 | private | high | 2026-01-01 |  | s |  |`,
    );
    const chunks = chunkText(body);
    const allText = chunks.map(c => c.text).join('\n');

    expect(allText).toContain('SECRET');
    expect(allText).toContain('| world |');
    expect(allText).toContain('Some text.');
  });

  test('no fence at all → chunker behavior unchanged', () => {
    const body = '# Just a page\n\nNo fence here.\n';
    const chunks = chunkText(body);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].text).toContain('Just a page');
  });

  test('private takes fence ALSO stripped (regression — v0.28 behavior preserved)', () => {
    const body = `# Page

<!--- gbrain:takes:begin -->
| # | claim | kind | who | weight | since | source |
|---|-------|------|-----|--------|-------|--------|
| 1 | PRIVATE_TAKE | take | brain | 0.9 | 2026-01-01 |  |
<!--- gbrain:takes:end -->

Body text.`;
    const chunks = chunkText(body);
    const allText = chunks.map(c => c.text).join('\n');
    expect(allText).not.toContain('PRIVATE_TAKE');
    expect(allText).toContain('Body text');
  });
});

// ─────────────────────────────────────────────────────────────────
// Layer B: get_page projects legacy fact rows into the shared world view
// ─────────────────────────────────────────────────────────────────
//
// Exercise both the pure projection and the real get_page/fetch handlers.
// remote-privacy-sweep.test.ts owns the shared dispatch envelope coverage.

describe('Layer B — get_page world-only fact projection', () => {
  test('stripFactsFence({keepVisibility:["world"]}) retains and normalizes legacy rows', async () => {
    const { stripFactsFence } = await import('../src/core/facts-fence.ts');
    const body = FENCE_BODY(
      `| 1 | WORLD_ROW | fact | 1.0 | world | high | 2026-01-01 |  | s |  |
| 2 | PRIVATE_ROW | fact | 1.0 | private | high | 2026-01-01 |  | s |  |`,
    );
    const stripped = stripFactsFence(body, { keepVisibility: ['world'] });
    expect(stripped).toContain('WORLD_ROW');
    expect(stripped).toContain('PRIVATE_ROW');
    expect(stripped).not.toContain('| private |');
  });

  // Fences below the timeline delimiter must receive the same projection
  // as compiled_truth, including the assembled content round-trip field.
  describe('timeline and body share the world-only projection', () => {
    function makeCtx(opts: Partial<OperationContext> = {}): OperationContext {
      return {
        engine,
        config: { engine: 'pglite' as const },
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        dryRun: false,
        remote: false,
        sourceId: 'default',
        // Cross-file gateway-state hermeticity (see put-page-provenance.test.ts's
        // beforeAll comment): put_page's noEmbed = ctx.deferEmbeds === true ||
        // !isAvailable('embedding') — relying on the ambient isAvailable() check
        // means a sibling file sharing this shard's process that configured a
        // live embedding provider makes put_page attempt a real embed call here,
        // which hangs without a stubbed transport. Force it off explicitly.
        deferEmbeds: true,
        ...opts,
      };
    }

    const MISPLACED_FENCE_CONTENT = `---
title: alice
type: person
---

Some body content.

<!-- timeline -->

## Facts

${FACTS_FENCE_BEGIN}
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | PUBLIC_TIMELINE_FACT | fact | 1.0 | world | high | 2026-01-01 |  | s |  |
| 2 | PRIVATE_TIMELINE_FACT | fact | 1.0 | private | high | 2026-01-01 |  | s |  |
${FACTS_FENCE_END}
`;

    test('get_page: local and remote see both rows normalized in timeline and content', async () => {
      const putPageOp = operations.find((o) => o.name === 'put_page')!;
      const getPageOp = operations.find((o) => o.name === 'get_page')!;
      await putPageOp.handler(makeCtx({ remote: false }), {
        slug: 'people/alice-timeline-leak',
        content: MISPLACED_FENCE_CONTENT,
      });

      // Sanity: confirm the fence really landed in timeline, not
      // compiled_truth — otherwise this test would pass for the wrong
      // reason (the compiled_truth projection alone would cover it).
      const raw = await engine.getPage('people/alice-timeline-leak');
      expect(parseFactsFence(raw!.compiled_truth ?? '').facts).toHaveLength(0);
      expect((raw!.timeline ?? '')).toContain('PRIVATE_TIMELINE_FACT');

      const remote = await getPageOp.handler(makeCtx({ remote: true }), {
        slug: 'people/alice-timeline-leak',
        include_content: true,
      }) as { timeline?: string; content?: string };
      expect(remote.timeline).toContain('PUBLIC_TIMELINE_FACT');
      expect(remote.timeline).toContain('PRIVATE_TIMELINE_FACT');
      expect(remote.timeline).not.toContain('| private |');
      expect(remote.content).toContain('PRIVATE_TIMELINE_FACT');
      expect(remote.content).not.toContain('| private |');

      // Control: the local caller sees the same complete fact content.
      const local = await getPageOp.handler(makeCtx({ remote: false }), {
        slug: 'people/alice-timeline-leak',
      }) as { timeline?: string };
      expect(local.timeline).toContain('PRIVATE_TIMELINE_FACT');
    });

    test('fetch_page: serialized text retains and normalizes the legacy timeline row', async () => {
      const putPageOp = operations.find((o) => o.name === 'put_page')!;
      const fetchPageOp = operations.find((o) => o.name === 'fetch')!;
      await putPageOp.handler(makeCtx({ remote: false }), {
        slug: 'people/bob-timeline-leak',
        content: MISPLACED_FENCE_CONTENT.replace('alice', 'bob'),
      });

      const remote = await fetchPageOp.handler(makeCtx({ remote: true }), {
        id: 'people/bob-timeline-leak',
      }) as { text?: string };
      expect(remote.text).toContain('PUBLIC_TIMELINE_FACT');
      expect(remote.text).toContain('PRIVATE_TIMELINE_FACT');
      expect(remote.text).not.toContain('| private |');
    });
  });
});

// ─────────────────────────────────────────────────────────────────
// Every valid fact row is visible on this host. Remote write-back preserves
// the caller's edits and deletions; missing legacy-private rows are no longer
// inferred to be hidden and must never be resurrected. Malformed input stays
// byte-preserved with parser warnings rather than being silently repaired.
// ─────────────────────────────────────────────────────────────────

describe('world-only facts remote write-back', () => {
  function makeCtx(opts: Partial<OperationContext> = {}): OperationContext {
    return {
      engine,
      config: { engine: 'pglite' as const },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      dryRun: false,
      remote: false,
      sourceId: 'default',
      deferEmbeds: true,
      ...opts,
    };
  }
  const putPageOp = () => operations.find((o) => o.name === 'put_page')!;
  const getPageOp = () => operations.find((o) => o.name === 'get_page')!;

  async function remoteRoundTrip(slug: string, edit: (content: string) => string): Promise<void> {
    const remote = await getPageOp().handler(makeCtx({ remote: true }), {
      slug,
      include_content: true,
    }) as { content?: string };
    await putPageOp().handler(makeCtx({ remote: true }), { slug, content: edit(remote.content ?? '') });
  }

  test('mixed legacy fence retains every visible row on a remote prose-edit round-trip', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const slug = 'people/p1-mixed-merge';
      const fence = FENCE_BODY(
        `| 1 | PUBLIC_P1_FACT | fact | 1.0 | world | high | 2026-01-01 |  | s |  |
| 2 | PRIVATE_P1_FACT | fact | 1.0 | private | high | 2026-01-02 |  | s |  |`,
      );
      await putPageOp().handler(makeCtx({ remote: false }), { slug, content: fence });
      warnSpy.mockClear();
      await remoteRoundTrip(slug, (c) => c.replace('Some text.', 'Some text edited.'));

      const raw = await engine.getPage(slug, { sourceId: 'default' });
      const parsed = parseFactsFence(raw?.compiled_truth ?? '');
      expect(raw?.compiled_truth ?? '').toContain('Some text edited.');
      expect(parsed.facts.map((f) => [f.rowNum, f.claim])).toEqual([
        [1, 'PUBLIC_P1_FACT'],
        [2, 'PRIVATE_P1_FACT'],
      ]);
      // The gap is CLOSED — no "#2044 gap" data-loss warning fires anymore.
      const warnedGap = warnSpy.mock.calls.some((c) => String(c[0]).includes('#2044 gap'));
      expect(warnedGap).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('mixed adds+edits+deletes honor visible edits, retained legacy rows, and additions', async () => {
    const slug = 'people/mixed-adds-edits-deletes';
    const fence = FENCE_BODY(
      `| 1 | PUBLIC_A | fact | 1.0 | world | high | 2026-01-01 |  | s |  |
| 2 | SECRET_B | fact | 1.0 | private | high | 2026-01-02 |  | s |  |
| 3 | PUBLIC_C | fact | 1.0 | world | high | 2026-01-03 |  | s |  |`,
    );
    await putPageOp().handler(makeCtx({ remote: false }), { slug, content: fence });
    await remoteRoundTrip(slug, (c) => c
      .replace('PUBLIC_A', 'PUBLIC_A_EDITED')                        // edit visible row 1
      .split('\n').filter((l) => !l.includes('PUBLIC_C')).join('\n') // delete visible row 3
      .replace(FACTS_FENCE_END,
        `| 4 | CALLER_ADDED_FACT | fact | 0.9 | world | medium | 2026-02-01 |  | s |  |\n${FACTS_FENCE_END}`),
    );

    const raw = await engine.getPage(slug, { sourceId: 'default' });
    const parsed = parseFactsFence(raw?.compiled_truth ?? '');
    expect(parsed.facts.map((f) => [f.rowNum, f.claim])).toEqual([
      [1, 'PUBLIC_A_EDITED'],   // caller's edit of a visible row respected
      [2, 'SECRET_B'],          // retained visible legacy row keeps its stable rowNum
      [4, 'CALLER_ADDED_FACT'], // caller's addition kept
    ]);
    expect(raw?.compiled_truth ?? '').not.toContain('PUBLIC_C'); // visible deletion honored
  });

  test('deleting a visible legacy-private row remotely never resurrects it', async () => {
    const slug = 'people/legacy-visible-delete';
    await putPageOp().handler(makeCtx(), { slug, content: FENCE_BODY(
      `| 1 | RETAINED_WORLD_ROW | fact | 1.0 | world | high | 2026-01-01 |  | s |  |
| 2 | DELETED_LEGACY_ROW | fact | 1.0 | private | high | 2026-01-02 |  | s |  |`,
    ) });
    await remoteRoundTrip(slug, content => {
      expect(content).toContain('DELETED_LEGACY_ROW');
      expect(content).not.toContain('| private |');
      return content.split('\n').filter(line => !line.includes('DELETED_LEGACY_ROW')).join('\n');
    });
    const page = await engine.getPage(slug, { sourceId: 'default' });
    expect(parseFactsFence(page?.compiled_truth ?? '').facts.map(f => f.claim)).toEqual(['RETAINED_WORLD_ROW']);
    expect(page?.compiled_truth ?? '').not.toContain('DELETED_LEGACY_ROW');
  });

  test('duplicate visible rowNum remains malformed without silently renumbering canonical references', async () => {
    const slug = 'people/collision-renumber';
    const fence = FENCE_BODY(
      `| 1 | PUBLIC_COLLIDE | fact | 1.0 | world | high | 2026-01-01 |  | s |  |
| 2 | SECRET_COLLIDE | fact | 1.0 | private | high | 2026-01-02 |  | s |  |`,
    );
    await putPageOp().handler(makeCtx({ remote: false }), { slug, content: fence });
    // Both rows were visible. Reusing #2 is malformed caller input, not
    // evidence for an automatic hidden-row restoration or renumbering.
    await remoteRoundTrip(slug, (c) => c.replace(FACTS_FENCE_END,
      `| 2 | CALLER_COLLIDING_ADD | fact | 0.9 | world | medium | 2026-02-01 |  | s |  |\n${FACTS_FENCE_END}`,
    ));

    const raw = await engine.getPage(slug, { sourceId: 'default' });
    const parsed = parseFactsFence(raw?.compiled_truth ?? '');
    expect(parsed.facts.map((f) => [f.rowNum, f.claim])).toEqual([
      [1, 'PUBLIC_COLLIDE'],
      [2, 'SECRET_COLLIDE'], // stable rowNum preserved (cross-page #F<N> refs)
    ]);
    expect(parsed.warnings).toContain('FACTS_ROW_NUM_COLLISION: duplicate row_num 2');
    expect(raw?.compiled_truth ?? '').toContain('| 2 | CALLER_COLLIDING_ADD |');
    expect(raw?.compiled_truth ?? '').not.toContain('| 3 | CALLER_COLLIDING_ADD |');
  });

  test('legacy-private-only fence round-trip retains content without restoration warnings', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const slug = 'people/no-warn-allprivate';
      const fence = FENCE_BODY(
        '| 1 | PRIVATE_NOWARN_FACT | fact | 1.0 | private | high | 2026-01-01 |  | s |  |',
      );
      await putPageOp().handler(makeCtx({ remote: false }), { slug, content: fence });
      warnSpy.mockClear();
      await remoteRoundTrip(slug, (c) => c.replace('Some text.', 'Some text edited.'));

      const anyWarning = warnSpy.mock.calls.some((c) => String(c[0]).includes('#2044'));
      expect(anyWarning).toBe(false);
      const raw = await engine.getPage(slug, { sourceId: 'default' });
      expect((raw?.compiled_truth ?? '')).toContain('PRIVATE_NOWARN_FACT');
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('idempotence: a remote write carrying all visible rows does not duplicate them', async () => {
    const slug = 'people/full-content-writeback';
    const fence = FENCE_BODY(
      `| 1 | PUBLIC_FULL | fact | 1.0 | world | high | 2026-01-01 |  | s |  |
| 2 | SECRET_FULL | fact | 1.0 | private | high | 2026-01-02 |  | s |  |`,
    );
    await putPageOp().handler(makeCtx({ remote: false }), { slug, content: fence });
    // A remote writer writes all visible rows back, with a prose edit so
    // the import is not a hash-match skip.
    await putPageOp().handler(makeCtx({ remote: true }), {
      slug,
      content: fence.replace('Some text.', 'Some text edited.'),
    });

    const raw = await engine.getPage(slug, { sourceId: 'default' });
    const parsed = parseFactsFence(raw?.compiled_truth ?? '');
    expect(parsed.facts).toHaveLength(2);
    expect(parsed.facts.map((f) => [f.rowNum, f.claim])).toEqual([
      [1, 'PUBLIC_FULL'],
      [2, 'SECRET_FULL'],
    ]);
  });

  test('malformed incoming fence preserves caller text without a false hidden-row loss warning', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const slug = 'people/malformed-residual';
      const fence = FENCE_BODY(
        `| 1 | PUBLIC_MAL | fact | 1.0 | world | high | 2026-01-01 |  | s |  |
| 2 | SECRET_MAL | fact | 1.0 | private | high | 2026-01-02 |  | s |  |`,
      );
      await putPageOp().handler(makeCtx({ remote: false }), { slug, content: fence });
      warnSpy.mockClear();
      // The caller mangles the visible row's kind — the incoming fence now
      // parses with warnings, so the merge refuses to rewrite it (it can't
      // re-render rows it couldn't parse without losing caller content).
      // The second row remains present; do not invent a hidden-row loss.
      await remoteRoundTrip(slug, (c) => c.replace('| fact |', '| banana |'));

      const warnedGap = warnSpy.mock.calls.some(
        (c) => String(c[0]).includes('#2044 gap') && String(c[0]).includes(slug),
      );
      expect(warnedGap).toBe(false);
      const raw = await engine.getPage(slug, { sourceId: 'default' });
      expect((raw?.compiled_truth ?? '')).toContain('SECRET_MAL');
      expect(raw?.compiled_truth ?? '').toContain('| banana |');
      expect(parseFactsFence(raw?.compiled_truth ?? '').warnings.some(w => w.includes('unknown kind'))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('no merge, no warning: a normal local (non-remote) edit sees the full fence and its deletions are honored', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const slug = 'people/no-warn-local';
      const fence = FENCE_BODY(
        `| 1 | LOCAL_WORLD_FACT | fact | 1.0 | world | high | 2026-01-01 |  | s |  |
| 2 | LOCAL_PRIVATE_FACT | fact | 1.0 | private | high | 2026-01-02 |  | s |  |`,
      );
      await putPageOp().handler(makeCtx({ remote: false }), { slug, content: fence });
      warnSpy.mockClear();
      // Local write that drops both rows -- fully-informed, no merge, no diagnostic.
      await putPageOp().handler(makeCtx({ remote: false }), {
        slug,
        content: '# Page\n\nSome text edited.\n',
      });

      const anyWarning = warnSpy.mock.calls.some((c) => String(c[0]).includes('#2044'));
      expect(anyWarning).toBe(false);
      const raw = await engine.getPage(slug, { sourceId: 'default' });
      expect((raw?.compiled_truth ?? '')).not.toContain('LOCAL_PRIVATE_FACT');
      expect((raw?.compiled_truth ?? '')).not.toContain('LOCAL_WORLD_FACT');
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// #4554: a fully-visible world-only fence deletion is a legitimate edit —
// under the row-level merge it stays deleted (no whole-block resurrection),
// and the old "#2044 restoration ... may have genuinely deleted" warn
// (#4555) no longer misfires: nothing world-visible is ever restored.
// ─────────────────────────────────────────────────────────────────

describe('#4554 world-only fence deletion honored (no resurrection, no misfiring warn)', () => {
  function makeCtx(opts: Partial<OperationContext> = {}): OperationContext {
    return {
      engine,
      config: { engine: 'pglite' as const },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      dryRun: false,
      remote: false,
      sourceId: 'default',
      deferEmbeds: true,
      ...opts,
    };
  }
  const putPageOp = () => operations.find((o) => o.name === 'put_page')!;
  const getPageOp = () => operations.find((o) => o.name === 'get_page')!;

  test('deleting a world-only fence over remote round-trip: deletion sticks, no restoration warn fires', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const slug = 'people/p2-worldonly-honored';
      const fence = FENCE_BODY(
        '| 1 | WORLD_ONLY_P2_FACT | fact | 1.0 | world | high | 2026-01-01 |  | s |  |',
      );
      await putPageOp().handler(makeCtx({ remote: false }), { slug, content: fence });

      const remote = await getPageOp().handler(makeCtx({ remote: true }), {
        slug,
        include_content: true,
      }) as { content?: string };
      const body = remote.content ?? '';
      const factsHeadingIdx = body.indexOf('## Facts');
      const fenceEndIdx = body.indexOf(FACTS_FENCE_END) + FACTS_FENCE_END.length;
      const edited = body.slice(0, factsHeadingIdx).replace('Some text.', 'Some text, fence removed.')
        + body.slice(fenceEndIdx);
      warnSpy.mockClear();
      await putPageOp().handler(makeCtx({ remote: true }), { slug, content: edited });

      // The caller saw the whole fence and chose to remove it — honored.
      const raw = await engine.getPage(slug, { sourceId: 'default' });
      expect((raw?.compiled_truth ?? '')).not.toContain('WORLD_ONLY_P2_FACT');
      // And no "#2044 restoration"/"#2044" warn misfires about it.
      const anyWarning = warnSpy.mock.calls.some((c) => String(c[0]).includes('#2044'));
      expect(anyWarning).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('deleting one visible row of a mixed legacy fence retains only the row the caller kept', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const slug = 'people/p2-mixed-world-delete';
      const fence = FENCE_BODY(
        `| 1 | WORLD_DELETE_ME | fact | 1.0 | world | high | 2026-01-01 |  | s |  |
| 2 | PRIVATE_KEEP_ME | fact | 1.0 | private | high | 2026-01-02 |  | s |  |`,
      );
      await putPageOp().handler(makeCtx({ remote: false }), { slug, content: fence });

      const remote = await getPageOp().handler(makeCtx({ remote: true }), {
        slug,
        include_content: true,
      }) as { content?: string };
      // Delete the (visible) world row but keep the fence itself.
      const edited = (remote.content ?? '')
        .split('\n').filter((l) => !l.includes('WORLD_DELETE_ME')).join('\n');
      warnSpy.mockClear();
      await putPageOp().handler(makeCtx({ remote: true }), { slug, content: edited });

      const raw = await engine.getPage(slug, { sourceId: 'default' });
      const parsed = parseFactsFence(raw?.compiled_truth ?? '');
      expect(parsed.facts.map((f) => [f.rowNum, f.claim])).toEqual([
        [2, 'PRIVATE_KEEP_ME'], // retained — the caller kept this visible row
      ]);
      expect((raw?.compiled_truth ?? '')).not.toContain('WORLD_DELETE_ME');
      // No row was hidden or restored, so no restoration warning is valid.
      const anyWarning = warnSpy.mock.calls.some((c) => String(c[0]).includes('#2044'));
      expect(anyWarning).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('partial deletion of a world-only fence: exactly the kept rows remain, deleted ones stay deleted', async () => {
    const slug = 'people/p2-worldonly-partial';
    const fence = FENCE_BODY(
      `| 1 | WORLD_KEEP_A | fact | 1.0 | world | high | 2026-01-01 |  | s |  |
| 2 | WORLD_DROP_B | fact | 1.0 | world | high | 2026-01-02 |  | s |  |
| 3 | WORLD_KEEP_C | fact | 1.0 | world | high | 2026-01-03 |  | s |  |`,
    );
    await putPageOp().handler(makeCtx({ remote: false }), { slug, content: fence });

    const remote = await getPageOp().handler(makeCtx({ remote: true }), {
      slug,
      include_content: true,
    }) as { content?: string };
    const edited = (remote.content ?? '')
      .split('\n').filter((l) => !l.includes('WORLD_DROP_B')).join('\n');
    await putPageOp().handler(makeCtx({ remote: true }), { slug, content: edited });

    const raw = await engine.getPage(slug, { sourceId: 'default' });
    const parsed = parseFactsFence(raw?.compiled_truth ?? '');
    expect(parsed.facts.map((f) => [f.rowNum, f.claim])).toEqual([
      [1, 'WORLD_KEEP_A'],
      [3, 'WORLD_KEEP_C'],
    ]);
  });

  test('visible forget history retains inactivity, expiry, and strike-through on round-trip', async () => {
    const slug = 'people/p2-forgotten-roundtrip';
    const fence = FENCE_BODY(
      `| 1 | WORLD_VISIBLE_FACT | fact | 1.0 | world | high | 2026-01-01 |  | s |  |
| 2 | ~~FORGOTTEN_SECRET~~ | fact | 0.9 | private | low | 2026-01-02 | 2026-02-01 | s | forgotten: user asked to remove |`,
    );
    await putPageOp().handler(makeCtx({ remote: false }), { slug, content: fence });

    const remote = await getPageOp().handler(makeCtx({ remote: true }), {
      slug,
      include_content: true,
    }) as { content?: string };
    expect(remote.content ?? '').toContain('~~FORGOTTEN_SECRET~~');
    expect(remote.content ?? '').not.toContain('| private |');
    await putPageOp().handler(makeCtx({ remote: true }), {
      slug,
      content: (remote.content ?? '').replace('Some text.', 'Some text edited.'),
    });

    const raw = await engine.getPage(slug, { sourceId: 'default' });
    const parsed = parseFactsFence(raw?.compiled_truth ?? '');
    const restoredRow = parsed.facts.find((f) => f.rowNum === 2);
    expect(restoredRow?.claim).toBe('FORGOTTEN_SECRET');
    expect(restoredRow?.active).toBe(false);       // strikethrough survives the merge
    expect(restoredRow?.forgotten).toBe(true);     // forget-as-fence history survives
    expect(restoredRow?.validUntil).toBe('2026-02-01');
  });
});

// ─────────────────────────────────────────────────────────────────
// Timeline-embedded facts obey the same visible edit/delete contract as
// body facts; their storage column and forget history remain stable.
// ─────────────────────────────────────────────────────────────────

describe('#4546 timeline-embedded fence survives a remote round-trip', () => {
  function makeCtx(opts: Partial<OperationContext> = {}): OperationContext {
    return {
      engine,
      config: { engine: 'pglite' as const },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      dryRun: false,
      remote: false,
      sourceId: 'default',
      deferEmbeds: true,
      ...opts,
    };
  }
  const putPageOp = () => operations.find((o) => o.name === 'put_page')!;
  const getPageOp = () => operations.find((o) => o.name === 'get_page')!;

  const TIMELINE_FENCE_CONTENT = (slug: string) => `---
title: ${slug}
type: person
---

Body content.

<!-- timeline -->

## Facts

${FACTS_FENCE_BEGIN}
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | TL_PUBLIC_FACT | fact | 1.0 | world | high | 2026-01-01 |  | s |  |
| 2 | TL_SECRET_FACT | fact | 1.0 | private | high | 2026-01-02 |  | s |  |
${FACTS_FENCE_END}
`;

  test('remote prose-edit preserves both visible rows in the timeline column', async () => {
    const slug = 'people/tl-roundtrip-restore';
    await putPageOp().handler(makeCtx({ remote: false }), {
      slug,
      content: TIMELINE_FENCE_CONTENT(slug),
    });
    // Sanity: the fence really lives in timeline and both rows are visible.
    const raw = await engine.getPage(slug, { sourceId: 'default' });
    expect(parseFactsFence(raw!.compiled_truth ?? '').facts).toHaveLength(0);
    expect(raw!.timeline ?? '').toContain('TL_SECRET_FACT');
    const remote = await getPageOp().handler(makeCtx({ remote: true }), {
      slug,
      include_content: true,
    }) as { content?: string };
    expect(remote.content ?? '').toContain('TL_SECRET_FACT');
    expect(remote.content ?? '').not.toContain('| private |');

    await putPageOp().handler(makeCtx({ remote: true }), {
      slug,
      content: (remote.content ?? '').replace('Body content.', 'Body content, edited remotely.'),
    });

    const after = await engine.getPage(slug, { sourceId: 'default' });
    const parsed = parseFactsFence(after?.timeline ?? '');
    expect(parsed.facts.map((f) => [f.rowNum, f.claim])).toEqual([
      [1, 'TL_PUBLIC_FACT'],
      [2, 'TL_SECRET_FACT'], // retained in timeline, not lost, not moved
    ]);
    // The retained row stays in the timeline column; compiled_truth gains no fence.
    expect(parseFactsFence(after?.compiled_truth ?? '').facts).toHaveLength(0);
    expect(after?.compiled_truth ?? '').toContain('Body content, edited remotely.');
  });

  test('deleting a timeline row sticks while the retained legacy row stays in timeline', async () => {
    const slug = 'people/tl-roundtrip-world-delete';
    await putPageOp().handler(makeCtx({ remote: false }), {
      slug,
      content: TIMELINE_FENCE_CONTENT(slug),
    });
    const remote = await getPageOp().handler(makeCtx({ remote: true }), {
      slug,
      include_content: true,
    }) as { content?: string };
    const edited = (remote.content ?? '')
      .split('\n').filter((l) => !l.includes('TL_PUBLIC_FACT')).join('\n');
    await putPageOp().handler(makeCtx({ remote: true }), { slug, content: edited });

    const after = await engine.getPage(slug, { sourceId: 'default' });
    const parsed = parseFactsFence(after?.timeline ?? '');
    expect(parsed.facts.map((f) => [f.rowNum, f.claim])).toEqual([
      [2, 'TL_SECRET_FACT'],
    ]);
    expect(after?.timeline ?? '').not.toContain('TL_PUBLIC_FACT');
  });

  test('local trusted round-trip of a timeline fence is untouched by the merge', async () => {
    const slug = 'people/tl-local-untouched';
    await putPageOp().handler(makeCtx({ remote: false }), {
      slug,
      content: TIMELINE_FENCE_CONTENT(slug),
    });
    // Local caller deletes the ENTIRE timeline fence — fully informed, honored.
    const local = await getPageOp().handler(makeCtx({ remote: false }), {
      slug,
      include_content: true,
    }) as { content?: string };
    const fenceBegin = (local.content ?? '').indexOf('## Facts');
    const fenceEnd = (local.content ?? '').indexOf(FACTS_FENCE_END) + FACTS_FENCE_END.length;
    const edited = (local.content ?? '').slice(0, fenceBegin) + (local.content ?? '').slice(fenceEnd);
    await putPageOp().handler(makeCtx({ remote: false }), { slug, content: edited });

    const after = await engine.getPage(slug, { sourceId: 'default' });
    expect(after?.timeline ?? '').not.toContain('TL_SECRET_FACT');
    expect(after?.timeline ?? '').not.toContain('TL_PUBLIC_FACT');
  });
});

// ─────────────────────────────────────────────────────────────────
// Forget-as-fence (Codex R2-#3)
// ─────────────────────────────────────────────────────────────────

async function seedV51Fact(opts: {
  entity_slug: string;
  source_markdown_slug: string;
  row_num: number;
  fact: string;
  source?: string;
}): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = await (engine as any).db.query(
    `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability,
                        valid_from, source, confidence, row_num, source_markdown_slug)
     VALUES ('default', $1, $2, 'fact', 'world', 'medium', now(), $3, 1.0, $4, $5)
     RETURNING id`,
    [opts.entity_slug, opts.fact, opts.source ?? 's', opts.row_num, opts.source_markdown_slug],
  );
  return r.rows[0].id;
}

function seedFile(slug: string, rows: string): void {
  const filePath = join(brainDir, `${slug}.md`);
  mkdirSync(join(brainDir, slug.split('/')[0]), { recursive: true });
  writeFileSync(filePath, FENCE_BODY(rows), 'utf-8');
}

describe('forgetFactInFence — fence path (happy)', () => {
  test('rewrites the fence row with strikethrough + valid_until + forgotten context', async () => {
    const id = await seedV51Fact({
      entity_slug: 'people/alice', source_markdown_slug: 'people/alice',
      row_num: 1, fact: 'I will hit $10M by Q4',
    });
    seedFile('people/alice', `| 1 | I will hit $10M by Q4 | fact | 1.0 | world | medium | 2026-01-01 |  | s |  |`);

    const r = await forgetFactInFence(engine, id, { reason: 'changed my mind' });
    expect(r.ok).toBe(true);
    expect(r.path).toBe('fence');

    const body = readFileSync(join(brainDir, 'people/alice.md'), 'utf-8');
    expect(body).toContain('~~I will hit $10M by Q4~~');
    expect(body).toContain('forgotten: changed my mind');

    // DB row expired_at is now non-null + valid_until set to today.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dbRow = await (engine as any).db.query(
      'SELECT expired_at, valid_until FROM facts WHERE id = $1', [id],
    );
    expect(dbRow.rows[0].expired_at).not.toBeNull();
    expect(dbRow.rows[0].valid_until).not.toBeNull();
  });

  test('re-parsing the rewritten fence sees forgotten=true + active=false', async () => {
    const id = await seedV51Fact({
      entity_slug: 'people/alice', source_markdown_slug: 'people/alice',
      row_num: 1, fact: 'F1',
    });
    seedFile('people/alice', `| 1 | F1 | fact | 1.0 | world | medium | 2026-01-01 |  | s |  |`);

    await forgetFactInFence(engine, id, { reason: 'test' });

    const body = readFileSync(join(brainDir, 'people/alice.md'), 'utf-8');
    const parsed = parseFactsFence(body);
    expect(parsed.facts[0]).toMatchObject({
      claim: 'F1',
      active: false,
      forgotten: true,
    });
  });

  test('default reason is "forgotten" when caller omits it', async () => {
    const id = await seedV51Fact({
      entity_slug: 'people/alice', source_markdown_slug: 'people/alice',
      row_num: 1, fact: 'F',
    });
    seedFile('people/alice', `| 1 | F | fact | 1.0 | world | medium | 2026-01-01 |  | s |  |`);

    const r = await forgetFactInFence(engine, id);
    expect(r.reason).toBe('forgotten');

    const body = readFileSync(join(brainDir, 'people/alice.md'), 'utf-8');
    expect(body).toContain('forgotten: forgotten');
  });

  test('preserves existing context cell (appends rather than overwriting)', async () => {
    const id = await seedV51Fact({
      entity_slug: 'people/alice', source_markdown_slug: 'people/alice',
      row_num: 1, fact: 'F',
    });
    seedFile(
      'people/alice',
      `| 1 | F | fact | 1.0 | world | medium | 2026-01-01 |  | s | important note |`,
    );

    await forgetFactInFence(engine, id, { reason: 'r' });

    const body = readFileSync(join(brainDir, 'people/alice.md'), 'utf-8');
    expect(body).toContain('important note');
    expect(body).toContain('forgotten: r');
  });
});

describe('forgetFactInFence — fallback paths', () => {
  test('legacy NULL-row_num fact falls back to DB-only expire', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await (engine as any).db.query(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability,
                          valid_from, source, confidence)
       VALUES ('default', 'people/alice', 'legacy', 'fact', 'world', 'medium',
               now(), 's', 1.0) RETURNING id`,
    );
    const id = r.rows[0].id;

    const result = await forgetFactInFence(engine, id);
    expect(result.ok).toBe(true);
    expect(result.path).toBe('legacy_db');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const after = await (engine as any).db.query(
      'SELECT expired_at FROM facts WHERE id = $1', [id],
    );
    expect(after.rows[0].expired_at).not.toBeNull();
  });

  test('missing local_path on source falls back to DB-only', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).db.query(`UPDATE sources SET local_path = NULL WHERE id = 'default'`);
    const id = await seedV51Fact({
      entity_slug: 'people/alice', source_markdown_slug: 'people/alice',
      row_num: 1, fact: 'F',
    });

    const result = await forgetFactInFence(engine, id);
    expect(result.ok).toBe(true);
    expect(result.path).toBe('legacy_db');
  });

  test('missing entity page file falls back to DB-only (file deleted out from under us)', async () => {
    const id = await seedV51Fact({
      entity_slug: 'people/ghost', source_markdown_slug: 'people/ghost',
      row_num: 1, fact: 'F',
    });
    // No file created — page exists in DB but not on disk.
    expect(existsSync(join(brainDir, 'people/ghost.md'))).toBe(false);

    const result = await forgetFactInFence(engine, id);
    expect(result.ok).toBe(true);
    expect(result.path).toBe('legacy_db');
  });

  test('row_num drift (DB has v51 cols but fence missing the row) falls back to DB-only', async () => {
    const id = await seedV51Fact({
      entity_slug: 'people/alice', source_markdown_slug: 'people/alice',
      row_num: 99, fact: 'F',  // row_num 99 in DB but only row 1 in fence
    });
    seedFile('people/alice', `| 1 | Different fact | fact | 1.0 | world | medium | 2026-01-01 |  | s |  |`);

    const result = await forgetFactInFence(engine, id);
    expect(result.ok).toBe(true);
    expect(result.path).toBe('legacy_db');
  });

  test('unknown id returns ok:false path:not_found', async () => {
    const result = await forgetFactInFence(engine, 999999);
    expect(result.ok).toBe(false);
    expect(result.path).toBe('not_found');
  });

  test('already-expired id returns ok:false path:already_expired', async () => {
    const id = await seedV51Fact({
      entity_slug: 'people/alice', source_markdown_slug: 'people/alice',
      row_num: 1, fact: 'F',
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).db.query(`UPDATE facts SET expired_at = now() WHERE id = $1`, [id]);

    const result = await forgetFactInFence(engine, id);
    expect(result.ok).toBe(false);
    expect(result.path).toBe('already_expired');
  });
});

afterAll(() => {
  try { if (brainDir) rmSync(brainDir, { recursive: true, force: true }); }
  catch { /* best-effort */ }
});
