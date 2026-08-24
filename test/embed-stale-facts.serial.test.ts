/** Explicit NULL fact-vector catch-up: no extraction, resumable id checkpoint. */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { runEmbedCore } from '../src/commands/embed.ts';
import { backfillStaleFactEmbeddings } from '../src/core/embed-stale-facts.ts';
import { AITransientError } from '../src/core/ai/errors.ts';

const DIMS = 1536;
let engine: PGLiteEngine;

beforeAll(async () => {
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: DIMS,
    env: { ...process.env, OPENAI_API_KEY: 'sk-test-fake' },
  });
  __setEmbedTransportForTests(async ({ values }: { values: string[] }) => ({
    embeddings: values.map(() => new Array(DIMS).fill(0.001)),
    usage: { tokens: values.length * 4 },
  } as never));
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30_000);

afterAll(async () => {
  __setEmbedTransportForTests(null);
  resetGateway();
  await engine.disconnect();
});

beforeEach(async () => resetPgliteState(engine));

async function insertNullFact(text: string): Promise<number> {
  return (await engine.insertFact({
    fact: text,
    kind: 'fact',
    visibility: 'world',
    source: 'cli:test-null-vector',
  }, { source_id: 'default' })).id;
}

async function pending(): Promise<number> {
  const rows = await engine.executeRaw<{ n: number }>(
    'SELECT count(*)::int AS n FROM facts WHERE embedding IS NULL AND expired_at IS NULL',
  );
  return Number(rows[0]?.n ?? 0);
}

describe('explicit stale fact embedding lane', () => {
  test('plain --stale leaves facts alone; --facts heals them without extraction', async () => {
    await insertNullFact('Stored fact that needs a vector.');

    const plain = await runEmbedCore(engine, { stale: true });
    expect(plain.fact_embeddings).toBeUndefined();
    expect(await pending()).toBe(1);

    const healed = await runEmbedCore(engine, { stale: true, facts: true });
    expect(healed.fact_embeddings).toMatchObject({
      pending_before: 1, pending_after: 0, snapshot_remaining: 0,
      considered: 1, embedded: 1, skipped: 0, failures: 0,
    });
    expect(await pending()).toBe(0);
  });

  test('dry-run reports exact pending facts and performs no writes', async () => {
    await insertNullFact('First dry-run fact.');
    await insertNullFact('Second dry-run fact.');

    const result = await runEmbedCore(engine, { stale: true, facts: true, dryRun: true });

    expect(result.fact_embeddings).toMatchObject({
      pending_before: 2, pending_after: 2, snapshot_remaining: 2,
      considered: 0, embedded: 0, would_embed: 2, skipped: 0, failures: 0,
    });
    expect(await pending()).toBe(2);
  });

  test('physical-batch HTTP 500 isolates one bad fact and banks siblings', async () => {
    await insertNullFact('GOOD-A');
    await insertNullFact('BAD');
    await insertNullFact('GOOD-B');
    const calls: number[] = [];
    const overflow = () => new AITransientError(
      'input (4465 tokens) is too large to process. increase the physical batch size (current batch size: 4096)',
      { status: 500 },
    );

    const result = await backfillStaleFactEmbeddings(engine, {
      batchSize: 3,
      embedBatch: async (texts) => {
        calls.push(texts.length);
        if (texts.length > 1 || texts[0] === 'BAD') throw overflow();
        return [new Float32Array(DIMS).fill(0.001)];
      },
    });

    expect(calls).toEqual([3, 1, 1, 1]);
    expect(result).toMatchObject({ considered: 3, embedded: 2, failures: 1 });
    expect(await pending()).toBe(1);
  });

  test('fixed watermark never chases facts inserted after the run starts', async () => {
    await insertNullFact('snapshot-row');
    let insertedLate = false;
    const result = await backfillStaleFactEmbeddings(engine, {
      batchSize: 1,
      embedBatch: async () => {
        if (!insertedLate) {
          insertedLate = true;
          await insertNullFact('late-row');
        }
        return [new Float32Array(DIMS).fill(0.001)];
      },
    });

    expect(result).toMatchObject({
      pending_before: 1, considered: 1, embedded: 1,
      snapshot_remaining: 0, pending_after: 1, failures: 0,
    });
    expect(await pending()).toBe(1);
  });

  test('text CAS refuses to attach a stale vector after concurrent mutation', async () => {
    const id = await insertNullFact('old text');
    const result = await backfillStaleFactEmbeddings(engine, {
      embedBatch: async () => {
        await engine.executeRaw('UPDATE facts SET fact = $1 WHERE id = $2', ['new text', id]);
        return [new Float32Array(DIMS).fill(0.001)];
      },
    });

    expect(result).toMatchObject({
      pending_before: 1, considered: 1, embedded: 0, skipped: 1,
      snapshot_remaining: 1, pending_after: 1, failures: 1,
    });
    expect(await pending()).toBe(1);
  });

  test('provider outage opens after three batches and preserves the checkpoint', async () => {
    for (let i = 0; i < 4; i++) await insertNullFact(`outage-${i}`);

    const result = await backfillStaleFactEmbeddings(engine, {
      batchSize: 1,
      embedBatch: async () => {
        throw new AITransientError('Bad Gateway', { status: 502 });
      },
    });

    expect(result).toMatchObject({
      pending_before: 4, considered: 3, embedded: 0, failures: 3,
      provider_circuit_opened: true,
    });
    expect(await pending()).toBe(4);
  });
});
