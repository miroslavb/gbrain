/**
 * Fork patch 2026-09-27 — facts backstop extracts only NEW content.
 *
 * The page-write backstop used to send the whole compiled_truth to the LLM on
 * every write. A large living page (infra/host-map: ~420 KB, ~50 versions a
 * day) was re-extracted in full on each small edit; the extractor paraphrased
 * the same claims differently each time, the 0.95-cosine dedup let the
 * paraphrases through, and one claim ended up as dozens of active facts spread
 * over several entities (125 jobs / 596 inserts / 592 duplicates in 7 days).
 *
 * computeFactsDelta() compares the previous body with the new one at sentence
 * granularity (a single markdown bullet can hold a whole project history, so
 * line granularity is not enough) and returns only the sentences that did not
 * exist before, plus the header row of a table that gained rows (column names
 * give the new row its meaning). Section headings and the unchanged lead-in of
 * an edited line are NOT sent: the extractor treats every line it gets as
 * source text and turned them into facts of their own, duplicating what the
 * page already said; the job still carries the page slug and title.
 * Fact and takes fences are ignored on both sides: their rows are facts
 * already and re-extracting them can only produce duplicates.
 *
 * Pure function; no engine, no LLM.
 */
import type { BrainEngine } from '../engine.ts';
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END } from '../facts-fence.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from '../takes-fence.ts';

export interface FactsDelta {
  /** 'full' = extract the whole body; 'delta' = extract `text`; 'none' = nothing new. */
  mode: 'full' | 'delta' | 'none';
  /** Text to extract from ('' when mode is 'none'). */
  text: string;
  /** Sentence-level units in the new body / units that did not exist before. */
  totalUnits: number;
  newUnits: number;
}

/** Below this many characters of genuinely new text, the edit is treated as cosmetic. */
export const MIN_DELTA_CHARS = 30;
/** Above this share of new units the write is a rewrite: extract the full body. */
export const FULL_REWRITE_RATIO = 0.6;

function stripRegion(body: string, begin: string, end: string): string {
  let out = body;
  for (;;) {
    const b = out.indexOf(begin);
    if (b < 0) return out;
    const e = out.indexOf(end, b + begin.length);
    if (e < 0) return out.slice(0, b);
    out = out.slice(0, b) + out.slice(e + end.length);
  }
}

/** Remove fenced machine-owned regions (facts, takes) from a page body. */
export function stripFactsSourceFences(body: string): string {
  return stripRegion(stripRegion(body, FACTS_FENCE_BEGIN, FACTS_FENCE_END), TAKES_FENCE_BEGIN, TAKES_FENCE_END);
}

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** Table rows stay whole; prose splits after . ! ? ; followed by whitespace. */
export function splitUnits(line: string): string[] {
  const t = line.trim();
  if (!t) return [];
  if (t.startsWith('|')) return [t];
  return t.split(/(?<=[.!?;])\s+/).map((u) => u.trim()).filter(Boolean);
}

export function computeFactsDelta(previous: string | null | undefined, next: string): FactsDelta {
  const nextBody = stripFactsSourceFences(next ?? '');
  if (previous == null) {
    const units = nextBody.split('\n').flatMap(splitUnits).length;
    return { mode: 'full', text: next ?? '', totalUnits: units, newUnits: units };
  }
  const seen = new Set<string>();
  for (const line of stripFactsSourceFences(previous).split('\n')) {
    for (const u of splitUnits(line)) seen.add(norm(u));
  }

  const out: string[] = [];
  let tableHeader: string | null = null;
  let emittedTableHeader: string | null = null;
  let totalUnits = 0;
  let newUnits = 0;
  let newChars = 0;
  for (const raw of nextBody.split('\n')) {
    const line = raw.trim();
    if (!line) { tableHeader = null; continue; }
    if (line.startsWith('#')) { tableHeader = null; continue; }
    if (line.startsWith('|')) {
      if (tableHeader === null) { tableHeader = line; continue; }
      if (/^\|[\s:|-]+\|?$/.test(line)) continue; // separator row
    } else {
      tableHeader = null;
    }
    const units = splitUnits(line);
    totalUnits += units.length;
    const fresh = units.filter((u) => !seen.has(norm(u)));
    if (fresh.length === 0) continue;
    newUnits += fresh.length;
    newChars += fresh.reduce((n, u) => n + u.length, 0);
    if (line.startsWith('|') && tableHeader && tableHeader !== emittedTableHeader) {
      out.push(tableHeader); emittedTableHeader = tableHeader;
    }
    out.push(fresh.join(' '));
  }

  if (newUnits === 0 || newChars < MIN_DELTA_CHARS) {
    return { mode: 'none', text: '', totalUnits, newUnits };
  }
  if (totalUnits > 0 && newUnits / totalUnits > FULL_REWRITE_RATIO) {
    return { mode: 'full', text: next, totalUnits, newUnits };
  }
  return { mode: 'delta', text: out.join('\n').trim(), totalUnits, newUnits };
}

/**
 * Body of `slug` before a write, for delta extraction: null for a new page,
 * undefined when the read fails (the backstop then extracts the whole page).
 */
export async function readPriorBody(engine: BrainEngine, slug: string, sourceId: string): Promise<string | null | undefined> {
  try {
    const prior = await engine.getPage(slug, { sourceId });
    return prior ? (prior.compiled_truth ?? '') : null;
  } catch {
    return undefined;
  }
}

/**
 * Body the import that just ran snapshotted into page_versions (import-file
 * calls createVersion before updating an existing page): null when there is
 * no snapshot (new page), undefined when the read fails.
 */
export async function readLastSnapshotBody(engine: BrainEngine, slug: string, sourceId: string): Promise<string | null | undefined> {
  try {
    const rows = await engine.executeRaw<{ compiled_truth: string | null }>(
      `SELECT pv.compiled_truth FROM page_versions pv JOIN pages p ON p.id = pv.page_id
        WHERE p.slug = $1 AND p.source_id = $2 AND p.deleted_at IS NULL
        ORDER BY pv.snapshot_at DESC, pv.id DESC LIMIT 1`,
      [slug, sourceId],
    );
    return rows.length > 0 ? (rows[0].compiled_truth ?? '') : null;
  } catch {
    return undefined;
  }
}
