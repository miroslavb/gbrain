/**
 * Fork 2026-09-27 — facts a page-sourced backstop run must not extract again.
 *
 * Agents record an explicit fact (`remember`) and then describe the same
 * change on the page. The delta backstop sent that new prose to the
 * extractor, which returned 3-10 paraphrases, fragments and translations of
 * the explicit fact per write. Embedding dedup cannot catch them: fragments
 * of a long fact scored 0.48-0.81 cosine against their parent on the live
 * brain, the same range as genuinely different facts. The extractor itself
 * can judge coverage, so it receives the facts already recorded for the page
 * (and recent facts of entities the new text links to) and is told to extract
 * only what they do not state.
 *
 * Best effort: a lookup failure returns what was collected so far and never
 * blocks extraction.
 */
import type { BrainEngine, FactRow } from '../engine.ts';

export const KNOWN_FACTS_CAP = 40;
export const KNOWN_FACTS_CHARS = 8000;
export const KNOWN_FACT_CHARS = 400;
export const PAGE_FACTS_LIMIT = 30;
export const MENTIONED_FACTS_LIMIT = 10;
export const MENTIONED_SLUGS_CAP = 8;
export const MENTIONED_FACTS_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

const WIKILINK = /\[\[([a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._/-]*?)(?:\|[^\]]*)?\]\]/gi;
// `dir/slug` tokens in prose or backticks; a leading `/`, `.` or word char means a path or URL, not a slug.
const BARE_SLUG = /(?<![\w./:-])([a-z][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*[a-z0-9])(?![\w/])/g;

/** Page slugs the text links to (wikilinks first, then bare `dir/slug` tokens), deduplicated and capped. */
export function mentionedSlugs(text: string, exclude?: string): string[] {
  const out: string[] = [];
  const add = (raw: string) => {
    const slug = raw.toLowerCase().replace(/\.md$/, '');
    if (slug !== exclude && !out.includes(slug) && out.length < MENTIONED_SLUGS_CAP) out.push(slug);
  };
  for (const m of text.matchAll(WIKILINK)) add(m[1]);
  for (const m of text.matchAll(BARE_SLUG)) add(m[1]);
  return out;
}

/**
 * Active facts already recorded for `pageSlug` plus facts from the last week
 * on entities the new text links to, newest first, as trimmed one-line
 * strings within KNOWN_FACTS_CAP / KNOWN_FACTS_CHARS.
 */
export async function knownFactsForPage(
  engine: BrainEngine,
  sourceId: string,
  pageSlug: string,
  text: string,
  now: Date = new Date(),
): Promise<string[]> {
  const rows: FactRow[] = [];
  const seen = new Set<number>();
  const take = (list: FactRow[]) => {
    for (const r of list) if (!seen.has(r.id)) { seen.add(r.id); rows.push(r); }
  };
  try {
    take(await engine.listFactsByEntity(sourceId, pageSlug, { limit: PAGE_FACTS_LIMIT }));
    const cutoff = now.getTime() - MENTIONED_FACTS_MAX_AGE_MS;
    for (const slug of mentionedSlugs(text, pageSlug)) {
      const recent = await engine.listFactsByEntity(sourceId, slug, { limit: MENTIONED_FACTS_LIMIT });
      take(recent.filter((r) => new Date(r.created_at).getTime() >= cutoff));
    }
  } catch (err) {
    console.warn(`[facts] known-facts lookup failed for ${pageSlug}: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Newest first across all entities: the explicit fact written just before this page edit must survive the budget.
  rows.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  const out: string[] = [];
  let chars = 0;
  for (const r of rows) {
    const line = r.fact.replace(/\s+/g, ' ').trim().slice(0, KNOWN_FACT_CHARS);
    if (!line) continue;
    if (out.length >= KNOWN_FACTS_CAP || chars + line.length > KNOWN_FACTS_CHARS) break;
    out.push(line);
    chars += line.length;
  }
  return out;
}
