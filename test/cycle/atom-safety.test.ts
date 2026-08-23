import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import {
  AtomSemanticValidationError,
  createGatewayAtomSemanticValidator,
  parseConfiguredSensitivePatterns,
  scanAtomCandidate,
  type AtomSemanticBatchInput,
  type AtomSemanticBatchResult,
  type AtomSemanticValidator,
} from '../../src/core/cycle/atom-safety.ts';
import { runPhaseExtractAtoms } from '../../src/core/cycle/extract-atoms.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import type { ChatOpts, ChatResult } from '../../src/core/ai/gateway.ts';
import { BudgetExhausted } from '../../src/core/budget/budget-tracker.ts';

const PASS_SCORES = {
  source_support: 1,
  exactly_one_claim: 1,
  self_contained: 1,
  no_hidden_causation_or_overgeneralization: 1,
  no_sensitive_content: 1,
} as const;

const passAll: AtomSemanticValidator = async ({ candidates }: AtomSemanticBatchInput): Promise<AtomSemanticBatchResult> => ({
  verdicts: candidates.map((_, index) => ({ index, scores: { ...PASS_SCORES } })),
  actualModel: 'anthropic:validator-actual',
  route: 'anthropic',
});

function chatResult(text: string, model = 'openai:extractor-actual'): ChatResult {
  return {
    text,
    blocks: [],
    stopReason: 'end',
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    },
    model,
    providerId: model.split(':')[0] ?? 'unknown',
  };
}

function substantiveSource(...quotes: string[]): string {
  return `${'Background context without private material. '.repeat(16)}\n${quotes.join('\n')}`;
}

function atomJson(title: string, quote: string): string {
  return JSON.stringify([{
    title,
    atom_type: 'insight',
    body: quote,
    source_quote: quote,
  }]);
}

describe('atom deterministic sensitive scanner', () => {
  test('classifies every built-in sensitive category without returning matched values', () => {
    const cases = [
      ['ip_address', { title: 'Host 10.24.8.9 failed', body: 'safe', source_quote: 'safe' }],
      ['ip_address', { title: 'IPv6 host', body: 'Connect to 2001:db8:85a3::8a2e:370:7334.', source_quote: 'safe' }],
      ['email', { title: 'Owner', body: 'Contact ops@example.com.', source_quote: 'safe' }],
      ['phone', { title: 'Call support', body: '+1 (415) 555-2671', source_quote: 'safe' }],
      ['credential_or_token', { title: 'API setup', body: 'api_key=super-secret-value-123', source_quote: 'safe' }],
      ['private_path', { title: 'SSH key', body: '/home/alice/.ssh/id_ed25519', source_quote: 'safe' }],
      ['secret_url', { title: 'Callback', body: 'https://example.test/cb?token=super-secret-value', source_quote: 'safe' }],
    ] as const;

    for (const [reason, candidate] of cases) {
      const reasons = scanAtomCandidate(candidate, []);
      expect(reasons).toContain(reason);
      const serialized = JSON.stringify(reasons);
      for (const value of Object.values(candidate)) expect(serialized).not.toContain(value);
    }
  });

  test('applies bounded case-insensitive configured literal patterns across title, body, and quote', () => {
    const parsed = parseConfiguredSensitivePatterns(JSON.stringify(['PROJECT-CYPRESS', 'tenant/private']));
    expect(parsed.invalid).toBe(false);
    expect(scanAtomCandidate({
      title: 'Project-Cypress launch',
      body: 'safe',
      source_quote: 'safe',
    }, parsed.patterns)).toEqual(['configured_pattern']);
    expect(scanAtomCandidate({
      title: 'safe',
      body: 'safe',
      source_quote: 'The tenant/private mapping changed.',
    }, parsed.patterns)).toEqual(['configured_pattern']);
  });

  test('fails closed on malformed, oversized, or non-string configured patterns', () => {
    expect(parseConfiguredSensitivePatterns('{bad json').invalid).toBe(true);
    expect(parseConfiguredSensitivePatterns(JSON.stringify([42])).invalid).toBe(true);
    expect(parseConfiguredSensitivePatterns(JSON.stringify(['x'.repeat(257)])).invalid).toBe(true);
  });

  test('does not flag ordinary dates, versions, relative paths, or public URLs', () => {
    expect(scanAtomCandidate({
      title: 'Release 1.2.3 shipped on 2026-08-21',
      body: 'Read docs/guides/setup.md for the public release.',
      source_quote: 'The public page is https://example.test/docs?lang=en.',
    }, [])).toEqual([]);
  });
});

describe('gateway semantic validator seam', () => {
  test('sends one batched request and returns only strict indexed scores plus actual route', async () => {
    let seen: ChatOpts | null = null;
    const validator = createGatewayAtomSemanticValidator({
      model: 'anthropic:validator-requested',
      chat: async (opts) => {
        seen = opts;
        return chatResult(JSON.stringify({ verdicts: [
          { index: 0, scores: PASS_SCORES },
          { index: 1, scores: { ...PASS_SCORES, exactly_one_claim: 0 } },
        ] }), 'openai:validator-fallback');
      },
    });

    const result = await validator({
      sourceText: 'A source with two candidate claims.',
      candidates: [
        { title: 'A', body: 'Claim A.', source_quote: 'Claim A.' },
        { title: 'B', body: 'Claim B.', source_quote: 'Claim B.' },
      ],
    });

    expect((seen as ChatOpts | null)?.model).toBe('anthropic:validator-requested');
    expect((seen as (ChatOpts & { fallbackPolicy?: unknown }) | null)?.fallbackPolicy).toBeUndefined();
    expect(result.verdicts).toHaveLength(2);
    expect(result.verdicts[1].scores.exactly_one_claim).toBe(0);
    expect(result.actualModel).toBe('openai:validator-fallback');
    expect(result.route).toBe('openai');
  });

  test('invalid JSON and incomplete score sets fail closed', async () => {
    const malformed = createGatewayAtomSemanticValidator({
      model: 'anthropic:validator',
      chat: async () => chatResult('not-json'),
    });
    await expect(malformed({
      sourceText: 'source',
      candidates: [{ title: 'A', body: 'A.', source_quote: 'A.' }],
    })).rejects.toMatchObject({ code: 'invalid_json' });

    const incomplete = createGatewayAtomSemanticValidator({
      model: 'anthropic:validator',
      chat: async () => chatResult(JSON.stringify({ verdicts: [{
        index: 0,
        scores: { source_support: 1 },
      }] })),
    });
    await expect(incomplete({
      sourceText: 'source',
      candidates: [{ title: 'A', body: 'A.', source_quote: 'A.' }],
    })).rejects.toMatchObject({ code: 'invalid_json' });
  });

  test('preserves BudgetExhausted for the phase-level budget stop path', async () => {
    const exhausted = new BudgetExhausted('validator is unpriced', {
      reason: 'no_pricing', spent: 0, cap: 0.3, modelId: 'together:validator',
    });
    const validator = createGatewayAtomSemanticValidator({
      model: 'together:validator',
      chat: async () => { throw exhausted; },
    });
    await expect(validator({
      sourceText: 'source',
      candidates: [{ title: 'A', body: 'A.', source_quote: 'A.' }],
    })).rejects.toBe(exhausted);
  });
});

describe('extract_atoms pre-write safety and semantic gate', () => {
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

  test('deterministic rejection happens before semantic validation and emits counts only', async () => {
    const quote = 'Contact ops@example.com for deployment details.';
    const source = substantiveSource(quote);
    let semanticCalls = 0;
    const result = await runPhaseExtractAtoms(engine, {
      _transcripts: [{ filePath: '/input.md', content: source, contentHash: 'email-sensitive-hash' }],
      _pages: [],
      _chat: async () => chatResult(atomJson('Deployment contact', quote)),
      _semanticValidator: async (input) => {
        semanticCalls++;
        return passAll(input);
      },
    });

    expect(semanticCalls).toBe(0);
    expect(result.details?.candidates).toBe(1);
    expect(result.details?.accepted).toBe(0);
    expect(result.details?.rejected).toBe(1);
    expect(result.details?.rejected_by_reason).toEqual({ email: 1 });
    expect(JSON.stringify(result)).not.toContain('ops@example.com');
    const rows = await engine.executeRaw<{ n: number }>(`SELECT COUNT(*)::int AS n FROM pages WHERE type = 'atom'`);
    expect(rows[0].n).toBe(0);
    const receipts = await engine.executeRaw<{
      compiled_truth: string;
      frontmatter: Record<string, unknown>;
    }>(`SELECT compiled_truth, frontmatter FROM pages WHERE type = 'extract_receipt'`);
    expect(receipts).toHaveLength(1);
    expect(JSON.stringify(receipts[0])).not.toContain('ops@example.com');
    expect(receipts[0].frontmatter).toMatchObject({
      candidates: 1,
      accepted: 0,
      rejected_by_reason: { email: 1 },
    });
    await runPhaseExtractAtoms(engine, {
      _transcripts: [{ filePath: '/input-2.md', content: source, contentHash: 'email-sensitive-hash-2' }],
      _pages: [],
      _chat: async () => chatResult(atomJson('Deployment contact second run', quote)),
      _semanticValidator: async (input) => passAll(input),
    });
    const receiptSlugs = await engine.executeRaw<{ slug: string }>(
      `SELECT slug FROM pages WHERE type = 'extract_receipt' ORDER BY slug`,
    );
    expect(receiptSlugs).toHaveLength(2);
    expect(new Set(receiptSlugs.map((row) => row.slug)).size).toBe(2);
  });

  test('one semantic call scores the surviving batch and only all-pass candidates write exact quote bodies', async () => {
    const quoteA = 'The release gate blocks unknown usage.';
    const quoteB = 'The launch window closes at noon.';
    const source = substantiveSource(quoteA, quoteB);
    let batchSize = 0;
    const semantic: AtomSemanticValidator = async ({ candidates }) => {
      batchSize = candidates.length;
      return {
        verdicts: [
          { index: 0, scores: { ...PASS_SCORES } },
          { index: 1, scores: { ...PASS_SCORES, exactly_one_claim: 0 } },
        ],
        actualModel: 'openai:validator-fallback',
        route: 'openai',
      };
    };
    const result = await runPhaseExtractAtoms(engine, {
      _transcripts: [{ filePath: '/batch.md', content: source, contentHash: 'semantic-batch-hash' }],
      _pages: [],
      _chat: async () => chatResult(JSON.stringify([
        { title: 'Unknown usage is blocked', atom_type: 'insight', body: quoteA, source_quote: quoteA },
        { title: 'Launch closes at noon', atom_type: 'insight', body: quoteB, source_quote: quoteB },
      ])),
      _semanticValidator: semantic,
    });

    expect(batchSize).toBe(2);
    expect(result.details?.candidates).toBe(2);
    expect(result.details?.accepted).toBe(1);
    expect(result.details?.rejected).toBe(1);
    expect(result.details?.rejected_by_reason).toEqual({ semantic_atomicity: 1 });
    expect(result.details?.actual_models).toEqual({
      extraction: ['openai:extractor-actual'],
      semantic_validator: ['openai:validator-fallback'],
    });
    expect(result.details?.actual_routes).toEqual({
      extraction: ['openai'],
      semantic_validator: ['openai'],
    });

    const atoms = await engine.executeRaw<{ compiled_truth: string }>(
      `SELECT compiled_truth FROM pages WHERE type = 'atom' ORDER BY slug`,
    );
    expect(atoms).toEqual([{ compiled_truth: quoteA }]);

    const receipts = await engine.executeRaw<{ frontmatter: Record<string, unknown>; compiled_truth: string }>(
      `SELECT frontmatter, compiled_truth FROM pages WHERE type = 'extract_receipt'`,
    );
    expect(receipts).toHaveLength(1);
    expect(receipts[0].frontmatter.candidates).toBe(2);
    expect(receipts[0].frontmatter.accepted).toBe(1);
    expect(receipts[0].frontmatter.rejected_by_reason).toEqual({ semantic_atomicity: 1 });
    expect(receipts[0].frontmatter.model_id).toBe('openai:validator-fallback');
    expect(receipts[0].frontmatter.model_route).toBe('openai');
    expect(receipts[0].compiled_truth).not.toContain(quoteA);
    expect(receipts[0].compiled_truth).not.toContain(quoteB);
  });

  test('multilingual structural fence drops slash, parenthetical-list, and vague-fragment atoms', async () => {
    const quotes = [
      'sensitive_count / semantic_failures stops remain absolute.',
      'Deep tiers (dream.synthesize, think) intentionally remain on flagships.',
      'значения не логировать',
    ];
    let extractCall = 0;
    let semanticCalls = 0;
    const result = await runPhaseExtractAtoms(engine, {
      _transcripts: quotes.map((quote, index) => ({
        filePath: `/structural-${index}.md`,
        content: substantiveSource(quote),
        contentHash: `structural-fence-${index}`,
      })),
      _pages: [],
      _chat: async () => {
        const quote = quotes[extractCall++]!;
        return chatResult(atomJson(`Candidate ${extractCall}`, quote));
      },
      _semanticValidator: async (input) => {
        semanticCalls++;
        return passAll(input);
      },
    });

    expect(semanticCalls).toBe(0);
    expect(result.details?.candidates).toBe(0);
    expect(result.details?.accepted).toBe(0);
    const atoms = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pages WHERE type = 'atom'`,
    );
    expect(atoms[0].n).toBe(0);
  });

  test('validator invalid JSON fails closed for its batch without deleting atoms accepted earlier', async () => {
    const quoteA = 'The first supported claim remains stored.';
    const quoteB = 'The second supported claim awaits validation.';
    const sources = [substantiveSource(quoteA), substantiveSource(quoteB)];
    let extractCall = 0;
    let validateCall = 0;
    const result = await runPhaseExtractAtoms(engine, {
      _transcripts: sources.map((content, index) => ({
        filePath: `/batch-${index}.md`,
        content,
        contentHash: `semantic-failure-${index}`,
      })),
      _pages: [],
      _chat: async () => {
        const quote = extractCall++ === 0 ? quoteA : quoteB;
        return chatResult(atomJson(`Claim ${extractCall}`, quote));
      },
      _semanticValidator: async (input) => {
        validateCall++;
        if (validateCall === 2) throw new AtomSemanticValidationError('invalid_json');
        return passAll(input);
      },
    });

    expect(result.details?.candidates).toBe(2);
    expect(result.details?.accepted).toBe(1);
    expect(result.details?.rejected_by_reason).toEqual({ semantic_validator_invalid_json: 1 });
    const atoms = await engine.executeRaw<{ compiled_truth: string }>(
      `SELECT compiled_truth FROM pages WHERE type = 'atom'`,
    );
    expect(atoms).toEqual([{ compiled_truth: quoteA }]);
  });

  test('validator timeout fails closed with a reason count and no raw candidate text', async () => {
    const quote = 'The pending claim remains unwritten.';
    const result = await runPhaseExtractAtoms(engine, {
      _transcripts: [{ filePath: '/timeout.md', content: substantiveSource(quote), contentHash: 'timeout-hash' }],
      _pages: [],
      _chat: async () => chatResult(atomJson('Pending claim', quote)),
      _semanticValidator: async () => new Promise<AtomSemanticBatchResult>(() => {}),
      _semanticTimeoutMs: 5,
    });

    expect(result.details?.accepted).toBe(0);
    expect(result.details?.rejected_by_reason).toEqual({ semantic_validator_timeout: 1 });
    expect(JSON.stringify(result)).not.toContain(quote);
  });

  test('dry-run processes at most ten work items, validates them, and performs no writes', async () => {
    let extractionCalls = 0;
    let semanticCalls = 0;
    const result = await runPhaseExtractAtoms(engine, {
      dryRun: true,
      _transcripts: Array.from({ length: 12 }, (_, index) => ({
        filePath: `/dry-${index}.md`,
        content: `short source ${index}`,
        contentHash: `dry-hash-${index}`,
      })),
      _pages: [],
      _chat: async () => {
        extractionCalls++;
        return chatResult(JSON.stringify([{
          title: `Dry candidate ${extractionCalls}`,
          atom_type: 'insight',
          body: `Dry claim ${extractionCalls}.`,
        }]));
      },
      _semanticValidator: async (input) => {
        semanticCalls++;
        return passAll(input);
      },
    });

    expect(extractionCalls).toBe(10);
    expect(semanticCalls).toBe(10);
    expect(result.details?.dry_run_limit).toBe(10);
    expect(result.details?.dry_run_omitted_items).toBe(2);
    expect(result.details?.candidates).toBe(10);
    expect(result.details?.accepted).toBe(10);
    const rows = await engine.executeRaw<{ n: number }>(`SELECT COUNT(*)::int AS n FROM pages`);
    expect(rows[0].n).toBe(0);
  });
});
