import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { Page } from '../types.ts';
import { loadSourceRow } from '../contextual-retrieval-service.ts';

export function readSummaryBody(page: Page): string {
  const compiled = page.compiled_truth ?? '';
  const timeline = page.timeline ?? '';
  if (!compiled) return timeline;
  if (!timeline) return compiled;
  return `${compiled}\n\n${timeline}`;
}

/**
 * Decide whether a no-match page is a likely parser gap or merely prose whose
 * coarse type happens to be conversation-adjacent (for example a skill under
 * `skills/email/` or narrative meeting notes). This stays deliberately broad:
 * any canonical conversation/session slug, transcript metadata, or repeated
 * speaker-shaped anchors remains retryable as a parser miss.
 */
export function expectsConversationTranscript(page: Page, body: string): boolean {
  const fm = page.frontmatter ?? {};
  if (typeof fm.raw_transcript === 'string' || typeof fm.source_session_path === 'string') return true;
  // Legacy session-ingest summaries preserve questions and synthesized
  // answers under these headings, but not speaker turns. Treating their
  // canonical sessions/* slug as transcript evidence leaves them retrying
  // forever and risks extracting assistant summaries as user facts.
  if (
    /^# Session\s+/m.test(body) && /^## Summary\s*$/m.test(body) &&
    /^## User Questions\s*$/m.test(body) && /^## Key Assistant Responses\s*$/m.test(body)
  ) return false;
  if (/^(?:conversations|sessions)\//.test(page.slug)) return true;
  const messageCount = Number(fm.message_count);
  if (Number.isFinite(messageCount) && messageCount >= 2) return true;
  if (
    typeof fm.session_id === 'string'
  ) return true;

  const anchorHint = /^(?:\*\*[^*\n]{1,80}\*\*\s*(?:\([^\n)]{1,40}\)|\d{1,2}:\d{2})?\s*:|#{2,3}\s+(?:user|assistant|human|system|tool)\b|Speaker\s+[A-Z0-9]+:|\[[^\]\n]{1,40}\]\s+[^:\n]{1,80}:)/i;
  let hints = 0;
  for (const line of body.split(/\r?\n/)) {
    if (anchorHint.test(line.trim()) && ++hints >= 2) return true;
  }
  return false;
}

function extractRawTranscriptPath(page: Page): string | null {
  const raw = page.frontmatter?.raw_transcript;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Resolve `rel` against `root`, rejecting any result that escapes the root
 * (`../`-style traversal in frontmatter is untrusted data — a page synced
 * from a mounted repo must not read arbitrary host files). Returns the
 * resolved absolute path, or null on escape.
 */
interface ResolvedTranscriptPath { path: string; root: string }

function resolveWithinRoot(root: string, rel: string): ResolvedTranscriptPath | null {
  const rootAbs = resolve(root);
  const candidate = resolve(rootAbs, rel);
  if (!(candidate === rootAbs || candidate.startsWith(rootAbs + sep))) return null;
  try {
    const rootReal = realpathSync(rootAbs);
    const candidateReal = existsSync(candidate)
      ? realpathSync(candidate)
      : resolve(realpathSync(dirname(candidate)), basename(candidate));
    if (candidateReal === rootReal || candidateReal.startsWith(rootReal + sep)) {
      return { path: candidateReal, root: rootReal };
    }
  } catch {
    // Missing/unresolvable root or parent, including broken symlinks: reject.
  }
  return null;
}

/**
 * #3911: a RELATIVE `raw_transcript` is repo-relative — but "the repo" is the
 * page's OWNING source, not the brain-global `sync.repo_path`. Multi-source
 * brains stored transcripts per source; resolving every page against the
 * global repo path silently read the wrong file (or nothing) for any page
 * outside that one repo. Resolution order:
 *
 *   1. absolute path — accepted only when it lands INSIDE a registered root
 *      (the owning source's `local_path`, else `sync.repo_path`). Frontmatter
 *      is untrusted data, so an absolute `/etc/passwd`-style path is rejected
 *      the same as `../` traversal (#3911 follow-up);
 *   2. page.source_id's source row `local_path` — escape-checked;
 *   3. `sync.repo_path` fallback (source row missing / no local_path) —
 *      also escape-checked.
 *
 * A RELATIVE path that ESCAPES its root is rejected outright (returns null →
 * caller falls back to the summary body); it does not retry lower tiers.
 * An ABSOLUTE path may sit in either root (containment, not resolution).
 */
async function resolveTranscriptPath(
  engine: BrainEngine,
  page: Page,
  rawTranscript: string,
): Promise<ResolvedTranscriptPath | null> {
  let sourceLocalPath: string | null = null;
  if (page.source_id) {
    try {
      sourceLocalPath = (await loadSourceRow(engine, page.source_id)).local_path;
    } catch {
      // Unknown source id / sources table unavailable — fall through to the
      // brain-global repo path, the pre-#3911 behavior.
    }
  }
  if (isAbsolute(rawTranscript)) {
    // resolveWithinRoot handles absolute candidates: resolve(root, abs) is
    // abs itself, so this is a pure containment check against each root.
    if (sourceLocalPath) {
      const contained = resolveWithinRoot(sourceLocalPath, rawTranscript);
      if (contained) return contained;
    }
    const repoPath = await engine.getConfig('sync.repo_path');
    if (repoPath) {
      const contained = resolveWithinRoot(repoPath, rawTranscript);
      if (contained) return contained;
    }
    return null; // outside every registered root — fail closed
  }
  if (sourceLocalPath) return resolveWithinRoot(sourceLocalPath, rawTranscript);
  const repoPath = await engine.getConfig('sync.repo_path');
  if (repoPath) return resolveWithinRoot(repoPath, rawTranscript);
  return null;
}

export interface ConversationBodySnapshot {
  body: string;
  /** Canonical confinement-checked candidate path; may not exist yet. */
  rawTranscriptPath: string | null;
  rawTranscriptRoot: string | null;
  byteLength: number;
  tooLarge: boolean;
}

export function readRawTranscriptPathSnapshot(
  path: string,
  maxBytes: number,
  root?: string,
): { body: string; byteLength: number; tooLarge: boolean } {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(fd);
    if (root) {
      const rootReal = realpathSync(root);
      const openedPath = realpathSync(path);
      const pathStat = statSync(openedPath);
      if (
        !(openedPath === rootReal || openedPath.startsWith(rootReal + sep)) ||
        pathStat.dev !== before.dev || pathStat.ino !== before.ino
      ) throw new Error('raw transcript escaped registered root during open');
    }
    if (before.size > maxBytes) return { body: '', byteLength: before.size, tooLarge: true };
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes - total + 1));
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      chunks.push(chunk.subarray(0, read));
      total += read;
      if (total > maxBytes) return { body: '', byteLength: total, tooLarge: true };
    }
    const after = fstatSync(fd);
    if (
      before.dev !== after.dev || before.ino !== after.ino ||
      before.size !== after.size || before.mtimeMs !== after.mtimeMs
    ) {
      throw new Error('raw transcript changed while reading');
    }
    return { body: Buffer.concat(chunks, total).toString('utf8').trim(), byteLength: total, tooLarge: false };
  } finally {
    closeSync(fd);
  }
}

export async function readConversationBodySnapshot(
  engine: BrainEngine,
  page: Page,
  opts: { maxBytes?: number } = {},
): Promise<ConversationBodySnapshot> {
  const maxBytes = typeof opts.maxBytes === 'number' && opts.maxBytes >= 0
    ? opts.maxBytes
    : Number.POSITIVE_INFINITY;
  const rawTranscript = extractRawTranscriptPath(page);
  if (rawTranscript) {
    const resolved = await resolveTranscriptPath(engine, page, rawTranscript);
    if (resolved && existsSync(resolved.path)) {
      try {
        const raw = readRawTranscriptPathSnapshot(resolved.path, maxBytes, resolved.root);
        if (raw.tooLarge) return { ...raw, rawTranscriptPath: resolved.path, rawTranscriptRoot: resolved.root };
        if (raw.body.length > 0) return { ...raw, rawTranscriptPath: resolved.path, rawTranscriptRoot: resolved.root };
      } catch {
        // Symlink swap, unstable read, or I/O failure: fail closed to summary.
      }
    }
    const body = readSummaryBody(page);
    return {
      body,
      rawTranscriptPath: resolved?.path ?? null,
      rawTranscriptRoot: resolved?.root ?? null,
      byteLength: Buffer.byteLength(body, 'utf8'),
      tooLarge: false,
    };
  }
  const body = readSummaryBody(page);
  return {
    body,
    rawTranscriptPath: null,
    rawTranscriptRoot: null,
    byteLength: Buffer.byteLength(body, 'utf8'),
    tooLarge: false,
  };
}

export async function readConversationBodyForParsing(
  engine: BrainEngine,
  page: Page,
): Promise<string> {
  return (await readConversationBodySnapshot(engine, page)).body;
}
