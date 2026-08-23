import { describe, expect, test } from 'bun:test';
import type { ExtractedFact } from '../src/core/facts/extract.ts';
import {
  DEFAULT_CONVERSATION_QUALITY_CONFIG,
  runConversationFactQualityGate,
  scanConversationFactSensitive,
  type ConversationFactExisting,
  type ConversationFactQualityReason,
  type ConversationFactSemanticValidator,
  type SemanticDecision,
} from '../src/core/facts/conversation-quality-gate.ts';

const candidate = (fact: string, overrides: Partial<ExtractedFact> = {}): ExtractedFact => ({
  fact,
  kind: 'fact',
  entity_slug: 'people/alice-example',
  source: 'cli:extract-conversation-facts',
  confidence: 1,
  notability: 'medium',
  embedding: null,
  ...overrides,
});

const validDecision = (id: string, overrides: Partial<SemanticDecision> = {}): SemanticDecision => ({
  id,
  action: 'accept',
  fully_supported: true,
  exactly_one_proposition: true,
  self_contained: true,
  correct_entity_attribution: true,
  no_hidden_causation: true,
  no_overgeneralization: true,
  no_sensitive_content: true,
  ...overrides,
});

const validator = (
  decisions: SemanticDecision[],
  metadata: { actualModel?: string; actualRoute?: string[] } = {},
): ConversationFactSemanticValidator => async () => ({
  payload: { decisions },
  actualModel: metadata.actualModel,
  actualRoute: metadata.actualRoute,
});

describe('conversation fact deterministic sensitive scanner', () => {
  test.each<[ConversationFactQualityReason, string]>([
    ['ip', 'The server is reachable at 10.24.8.9.'],
    ['email', 'Alice uses alice@example.test for work.'],
    ['phone', 'Alice can be reached at +1 (415) 555-0199.'],
    ['credential', 'The API key is sk-live-abcdefghijklmnopqrstuvwxyz.'],
    ['private_path', 'The backup lives at /home/alice/.ssh/id_ed25519.'],
    ['secret_url', 'Use https://example.test/join?token=super-secret-value.'],
    ['secret_url', 'Use https://user:supersecret@intranet.test/path.'],
  ])('rejects %s text before semantic validation', (reason, text) => {
    expect(scanConversationFactSensitive(text, [])).toContain(reason);
  });

  test('rejects operator-configured literal patterns without copying the text into the reason', () => {
    expect(scanConversationFactSensitive('Project ORCHID-CODE is active.', ['ORCHID-CODE']))
      .toEqual(['configured_pattern']);
  });
});

describe('conversation fact semantic quality gate', () => {
  test('rejects every current canary failure mode and counts reasons', async () => {
    const candidates = [
      candidate('Alice joined Acme and moved to Berlin.'),
      candidate('She prefers tea.'),
      candidate('Alice succeeded because Bob introduced her.'),
      candidate('Alice always prefers tea.'),
      candidate('Alice joined Acme.'),
    ];
    const result = await runConversationFactQualityGate({
      sourceText: 'direct source evidence',
      candidates,
      existingFacts: [],
      config: { ...DEFAULT_CONVERSATION_QUALITY_CONFIG, stopMaxRejectedRatio: 1 },
      semanticValidator: validator([
        validDecision('c0', { exactly_one_proposition: false }),
        validDecision('c1', { self_contained: false }),
        validDecision('c2', { no_hidden_causation: false }),
        validDecision('c3', { no_overgeneralization: false }),
        validDecision('c4', { fully_supported: false, correct_entity_attribution: false }),
      ]),
    });

    expect(result.accepted).toHaveLength(0);
    expect(result.receipt).toMatchObject({
      candidate_count: 5,
      accepted_count: 0,
      rejected_count: 5,
      split_count: 0,
      duplicate_count: 0,
      supersession_count: 0,
    });
    expect(result.receipt.reason_counts).toMatchObject({
      not_atomic: 1,
      not_self_contained: 1,
      hidden_causation: 1,
      overgeneralization: 1,
      unsupported: 1,
      wrong_entity_attribution: 1,
    });
  });

  test('splits only directly supported propositions and caps fanout', async () => {
    const split = (fact: string) => ({
      fact,
      entity_slug: 'people/alice-example',
      directly_supported: true,
      self_contained: true,
      correct_entity_attribution: true,
      no_hidden_causation: true,
      no_overgeneralization: true,
      no_sensitive_content: true,
    });
    const accepted = await runConversationFactQualityGate({
      sourceText: 'Alice joined Acme. Alice moved to Berlin.',
      candidates: [candidate('Alice joined Acme and moved to Berlin.')],
      existingFacts: [],
      config: { ...DEFAULT_CONVERSATION_QUALITY_CONFIG, maxSplitFanout: 2 },
      semanticValidator: validator([
        validDecision('c0', {
          action: 'split',
          exactly_one_proposition: false,
          propositions: [split('Alice joined Acme.'), split('Alice moved to Berlin.')],
        }),
      ]),
    });
    expect(accepted.accepted.map((entry) => entry.fact.fact)).toEqual([
      'Alice joined Acme.',
      'Alice moved to Berlin.',
    ]);
    expect(accepted.receipt).toMatchObject({ accepted_count: 2, split_count: 1 });

    const unsupported = await runConversationFactQualityGate({
      sourceText: 'Alice joined Acme.',
      candidates: [candidate('Alice joined Acme and moved to Berlin.')],
      existingFacts: [],
      config: { ...DEFAULT_CONVERSATION_QUALITY_CONFIG, maxSplitFanout: 2 },
      semanticValidator: validator([
        validDecision('c0', {
          action: 'split',
          exactly_one_proposition: false,
          propositions: [
            split('Alice joined Acme.'),
            { ...split('Alice moved to Berlin.'), directly_supported: false },
          ],
        }),
      ]),
    });
    expect(unsupported.accepted).toHaveLength(0);
    expect(unsupported.receipt.reason_counts.split_unsupported).toBe(1);

    const overCap = await runConversationFactQualityGate({
      sourceText: 'source',
      candidates: [candidate('Three claims.')],
      existingFacts: [],
      config: { ...DEFAULT_CONVERSATION_QUALITY_CONFIG, maxSplitFanout: 2 },
      semanticValidator: validator([
        validDecision('c0', {
          action: 'split',
          exactly_one_proposition: false,
          propositions: [split('One.'), split('Two.'), split('Three.')],
        }),
      ]),
    });
    expect(overCap.accepted).toHaveLength(0);
    expect(overCap.receipt.reason_counts.split_fanout_exceeded).toBe(1);
  });

  test('fails closed on route failure and invalid JSON while retaining actual route metadata', async () => {
    const routeFailure = await runConversationFactQualityGate({
      sourceText: 'source',
      candidates: [candidate('Alice joined Acme.')],
      existingFacts: [],
      config: DEFAULT_CONVERSATION_QUALITY_CONFIG,
      semanticValidator: async () => { throw new Error('gateway unavailable'); },
    });
    expect(routeFailure.accepted).toHaveLength(0);
    expect(routeFailure.receipt.reason_counts.semantic_route_failure).toBe(1);
    expect(routeFailure.receipt.stop_triggered).toBe(true);

    const invalidJson = await runConversationFactQualityGate({
      sourceText: 'source',
      candidates: [candidate('Alice joined Acme.')],
      existingFacts: [],
      config: DEFAULT_CONVERSATION_QUALITY_CONFIG,
      semanticValidator: async () => ({
        payload: 'not-json',
        actualModel: 'provider:model-that-answered',
        actualRoute: ['primary:model', 'provider:model-that-answered'],
      }),
    });
    expect(invalidJson.accepted).toHaveLength(0);
    expect(invalidJson.receipt.reason_counts.semantic_invalid_json).toBe(1);
    expect(invalidJson.receipt.actual_model).toBe('provider:model-that-answered');
    expect(invalidJson.receipt.actual_route).toEqual(['primary:model', 'provider:model-that-answered']);
  });

  test('classifies exact, typed-value, and near duplicates plus metric supersession', async () => {
    const existing: ConversationFactExisting[] = [
      { id: 1, fact: 'Alice joined Acme.', entity_slug: 'people/alice-example', source_markdown_slug: 'chat/a' },
      {
        id: 2,
        fact: 'Acme monthly recurring revenue is 50000 USD.',
        entity_slug: 'companies/acme',
        source_markdown_slug: 'chat/a',
        claim_metric: 'mrr', claim_value: 50000, claim_unit: 'USD', claim_period: 'monthly',
      },
      { id: 3, fact: 'Alice works remotely three days each week.', entity_slug: 'people/alice-example', source_markdown_slug: 'chat/a' },
    ];
    const candidates = [
      candidate('  alice JOINED acme  '),
      candidate('Acme MRR reached $50K.', {
        entity_slug: 'companies/acme', claim_metric: 'mrr', claim_value: 50000,
        claim_unit: 'USD', claim_period: 'monthly',
      }),
      candidate('Alice works remotely three days per week.'),
      candidate('Acme MRR reached $60K.', {
        entity_slug: 'companies/acme', claim_metric: 'mrr', claim_value: 60000,
        claim_unit: 'USD', claim_period: 'monthly',
      }),
    ];
    const result = await runConversationFactQualityGate({
      sourceText: 'source',
      candidates,
      existingFacts: existing,
      config: { ...DEFAULT_CONVERSATION_QUALITY_CONFIG, nearDuplicateThreshold: 0.7 },
      semanticValidator: validator(candidates.map((_, i) => validDecision(`c${i}`))),
    });
    expect(result.receipt.duplicate_count).toBe(3);
    expect(result.receipt.supersession_count).toBe(1);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].supersedes_id).toBe(2);
  });

  test('receipt contains counts and route only, never candidate or source text', async () => {
    const secretCanary = 'DO-NOT-LEAK-RAW-CANDIDATE';
    const result = await runConversationFactQualityGate({
      sourceText: `source ${secretCanary}`,
      candidates: [candidate('Alice joined Acme.')],
      existingFacts: [],
      config: DEFAULT_CONVERSATION_QUALITY_CONFIG,
      semanticValidator: validator([validDecision('c0')], {
        actualModel: 'shared:model',
        actualRoute: ['shared:model'],
      }),
    });
    const serialized = JSON.stringify(result.receipt);
    expect(serialized).not.toContain(secretCanary);
    expect(serialized).not.toContain('Alice joined Acme');
    expect(result.receipt).toMatchObject({
      candidate_count: 1,
      accepted_count: 1,
      actual_model: 'shared:model',
      actual_route: ['shared:model'],
    });
  });
});
