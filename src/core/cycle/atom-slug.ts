import { createHash } from 'crypto';
import { slugifySegment } from '../sync.ts';

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Keep the filesystem normalizer and remove a dash reintroduced by truncation. */
function atomSlugStem(title: string): string {
  return slugifySegment(title).slice(0, 60).replace(/-+$/g, '') || 'untitled';
}

/** Prefer a source-carried date so re-extraction stays deterministic. */
function sourceDate(ref: string): string {
  const base = ref.split('/').pop() ?? ref;
  const match = base.match(/(\d{4}-\d{2}-\d{2})/) ?? ref.match(/(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : todayDate();
}

/**
 * Build `atoms/<source-date>/<stem>-<title-hash>`. The source date keeps an
 * append-only transcript stable across runs; the title hash separates titles
 * that share the same truncated stem without tying identity to body wording.
 */
export function atomSlug(title: string, sourceRef: string): string {
  const hash = createHash('sha256').update(title).digest('hex').slice(0, 6);
  return `atoms/${sourceDate(sourceRef)}/${atomSlugStem(title)}-${hash}`;
}
