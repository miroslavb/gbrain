import { stripReasoningBlocks } from '../llm-json.ts';
import { normalizeForGrounding } from './synthesize-verify.ts';
import { ATOM_TYPES } from './extract-atoms-schema.ts';
export const MIN_PAGE_CHARS_FOR_EXTRACTION = 500;

export interface ExtractedAtom {
  title: string;
  atom_type: typeof ATOM_TYPES[number];
  body: string;
  source_quote?: string;
  lesson?: string;
  /**
   * 1-3 kebab-case topic labels for concept clustering. Consumed by
   * synthesize_concepts (groups atoms by `frontmatter.concepts`; only
   * labels shared by >=2 atoms materialize a concept page, so the prompt
   * biases reuse-over-coinage). #2123.
   */
  concepts?: string[];
  virality_score?: number;
  emotional_register?: string;
}

/** kebab-case validator for concept labels ("captive-portal", "channel-pricing"). */
const CONCEPT_LABEL_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_GROUNDED_BODY_CHARS = 280;
const COMPOUND_CLAIM_JOIN_RE = /(?:\b(?:and|but|while|whereas|therefore|so)\b|(?:^|[\s,])(?:и|но|а также|тогда как|поэтому)(?=$|[\s,]))/iu;
const DEICTIC_START_RE = /^(?:this|that|it|they|these|those|such)\b/i;
const RU_DEICTIC_OR_VAGUE_START_RE = /^(?:это|этот|эта|эти|он|она|оно|они|такой|такая|такие|значение|значения|параметр|параметры|данные)(?=$|[\s,:;.!?-])/iu;
// A title cannot repair an evidence quote whose grammatical subject is only
// meaningful inside the source page. Production sampling found that the
// semantic validator still accepted bare subjects such as "Buttons ...",
// "Dark theme ...", and a post-comma "the system ...". Keep this fence
// precision-biased: named subjects before these nouns do not match.
const CONTEXTLESS_GENERIC_SUBJECT_RE =
  /(?:^|[,\u2013\u2014]\s+)(?:(?:the|a|an)\s+)?(?:system|site|website|app|application|model|workflow|pipeline|configuration|config|process|phase|buttons?|themes?|endpoints?|hover\s+states?|override|values?|data|operations?|ops|ratios?)\b/iu;
const CONTEXTLESS_MODIFIED_GENERIC_SUBJECT_RE =
  /^(?:(?:current|existing|default|dark|light|different|several|multiple)\s+)(?:buttons?|themes?|operations?|ops|ratios?)\b|^(?:four|\d+)\s+[a-z0-9-]+\s+(?:operations?|ops)\b|^different\s+feed\/kill\s+ratios?\b/iu;
const RU_CONTEXTLESS_GENERIC_SUBJECT_RE =
  /(?:^|[,\u2013\u2014]\s+)(?:(?:эта|этот|эти)\s+)?(?:система|сайт|приложение|проект|репозиторий|сервис|платформа|модель|процесс|этап|кнопки?|тема|эндпоинт|воркфлоу|пайплайн)(?=$|[\s,:;.!?-])/iu;
const INLINE_ENUMERATION_RE = /(?:\s\/\s|\([^)]*(?:,|\/|\b(?:including|included|incl\.?)\b|(?:включая|в\s+т\.?\s*ч\.?)(?=$|[\s,]))[^)]*\))/iu;

function isSingleAtomicSentence(value: string, maxChars: number): boolean {
  const text = value.trim();
  if (!text || text.length > maxChars) return false;
  if (/[\n\r;]/.test(text) || /^[-*]\s/m.test(text)) return false;
  const boundaries = text.match(/[.!?](?=\s|$)/g) ?? [];
  return boundaries.length <= 1;
}

function isSelfContainedAtomicEvidence(value: string): boolean {
  const text = value.trim();
  return !COMPOUND_CLAIM_JOIN_RE.test(text)
    && !DEICTIC_START_RE.test(text)
    && !RU_DEICTIC_OR_VAGUE_START_RE.test(text)
    && !CONTEXTLESS_GENERIC_SUBJECT_RE.test(text)
    && !CONTEXTLESS_MODIFIED_GENERIC_SUBJECT_RE.test(text)
    && !RU_CONTEXTLESS_GENERIC_SUBJECT_RE.test(text)
    && !INLINE_ENUMERATION_RE.test(text);
}

export function locateQuote(
  content: string,
  quote: string,
): { start: number; end: number } | null {
  if (!quote || !content) return null;
  const c = normalizeForGrounding(content);
  const q = normalizeForGrounding(quote);
  if (!q.norm) return null;

  // Enumerate every folded hit, keep those that survive the round-trip
  // boundary check, THEN judge ambiguity. Order matters: rejecting on raw
  // hit-count first would let an INVALID partial-character match veto a
  // genuinely unique valid one ("No. First. No… not ever" has two folded
  // hits for "no." but only the first is character-aligned).
  const valid: Array<{ start: number; end: number }> = [];
  const MAX_CANDIDATES = 8; // pathological input shouldn't scan a whole book
  let at = c.norm.indexOf(q.norm);
  let seen = 0;
  while (at !== -1 && seen < MAX_CANDIDATES) {
    seen++;
    const start = c.map[at]!;
    // map[] names the FIRST code unit of the original character; advance the
    // end by the whole code point, not +1 — a bare +1 splits the surrogate
    // pair when the quote ends with a non-BMP char ('ship it 🚀'), and the
    // half-pair slice then fails the round-trip re-fold below.
    const lastOrig = c.map[at + q.norm.length - 1]!;
    const lastCp = content.codePointAt(lastOrig);
    const end = lastOrig + (lastCp !== undefined && lastCp > 0xffff ? 2 : 1);
    if (
      normalizeForGrounding(content.slice(start, end)).norm === q.norm &&
      !valid.some(v => v.start === start && v.end === end)
    ) {
      valid.push({ start, end });
    }
    // Step by one, not by length: overlapping hits are distinct passages
    // for ambiguity purposes.
    at = c.norm.indexOf(q.norm, at + 1);
  }
  // Cap exhausted with hits still pending: uniqueness UNPROVEN → fail closed.
  if (at !== -1) return null;
  // Exactly one surviving passage, or we cannot say which the atom used.
  if (valid.length !== 1) return null;
  return valid[0]!;
}

/**
 * gbrain#4148 — typed parse outcome. Malformed model output and a legitimate
 * zero-yield extraction both used to collapse into `[]`, so malformed output
 * was tombstoned as success (the page never retried, its atoms silently
 * lost). `ok: false` means the response was not parseable as an atoms array
 * AT ALL — a content-deterministic failure class the caller counts toward a
 * bounded tombstone; `ok: true, atoms: []` means the model genuinely
 * extracted nothing.
 */
export type AtomsParseOutcome =
  | { ok: true; atoms: ExtractedAtom[] }
  | { ok: false; reason: string };

export function parseAtomsOutcome(raw: string, sourceText?: string): AtomsParseOutcome {
  const direct = parseAtomsOutcomeInner(raw, sourceText);
  if (direct.ok) return direct;
  // Same reasoning-block hazard as the facts extractor: `indexOf('[')` below
  // finds a bracket inside <think> when the model drafts its array while
  // reasoning, so the parse fails and the page is halted. Ladder, not a
  // pre-filter: raw first, stripped only on failure — and the ORIGINAL
  // outcome is returned when the retry also fails, so error reasons are
  // unchanged for non-reasoning models.
  const stripped = stripReasoningBlocks(raw);
  if (stripped && stripped !== raw.trim()) {
    const retry = parseAtomsOutcomeInner(stripped, sourceText);
    if (retry.ok) return retry;
  }
  return direct;
}

const MAX_ARRAY_ANCHOR_CANDIDATES = 64;

/** Index of the `]` that closes the array opening at text[0], skipping brackets inside JSON strings; null if unbalanced. */
function balancedArrayEnd(text: string): number | null {
  let depth = 0, inString = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '[' || ch === '{') depth++;
    else if ((ch === ']' || ch === '}') && --depth === 0) return ch === ']' ? i : null;
  }
  return null;
}

/**
 * Parse the JSON array anchored at ONE `[` offset, reproducing the historical
 * two-step exactly: whole-slice parse, then a trim-back to the last `]` to
 * recover from trailing prose. Split out of parseAtomsOutcomeInner so the
 * anchor scan can try successive offsets without duplicating the reason
 * strings — those are asserted by tests and ride the drain's `last_error`.
 */
function parseArrayAtOffset(
  cleaned: string,
  start: number,
): { ok: true; parsed: unknown[] } | { ok: false; reason: string } {
  const slice = cleaned.slice(start);
  let parsed: unknown;
  try {
    parsed = JSON.parse(slice);
  } catch {
    // Recover from trailing prose: first the bracket-balanced array (prose that
    // itself holds `]`, e.g. a `[Source: …]` note, defeated the last-`]` trim),
    // then the historical trim back to the last `]`.
    const balancedEnd = balancedArrayEnd(slice);
    const arrayEnd = slice.lastIndexOf(']');
    if (arrayEnd === -1) return { ok: false, reason: 'unterminated JSON array' };
    let recovered = false;
    for (const end of balancedEnd === null ? [arrayEnd] : [balancedEnd, arrayEnd]) {
      try { parsed = JSON.parse(slice.slice(0, end + 1)); recovered = true; break; } catch { /* next candidate */ }
    }
    if (!recovered) return { ok: false, reason: 'unparseable JSON array' };
  }
  if (!Array.isArray(parsed)) return { ok: false, reason: 'JSON value is not an array' };
  return { ok: true, parsed };
}

function parseAtomsOutcomeInner(raw: string, sourceText?: string): AtomsParseOutcome {
  // Strip markdown code fences if the LLM wrapped JSON in them.
  let cleaned = raw.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();

  const firstStart = cleaned.indexOf('[');
  if (firstStart === -1) return { ok: false, reason: 'no JSON array in response' };

  // ANCHOR SCAN. Pre-fix this committed to `indexOf('[')` — the FIRST bracket
  // anywhere in the response. Any bracket in a preamble hijacked the anchor,
  // and a brain whose house style mandates inline `[Source: …]` citations and
  // `[[wikilink]]` backlinks (or whose transcripts carry `[user]` / `[tool: …]`
  // role markers) makes the model echo one while narrating, so a response
  // carrying a perfectly good array was reported `unparseable JSON array`.
  //
  // Acceptance requires the candidate to parse AND to yield >= 1 atom-shaped
  // element (`atomsFromParsedArray` is the single source of truth for
  // "atom-shaped"). Parseability alone is NOT enough: a zero-yield result is
  // exactly what TOMBSTONES an item (#2144), so only ONE parseable shape may
  // produce it — the literal `[]` the #4948 prompt asks for when nothing is
  // extractable, accepted at ANY offset (a model that echoes a `[Source: …]`
  // citation before obeying must not lose its honest `[]` to this gate and
  // burn three strikes into a tombstone + halt). A NON-empty array whose
  // elements all fail the shape gate is malformed output: it rides the
  // failure streak like every other parse failure instead of tombstoning the
  // item forever on the first try.
  let firstAttempt: ReturnType<typeof parseArrayAtOffset> | null = null;
  let sawEmptyArray = false;
  let candidates = 0;
  for (
    let start = firstStart;
    start !== -1 && candidates < MAX_ARRAY_ANCHOR_CANDIDATES;
    start = cleaned.indexOf('[', start + 1)
  ) {
    candidates++;
    const attempt = parseArrayAtOffset(cleaned, start);
    // Captured on the FIRST iteration only — every reason string this function
    // can return still describes the first bracket, unchanged.
    if (firstAttempt === null) firstAttempt = attempt;
    if (attempt.ok) {
      if (attempt.parsed.length === 0) { sawEmptyArray = true; continue; }
      const atoms = atomsFromParsedArray(attempt.parsed, sourceText);
      if (atoms.length > 0) return { ok: true, atoms };
    }
  }

  // Nothing yielded a real atom. An honest `[]` anywhere is the zero-yield
  // success (#4148 keeps "found nothing" distinct from "malformed"); otherwise
  // fall back to the FIRST offset's outcome — never a later one — so the
  // failure reason the drain surfaces as `last_error` still describes the
  // first bracket.
  if (sawEmptyArray) return { ok: true, atoms: [] };
  if (firstAttempt === null) return { ok: false, reason: 'no JSON array in response' };
  if (firstAttempt.ok) return { ok: false, reason: 'array had no atom-shaped elements' };
  return firstAttempt;
}

/**
 * Back-compat wrapper: parse the response into ExtractedAtom[], returning []
 * for BOTH malformed output and a legitimate zero-yield (legacy callers/tests
 * that don't need the typed distinction — new code uses parseAtomsOutcome).
 */
export function parseAtomsResponse(raw: string, sourceText?: string): ExtractedAtom[] {
  const outcome = parseAtomsOutcome(raw, sourceText);
  return outcome.ok ? outcome.atoms : [];
}

const SOFT_WRAP_BLOCK_START_RE = /^\s*(?:[-*+]\s|\d+[.)]\s|#|\||>|```)/;

/**
 * The exact source span a model quote denotes. A verbatim quote is its own span.
 * Otherwise accept the ONE source span that differs from the quote only in
 * whitespace: models quote a hard-wrapped Markdown paragraph with a space where
 * the source has a line break, and the strict substring check rejected every
 * such quote. Returning the source's own text keeps the downstream exact-offset
 * provenance (`promptContent.indexOf(source_quote)`) intact. A span that crosses
 * a blank line or starts a list item, heading, table row, blockquote or fence is
 * not one wrapped sentence and is refused, as is an ambiguous (repeated) match.
 */
export function groundedQuoteSpan(sourceText: string, quote: string): string | null {
  let span: string | null = sourceText.includes(quote) ? quote : null;
  if (span === null) {
    const tokens = quote.split(/\s+/).filter(Boolean);
    if (tokens.length < 2) return null;
    const re = new RegExp(tokens.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'g');
    let first: string | null = null;
    for (let m = re.exec(sourceText); m; m = re.exec(sourceText)) {
      if (first !== null) return null;
      first = m[0];
    }
    span = first;
  }
  if (span === null || !/[\r\n]/.test(span)) return span;
  const lines = span.split(/\r?\n/);
  if (lines.some(line => !line.trim())) return null;
  if (lines.slice(1).some(line => SOFT_WRAP_BLOCK_START_RE.test(line))) return null;
  return span;
}

function atomsFromParsedArray(parsed: unknown[], sourceText?: string): ExtractedAtom[] {

  const atoms: ExtractedAtom[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const obj = item as Record<string, unknown>;
    const title = typeof obj.title === 'string' ? obj.title.slice(0, 80) : null;
    const atomType = typeof obj.atom_type === 'string' ? obj.atom_type.trim().toLowerCase() : null;
    let body = typeof obj.body === 'string' ? obj.body.trim() : null;
    const sourceQuote = typeof obj.source_quote === 'string' ? obj.source_quote.trim() : null;
    if (!title || !atomType || !body) continue;
    if (!ATOM_TYPES.includes(atomType as typeof ATOM_TYPES[number])) continue;
    const requireGrounding = typeof sourceText === 'string'
      && sourceText.length >= MIN_PAGE_CHARS_FOR_EXTRACTION;
    let quote = sourceQuote;
    if (requireGrounding) {
      quote = sourceQuote ? groundedQuoteSpan(sourceText, sourceQuote) : null;
      if (!quote || quote.length > 200) continue;
      // Sentence shape is judged on the flattened text: a soft line break inside
      // a hard-wrapped paragraph is not a sentence or list boundary.
      const flat = quote.replace(/\s+/g, ' ');
      if (!isSingleAtomicSentence(body.replace(/\s+/g, ' '), MAX_GROUNDED_BODY_CHARS)) continue;
      if (!isSingleAtomicSentence(flat, 200)) continue;
      if (!isSelfContainedAtomicEvidence(flat)) continue;
      body = quote;
    }
    atoms.push({
      title,
      atom_type: atomType as typeof ATOM_TYPES[number],
      body,
      source_quote: quote ? quote.slice(0, 200) : undefined,
      lesson: requireGrounding ? undefined : (typeof obj.lesson === 'string' ? obj.lesson : undefined),
      concepts: (() => {
        if (!Array.isArray(obj.concepts)) return undefined;
        const labels = obj.concepts
          .filter((c): c is string => typeof c === 'string' && CONCEPT_LABEL_RE.test(c))
          .slice(0, 3);
        return labels.length > 0 ? labels : undefined;
      })(),
      virality_score:
        typeof obj.virality_score === 'number' &&
        obj.virality_score >= 0 &&
        obj.virality_score <= 100
          ? obj.virality_score
          : undefined,
      emotional_register:
        typeof obj.emotional_register === 'string' ? obj.emotional_register : undefined,
    });
  }
  return atoms;
}

