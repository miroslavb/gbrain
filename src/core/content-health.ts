/** Pure actionability classifier for doctor content inventories. */

export interface ContentHealthRow {
  slug: string;
  source_id: string;
  page_kind: string;
  chunk_count: number;
  missing_active_embeddings: number;
  embed_skip: boolean;
  content_flag_reason?: string | null;
  has_managed_facts_fence?: boolean;
}

export interface ContentHealthClassification {
  accepted: boolean;
  reason: string;
}

export function isRecognizedGeneratedContour(row: ContentHealthRow): boolean {
  if (row.page_kind === 'code') return true;
  const segments = row.slug.toLowerCase().split('/').filter(Boolean);
  return segments.some(segment =>
    segment === 'website' || segment === 'websites' || segment === 'generated' || segment === 'artifacts',
  );
}

function isFullyActiveEmbedded(row: ContentHealthRow): boolean {
  return row.chunk_count > 0 && row.missing_active_embeddings === 0;
}

export function classifyOversizedPage(row: ContentHealthRow): ContentHealthClassification {
  if (row.embed_skip) return { accepted: true, reason: 'acknowledged_embed_skip' };
  if (isRecognizedGeneratedContour(row) && isFullyActiveEmbedded(row)) {
    return { accepted: true, reason: 'generated_or_code_fully_embedded' };
  }
  return { accepted: false, reason: 'unacknowledged_oversized_page' };
}

export function classifyFlaggedPage(row: ContentHealthRow): ContentHealthClassification {
  if (/^docs\/inbox(?:\/|$)/i.test(row.slug)) {
    return { accepted: true, reason: 'raw_document_inbox' };
  }
  if (row.slug === 'projects/gbrain' && row.has_managed_facts_fence) {
    return { accepted: true, reason: 'managed_facts_page' };
  }
  if (row.content_flag_reason === 'oversized') {
    const oversized = classifyOversizedPage(row);
    if (oversized.accepted) return oversized;
  }
  if (isRecognizedGeneratedContour(row) && isFullyActiveEmbedded(row)) {
    return { accepted: true, reason: 'generated_or_code_fully_embedded' };
  }
  return { accepted: false, reason: 'unclassified_content_flag' };
}
