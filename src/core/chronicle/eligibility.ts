// v0.42.x — Life Chronicle (#2390) chronicle-extract eligibility.
// Mirrors src/core/facts/eligibility.ts. A page is chronicle-eligible (auto-
// emits timeline events) when it is conversation-shape, NOT dream-generated,
// and NOT a diary/event page. Diary interiority is NEVER mined into events
// (privacy/consent — plan D5.4); event pages are already the output (anti-loop).
import type { PageType } from '../types.ts';

export type ChronicleEligibility = { ok: true } | { ok: false; reason: string };

const ELIGIBLE_TYPES: PageType[] = ['meeting', 'conversation', 'calendar-event'];
// Directory rescue: a meetings/… page that frontmatter-typed itself 'note' is
// still conversation-shape. life/diary excluded explicitly below.
const RESCUE_SLUG_PREFIXES = ['meetings/', 'conversations/', 'cal/', 'calendar/'] as const;
const MIN_BODY_CHARS = 80;
// Live 24h audit (2026-08-21): every explicit-message-count conversation below
// 100 messages returned no_events (132/132 across the observed bands), while
// the only useful conversation had 809 messages. Missing metadata stays
// backward-compatible; meetings/calendar events are never subject to this gate.
export const MIN_CHRONICLE_CONVERSATION_MESSAGES = 100;

function parseMessageCount(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.floor(value);
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return parseInt(value.trim(), 10);
  return null;
}

export function isChronicleEligible(input: {
  type: PageType;
  slug: string;
  body?: string;
  dreamGenerated?: boolean;
  messageCount?: unknown;
}): ChronicleEligibility {
  const { type, slug } = input;
  if (input.dreamGenerated === true) return { ok: false, reason: 'dream_generated' };
  // Diary: never extract events from private interiority. Event: anti-loop.
  if (type === 'diary' || slug.startsWith('life/diary/')) return { ok: false, reason: 'diary_excluded' };
  if (type === 'event' || slug.startsWith('life/events/')) return { ok: false, reason: 'event_self' };
  if (slug.startsWith('wiki/agents/')) return { ok: false, reason: 'subagent_scratch' };
  const bodyOk = (input.body?.length ?? MIN_BODY_CHARS) >= MIN_BODY_CHARS;
  if (!bodyOk) return { ok: false, reason: 'too_short' };
  if (type === 'conversation') {
    const messageCount = parseMessageCount(input.messageCount);
    if (messageCount !== null && messageCount < MIN_CHRONICLE_CONVERSATION_MESSAGES) {
      return { ok: false, reason: 'short_conversation' };
    }
  }
  const typeOk = ELIGIBLE_TYPES.includes(type);
  const slugOk = RESCUE_SLUG_PREFIXES.some((p) => slug.startsWith(p));
  if (!typeOk && !slugOk) return { ok: false, reason: `kind:${type}` };
  return { ok: true };
}
