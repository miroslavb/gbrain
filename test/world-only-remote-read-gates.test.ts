/**
 * Fork (world-only host): the v0.48.3 "trusted local only" read gates —
 * the pre-seal chunk withhold and the code-intel suspension — follow the private-page resolver instead of the
 * bare transport flag (stored contradiction reports keep upstream's
 * trusted-local-only rule). Under `facts.default_visibility=world` (the
 * migration v147 host posture) an agent caller reads exactly what the trusted
 * local CLI reads; with the posture cleared, upstream's fail-closed behaviour
 * is unchanged.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { FACTS_DEFAULT_VISIBILITY_KEY } from '../src/core/facts/visibility.ts';
import { operationsByName } from '../src/core/operations.ts';
import { readPolicyOpts } from '../src/core/ops/context.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { SAFE_FENCE_CHUNKER_VERSION } from '../src/core/search/safe-chunks.ts';

let engine: PGLiteEngine;

const SLUG = 'notes/legacy-index-page';

function mkCtx(remote: boolean, sourceId: string | undefined = 'default') {
  return {
    engine,
    config: { engine: 'pglite' },
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false,
    remote,
    sourceId,
  } as never;
}

async function setPosture(world: boolean): Promise<void> {
  __resetPrivateVisibilityCacheForTests();
  await engine.setConfig(FACTS_DEFAULT_VISIBILITY_KEY, world ? 'world' : '');
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  // Body-only words: the title arm must not rescue the page when chunks are withheld.
  await engine.putPage(SLUG, {
    title: 'Legacy Index Page',
    type: 'concept',
    compiled_truth: 'quokka wombat chunk body text',
    timeline: '',
    frontmatter: {},
  });
  await engine.upsertChunks(SLUG, [
    { chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: 'quokka wombat chunk body text' },
  ]);
  // Simulate an index built before the strict fence sanitizer shipped.
  await engine.executeRaw(
    'UPDATE pages SET chunker_version = $1 WHERE slug = $2',
    [SAFE_FENCE_CHUNKER_VERSION - 1, SLUG],
  );
});

afterAll(async () => {
  await setPosture(false);
  await engine.disconnect();
});

describe('world-only host read gates (fork)', () => {
  test('readPolicyOpts: the safe-chunk gate follows the private-page resolver', async () => {
    await setPosture(true);
    const world = await readPolicyOpts(mkCtx(true));
    expect(world.excludePrivate).toBe(false);
    expect(world.requireSafeChunks).toBe(false);

    await setPosture(false);
    const legacy = await readPolicyOpts(mkCtx(true));
    expect(legacy.excludePrivate).toBe(true);
    expect(legacy.requireSafeChunks).toBe(true);
    expect((await readPolicyOpts(mkCtx(false))).requireSafeChunks).toBe(false);
  });

  test('remote search serves pre-seal world chunks under the world posture and withholds them otherwise', async () => {
    const search = operationsByName.search!;
    await setPosture(true);
    const served = (await search.handler(mkCtx(true), { query: 'quokka wombat' })) as Array<{ slug: string }>;
    expect(served.some((r) => r.slug === SLUG)).toBe(true);

    await setPosture(false);
    const withheld = (await search.handler(mkCtx(true), { query: 'quokka wombat' })) as Array<{ slug: string }>;
    expect(withheld.some((r) => r.slug === SLUG)).toBe(false);
  });

  test('code_def: agent callers are served under the world posture and suspended otherwise', async () => {
    const codeDef = operationsByName.code_def!;
    await setPosture(true);
    const served = (await codeDef.handler(mkCtx(true), { symbol: 'noSuchSymbolExample' })) as { count: number };
    expect(served.count).toBe(0);

    await setPosture(false);
    await expect(codeDef.handler(mkCtx(true), { symbol: 'noSuchSymbolExample' })).rejects.toThrow(/temporarily unavailable/);
  });
});
