// Hard-wrapped Markdown pages: a model quotes a sentence that crosses a soft line
// break with a space (or keeps the break). The strict gate refused both — the
// spaced quote is not a substring, the kept break failed the single-sentence
// check — so every such page failed with "array had no atom-shaped elements".
// The gate now accepts the ONE source span that differs only in whitespace and
// stores the source's own text, so exact prompt provenance still holds.
import { describe, expect, test } from 'bun:test';
import { groundedQuoteSpan, parseAtomsOutcome } from '../src/core/cycle/extract-atoms-output.ts';

const WRAPPED = [
  '# Rendering notes',
  '',
  'One catch: the fence must start at column zero, otherwise indented',
  'fences inside lists stay plain code blocks by design.',
  '',
  '- first list item that is not part of the paragraph above',
  '- second list item',
  '',
  'Remote images are blocked with a visible placeholder unless the caller',
  'passes the allow-network flag explicitly.',
  '',
].join('\n').padEnd(700, ' filler.');

function reply(quote: string): string {
  return JSON.stringify({ atoms: [{ title: 'Fence column rule', atom_type: 'insight', body: quote, source_quote: quote,
    lesson: null, concepts: ['markdown-fences'], virality_score: 10, emotional_register: 'practical' }] });
}

describe('soft-wrapped source quotes', () => {
  const spaced = 'Remote images are blocked with a visible placeholder unless the caller passes the allow-network flag explicitly.';
  const exactSpan = 'Remote images are blocked with a visible placeholder unless the caller\npasses the allow-network flag explicitly.';

  test('a quote that writes the soft line break as a space is accepted as the exact source span', () => {
    const out = parseAtomsOutcome(reply(spaced), WRAPPED);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.atoms).toHaveLength(1);
    expect(out.atoms[0]!.source_quote).toBe(exactSpan);
    expect(out.atoms[0]!.body).toBe(exactSpan);
    expect(WRAPPED.indexOf(out.atoms[0]!.source_quote!)).toBeGreaterThanOrEqual(0);
  });

  test('a quote that keeps the soft line break verbatim is accepted', () => {
    const out = parseAtomsOutcome(reply(exactSpan), WRAPPED);
    expect(out.ok && out.atoms.map(a => a.source_quote)).toEqual([exactSpan]);
  });

  test('a span crossing a blank line or into a list item is refused', () => {
    expect(groundedQuoteSpan(WRAPPED, 'second list item Remote images are blocked')).toBeNull();
    expect(groundedQuoteSpan(WRAPPED, 'stay plain code blocks by design. - first list item that is not part of the paragraph above')).toBeNull();
    const crossing = parseAtomsOutcome(reply('fences inside lists stay plain code blocks by design. - first list item'), WRAPPED);
    expect(crossing).toEqual({ ok: false, reason: 'array had no atom-shaped elements' });
  });

  test('a whitespace-variant quote with two source matches is refused as ambiguous', () => {
    const twice = 'alpha beta\ngamma delta.\n\nalpha beta gamma\ndelta.\n';
    expect(groundedQuoteSpan(twice, 'alpha beta gamma delta.')).toBeNull();
  });

  test('a paraphrase is still refused', () => {
    const out = parseAtomsOutcome(reply('Remote images get a placeholder unless the caller allows network access.'), WRAPPED);
    expect(out).toEqual({ ok: false, reason: 'array had no atom-shaped elements' });
  });
});
