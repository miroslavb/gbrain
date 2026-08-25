import { describe, expect, test } from 'bun:test';
import { classifyFlaggedPage, classifyOversizedPage } from '../src/core/content-health.ts';

const base = {
  slug: 'analysis/ordinary', source_id: 'default', page_kind: 'markdown',
  chunk_count: 2, missing_active_embeddings: 0, embed_skip: false,
};

describe('content health actionability', () => {
  test('oversized needs acknowledgement or a fully embedded generated/code contour', () => {
    expect(classifyOversizedPage(base).accepted).toBe(false);
    expect(classifyOversizedPage({ ...base, embed_skip: true }).reason).toBe('acknowledged_embed_skip');
    expect(classifyOversizedPage({ ...base, page_kind: 'code' }).accepted).toBe(true);
    expect(classifyOversizedPage({ ...base, page_kind: 'code', missing_active_embeddings: 1 }).accepted).toBe(false);
    expect(classifyOversizedPage({ ...base, page_kind: 'code', chunk_count: 0 }).accepted).toBe(false);
  });

  test('flag acceptance is narrow and never blanket-accepts ordinary markup', () => {
    expect(classifyFlaggedPage({ ...base, content_flag_reason: 'markup_heavy' }).accepted).toBe(false);
    expect(classifyFlaggedPage({ ...base, slug: 'docs/inbox/raw', content_flag_reason: 'markup_heavy' }).reason)
      .toBe('raw_document_inbox');
    expect(classifyFlaggedPage({ ...base, slug: 'projects/gbrain', has_managed_facts_fence: true }).reason)
      .toBe('managed_facts_page');
    expect(classifyFlaggedPage({ ...base, slug: 'projects/gbrain', has_managed_facts_fence: false }).accepted)
      .toBe(false);
  });
});
