// A page that DOCUMENTS the takes-fence marker (e.g. the _brain-filing-rules skill)
// carries the marker text inline in backticks, not as a real block-level fence.
// The guard must not mistake that documentation mention for a broken fence and
// deadlock every write to the page. A real fence (markers alone on their lines)
// must still be detected, preserved on a takes-omitting round trip, and protected
// from mutation; a genuinely truncated real fence must still be refused.
import { describe, expect, test } from 'bun:test';
import { preserveProtectedTakes } from '../src/core/persistence/protected-takes.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from '../src/core/takes-fence.ts';

const realFence = `${TAKES_FENCE_BEGIN}\n| # | claim | kind | who | weight | since | source |\n|---|---|---|---|---|---|---|\n| 1 | CEO of Acme | fact | world | 1.0 | 2017-01 | src |\n${TAKES_FENCE_END}`;

describe('preserveProtectedTakes: documented marker vs real fence', () => {
  test('a stored page that only documents the marker in backticks does not throw and passes incoming through', () => {
    const stored = '# Filing rules\n\nWhen writing a `' + TAKES_FENCE_BEGIN + '` fence, the holder column says who.\n';
    const incoming = '# Filing rules\n\nWhen writing a takes fence (its begin/end markers), the holder column says who.\n';
    // Baseline throws here ("The takes fence must be repaired before replacing this page.").
    expect(preserveProtectedTakes(incoming, stored)).toBe(incoming);
  });

  test('an incoming page that only documents the marker is not treated as a fence mutation', () => {
    const stored = '# Filing rules\n\nplain body, no fence\n';
    const incoming = '# Filing rules\n\nWhen writing a `' + TAKES_FENCE_BEGIN + '` fence, do X.\n';
    expect(preserveProtectedTakes(incoming, stored)).toBe(incoming);
  });

  test('a real fence omitted by a remote round trip is re-appended (unchanged protection)', () => {
    const stored = `# Page\n\nbody\n\n${realFence}\n`;
    const incoming = '# Page\n\nbody (edited), takes omitted\n';
    const out = preserveProtectedTakes(incoming, stored);
    expect(out).toContain(TAKES_FENCE_BEGIN);
    expect(out).toContain('CEO of Acme');
    expect(out).toContain(TAKES_FENCE_END);
  });

  test('mutating a real fence in the incoming page is refused', () => {
    const stored = `# Page\n\n${realFence}\n`;
    const mutated = realFence.replace('CEO of Acme', 'CEO of Evil Corp');
    const incoming = `# Page\n\n${mutated}\n`;
    expect(() => preserveProtectedTakes(incoming, stored)).toThrow('scoped takes operations');
  });

  test('a genuinely truncated real fence (begin line, no end line) is still refused', () => {
    const stored = `# Page\n\n${TAKES_FENCE_BEGIN}\n| 1 | claim | fact | world | 1.0 | 2017-01 | src |\n`;
    const incoming = '# Page\n\nbody\n';
    expect(() => preserveProtectedTakes(incoming, stored)).toThrow('must be repaired');
  });
});
