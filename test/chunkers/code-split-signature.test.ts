import { describe, expect, test } from 'bun:test';
import { chunkCodeText } from '../../src/core/chunkers/code.ts';

describe('large function declaration preservation', () => {
  for (const decorated of [false, true]) {
    test(`multiline Python signature survives body splitting (decorated=${decorated})`, async () => {
      const prefix = '# Synthetic fixture; no captured application source.\n\n';
      const declaration = `${decorated ? '@cache_result\n' : ''}def assemble_fixture_context(\n    user_value,\n    *,\n    option_one=None,\n    option_two=False,\n):\n`;
      const statements = Array.from({ length: 160 }, (_, i) => `    fixture_value_${i} = transform_fixture(user_value, option_one, ${i})`);
      const source = prefix + declaration + statements.join('\n') + '\n    return fixture_value_159\n';
      const chunks = await chunkCodeText(source, 'synthetic/context.py');
      expect(chunks.length).toBeGreaterThan(1);
      const first = chunks[0]!;
      expect(first.text).toContain(declaration);
      expect(first.metadata.startLine).toBe(3);
      expect(first.metadata.symbolName).toBe('assemble_fixture_context');
      expect(first.metadata.symbolType).toBe('function');
      // Metadata must still identify the actual contiguous source range,
      // rather than prepending a signature to unrelated body coordinates.
      for (const chunk of chunks) {
        const { startLine, endLine } = chunk.metadata;
        expect(chunk.text.split('\n\n').slice(1).join('\n\n')).toBe(
          source.split('\n').slice(startLine! - 1, endLine).join('\n').trim(),
        );
      }
      for (const statement of statements) {
        expect(chunks.some(chunk => chunk.text.includes(statement.trim()))).toBe(true);
      }
    });
  }
});
