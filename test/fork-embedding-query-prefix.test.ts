/**
 * Fork patch 2026-09-27 — embedding_query_prefix: instruction-tuned embedders
 * (Giga-Embeddings) need an instruction on QUERY inputs only; documents and
 * per-column model overrides stay unprefixed; no config = previous behavior.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { configureGateway, resetGateway, embed, embedQuery, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';

const seen: string[] = [];
function capture() {
  seen.length = 0;
  __setEmbedTransportForTests((async ({ values }: { values: string[] }) => {
    seen.push(...values);
    return { embeddings: values.map(() => Array.from({ length: 1536 }, () => 0.1)) };
  }) as never);
}
const base = { embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'test' } };

afterEach(() => { __setEmbedTransportForTests(null as never); resetGateway(); });

describe('embedding_query_prefix', () => {
  const P = 'Instruct: Given a query, retrieve relevant passages\nQuery: ';

  test('query-side inputs get the prefix, documents do not', async () => {
    configureGateway({ ...base, embedding_query_prefix: P });
    capture();
    await embedQuery('где живёт Hopper');
    await embed(['document chunk text']);
    expect(seen).toEqual([P + 'где живёт Hopper', 'document chunk text']);
  });

  test('explicit inputType query through embed() is prefixed too', async () => {
    configureGateway({ ...base, embedding_query_prefix: P });
    capture();
    await embed(['probe'], { inputType: 'query' });
    expect(seen).toEqual([P + 'probe']);
  });

  test('a per-call model override different from the configured model stays unprefixed', async () => {
    configureGateway({ ...base, embedding_query_prefix: P });
    capture();
    await embed(['q'], { inputType: 'query', embeddingModel: 'openai:text-embedding-3-large' }).catch(() => {});
    expect(seen.every((v) => !v.startsWith('Instruct:'))).toBe(true);
  });

  test('no prefix configured keeps the previous behavior', async () => {
    configureGateway({ ...base });
    capture();
    await embedQuery('plain query');
    expect(seen).toEqual(['plain query']);
  });
});
