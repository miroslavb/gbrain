import { describe, test, expect } from 'bun:test';
import { sanitizeRemoteBody } from '../src/core/remote-body.ts';
import { compileCanonicalProjections } from '../src/core/persistence/canonical-projections.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
import { parseFactsFence, renderFactsTable, stripFactsFence, FACTS_FENCE_BEGIN, FACTS_FENCE_END } from '../src/core/facts-fence.ts';

const row = { rowNum: 1, claim: 'Real canonical fact', kind: 'fact' as const, confidence: 1, visibility: 'world' as const, notability: 'medium' as const, active: true };

describe('facts fences distinguish literal transcript syntax from block markers', () => {
  test('a quoted inline end marker is ordinary historical text', () => {
    const body = '# Original transcript\n\n**Assistant**: the literal marker `' + FACTS_FENCE_END + '` was printed in this explanation.\n';
    expect(parseFactsFence(body)).toEqual({ facts: [], warnings: [] });
    expect(stripFactsFence(body)).toBe(body);
  });
  test('inline begin and end markers do not form a canonical table', () => {
    const body = `The syntax is \`${FACTS_FENCE_BEGIN}\`, then a table, then \`${FACTS_FENCE_END}\`.\n`;
    expect(parseFactsFence(body)).toEqual({ facts: [], warnings: [] });
    expect(stripFactsFence(body)).toBe(body);
  });
  test('literal markers preceding a real fence do not shadow it', () => {
    const prose = `Example: \`${FACTS_FENCE_BEGIN}\` and \`${FACTS_FENCE_END}\`.\n\n`;
    const body = prose + renderFactsTable([row]);
    const parsed = parseFactsFence(body);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.facts).toHaveLength(1);
    expect(parsed.facts[0].claim).toBe(row.claim);
    expect(stripFactsFence(body)).toContain(prose.trim());
  });
  test('indented standalone markers with CRLF remain canonical', () => {
    const body = renderFactsTable([row]).replace(FACTS_FENCE_BEGIN, '  ' + FACTS_FENCE_BEGIN + '  ').replace(FACTS_FENCE_END, '\t' + FACTS_FENCE_END).replaceAll('\n', '\r\n');
    const parsed = parseFactsFence(body);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.facts).toHaveLength(1);
  });
  for (const delimiter of ['```', '~~~~']) {
    test(`facts examples in ${delimiter} code blocks cannot shadow the real fence`, () => {
      const example = delimiter + 'markdown\n' + renderFactsTable([{ ...row, claim: 'FAKE_EXAMPLE' }]) + '\n' + delimiter + '\n';
      const real = renderFactsTable([row]);
      const body = example + '\n' + real;
      const parsed = parseFactsFence(body);
      expect(parsed.warnings).toEqual([]);
      expect(parsed.facts.map(f => f.claim)).toEqual([row.claim]);
      expect(stripFactsFence(body)).toContain('FAKE_EXAMPLE');
      expect(stripFactsFence(body)).not.toContain(row.claim);
      const projected = compileCanonicalProjections(parseMarkdown(body, 'notes/example.md'), 'notes/example', 'default');
      expect(projected.factRows).toHaveLength(1);
      expect(sanitizeRemoteBody(example)).toBe(example);
    });
  }
  test('remote body preserves inline facts examples byte for byte', () => {
    const body = `The syntax is \`${FACTS_FENCE_BEGIN}\`, then a table, then \`${FACTS_FENCE_END}\`.\n`;
    expect(sanitizeRemoteBody(body)).toBe(body);
  });
  test('an actual unbalanced block still fails closed', () => {
    expect(parseFactsFence('# Page\n\n' + FACTS_FENCE_BEGIN + '\n').warnings).toContain('FACTS_FENCE_UNBALANCED: missing begin or end marker');
    expect(parseFactsFence('# Page\n\n' + FACTS_FENCE_END + '\n').warnings).toContain('FACTS_FENCE_UNBALANCED: missing begin or end marker');
  });
});
