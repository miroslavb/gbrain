// Fork contract: the memory fork's atom pipeline accepts only grounded atoms.
// Each atom's source_quote must be an exact, single, self-contained sentence of
// the source and the published body equals that quote. Upstream managed-atom
// fixtures emitted ungrounded bodies, so they embed these sentences in the
// source page and quote them verbatim.
export const GROUNDED_ATOM_SENTENCES = [
  'Use measured progress to guide the project.',
  'Use explicit ownership to guide the project.',
  'Measure progress against clear exit criteria.',
] as const;
export const GROUNDED_ATOM_EVIDENCE = ' ' + GROUNDED_ATOM_SENTENCES.join(' ');

type ChatOpts = import('../../src/core/ai/gateway.ts').ChatOpts;
type ChatResult = import('../../src/core/ai/gateway.ts').ChatResult;
const VALIDATOR_PROMPT_PREFIX = 'You are a fail-closed atom quality gate.';

/**
 * Fork contract: gateway-routed atom extraction also runs the fail-closed
 * semantic validator through the same chat transport. Wrap an extractor
 * fixture so validator requests receive all-pass verdicts without counting
 * as extractor (model) calls.
 */
export function withPassingAtomValidator(chat: (opts: ChatOpts) => Promise<ChatResult>): (opts: ChatOpts) => Promise<ChatResult> {
  return async (opts: ChatOpts) => {
    if (typeof opts.system === 'string' && opts.system.startsWith(VALIDATOR_PROMPT_PREFIX)) {
      const content = opts.messages?.[0]?.content;
      const candidates = (JSON.parse(typeof content === 'string' ? content : '{}') as { candidates?: unknown[] }).candidates ?? [];
      const scores = { source_support: 1, exactly_one_claim: 1, self_contained: 1,
        no_hidden_causation_or_overgeneralization: 1, no_sensitive_content: 1 };
      return { text: JSON.stringify({ verdicts: candidates.map((_, index) => ({ index, scores })) }), blocks: [], stopReason: 'end',
        usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'test:atom-validator', providerId: 'test' };
    }
    return chat(opts);
  };
}
