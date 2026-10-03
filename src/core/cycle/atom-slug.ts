import { createHash } from 'node:crypto';
import { slugifySegment } from '../sync.ts';

/**
 * Canonical slug stem for an atom title. Routes through slugifySegment (the
 * same normalizer the FS-import path uses) and RE-STRIPS a trailing dash after
 * the 60-char truncation — the cut can land on a hyphen and re-introduce one.
 * Two writers disagreeing on that trailing dash (`…would` vs `…would-`) was the
 * "trailing-dash twin" duplicate bug.
 */
function atomSlugStem(title: string): string {
  return slugifySegment(title).slice(0, 60).replace(/-+$/g, '') || 'untitled';
}

/**
 * Pull a YYYY-MM-DD date from a source reference — a transcript file path like
 * `…/2026-06-11-telegram.md`, or a dated page slug. Checks the basename first
 * to avoid matching a date in a parent directory. An undated source uses
 * `undatedDate` (C-14: the source page's creation date, or `undated`), never
 * the run date, so re-extraction on a later day upserts the same slugs.
 */
function sourceDate(ref: string, undatedDate: string): string {
  const base = ref.split('/').pop() ?? ref;
  const m = base.match(/(\d{4}-\d{2}-\d{2})/) ?? ref.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : undatedDate;
}

/**
 * Deterministic per-atom slug: `atoms/<source-date>/<stem>-<identity-hash>`.
 * - Date comes from the SOURCE, not the run date, so re-extracting an
 *   append-only transcript on a later day yields the SAME slug → putPage
 *   upserts instead of minting a cross-day duplicate.
 * - #4733: for PAGE-derived atoms the identity hash folds the source-page
 *   slug in with the title (8 chars, NUL-separated so `a`+`bc` can't equal
 *   `ab`+`c`), so two same-date source pages emitting the same atom title get
 *   DISTINCT slugs instead of aliasing one — pre-fix the second import
 *   silently overwrote the first atom's source binding. The source CONTENT
 *   hash is deliberately NOT folded in: an edited/reworded source page must
 *   re-resolve to the same slug and upsert rather than mint a duplicate atom
 *   set on every body edit (the reword-still-upserts property).
 * - Transcript atoms keep the legacy title-only 6-char hash (their locator is
 *   a file path, not page identity; changing their persisted slugs would
 *   re-mint every transcript atom on upgrade for no correctness gain).
 * - The hash suffix keeps two distinct atoms whose titles share the first 60
 *   chars on separate slugs, so a deterministic slug never silently clobbers
 *   a *different* atom.
 */
export function atomSlug(title: string, srcRef: string, sourcePageSlug?: string, undatedDate = 'undated'): string {
  const hash = sourcePageSlug !== undefined
    ? createHash('sha256').update(`${sourcePageSlug}\0${title}`).digest('hex').slice(0, 8)
    : createHash('sha256').update(title).digest('hex').slice(0, 6);
  return `atoms/${sourceDate(srcRef, undatedDate)}/${atomSlugStem(title)}-${hash}`;
}
