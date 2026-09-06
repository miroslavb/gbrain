import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { extractPageLinks, type SlugResolver } from '../src/core/link-extraction.ts';
import { inferNerLinkType } from '../src/core/extract-ner.ts';
import { inferLinkTypeFromPack, parseSchemaPackManifest, parseYamlMini } from '../src/core/schema-pack/index.ts';

const resolver: SlugResolver = { resolve: async () => null };

for (const name of ['gbrain-base', 'gbrain-base-v2']) {
  const path = new URL(`../src/core/schema-pack/base/${name}.yaml`, import.meta.url);
  const pack = parseSchemaPackManifest(parseYamlMini(readFileSync(path, 'utf8')), { path: path.pathname });
  describe(`${name}: seeding needs financial evidence`, () => {
    for (const context of [
      'RU aliases seeded via frontmatter on projects/assistant, people/operator, projects/workflow.',
      'Fixture records were seeded before the migration tests.',
      'Random values were seeded for deterministic simulation.',
      'The garden was seeded in spring.',
    ]) {
      test(`nonfinancial seeding stays untyped: ${context}`, () => {
        expect(inferLinkTypeFromPack(pack, 'note', context)).toBeNull();
        expect(inferNerLinkType(pack, 'person', context)).toBeNull();
      });
    }

    test('real page extraction keeps all three alias references as mentions', async () => {
      const content = 'RU aliases seeded via frontmatter on projects/assistant, people/operator, projects/workflow.';
      const { candidates } = await extractPageLinks('analysis/audit-plan', content, {}, 'note', resolver, { pack, skipFrontmatter: true });
      expect(candidates.map(c => [c.targetSlug, c.linkType]).sort()).toEqual([
        ['people/operator', 'mentions'], ['projects/assistant', 'mentions'], ['projects/workflow', 'mentions'],
      ]);
    });

    for (const content of [
      'Alice invested in [Acme](companies/acme) during its seed round.',
      'Alice led the seed round for [Acme](companies/acme).',
      'Alice provided seed funding for [Acme](companies/acme).',
      'Alice made a seed investment in [Acme](companies/acme).',
      'Alice seeded [Acme](companies/acme) with $2M in seed capital.',
      'A frontmatter note records that Alice seeded [Acme](companies/acme) with seed capital.',
    ]) {
      test(`financial seed narrative remains invested_in: ${content}`, async () => {
        const { candidates } = await extractPageLinks('people/alice', content, {}, 'person', resolver, { pack, skipFrontmatter: true });
        expect(candidates).toHaveLength(1);
        expect(candidates[0].linkType).toBe('invested_in');
      });
    }

    test('NER pack matcher retains explicit seed funding and ordinary investment verbs', () => {
      for (const context of ['seed funding for Acme', 'seed-capital investment in Acme', 'invested in Acme', 'funded Acme', 'backed Acme', 'wrote a check to Acme']) {
        expect(inferLinkTypeFromPack(pack, 'person', context)).toBe('invested_in');
        expect(inferNerLinkType(pack, 'company', context)).toBe('invested_in');
      }
    });
  });
}
