/** Deterministic sensitive-value detection and pre-LLM redaction for facts. */

export type ConversationFactSensitiveReason =
  | 'ip'
  | 'email'
  | 'phone'
  | 'credential'
  | 'private_path'
  | 'secret_url'
  | 'configured_pattern';

const REDACTION = '[sensitive value removed; do not extract this claim]';

const SENSITIVE_PATTERNS: ReadonlyArray<{
  reason: ConversationFactSensitiveReason;
  rx: RegExp;
}> = [
  { reason: 'ip', rx: /\b(?:\d{1,3}\.){3}\d{1,3}\b/ },
  { reason: 'email', rx: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i },
  { reason: 'phone', rx: /(?:\+\d{1,3}[ .-]?)?(?:\(\d{3}\)|\d{3})[ .-]\d{3}[ .-]\d{4}\b/ },
  {
    reason: 'credential',
    rx: /(?:\b(?:password|passwd|api[_ -]?key|secret|access[_ -]?token|bearer)\s*[:=]\s*\S+|\b(?:sk|pk)-(?:live|test)-[A-Za-z0-9_-]{12,}|\bAKIA[0-9A-Z]{16}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i,
  },
  {
    reason: 'private_path',
    rx: /(?:^|[\s`"'])(?:\/(?:home|root|Users)\/[^\s`"']+|~\/(?:\.ssh|\.aws|\.config|\.gnupg)(?:\/[^\s`"']*)?|[A-Z]:\\Users\\[^\s`"']+)/i,
  },
  {
    reason: 'secret_url',
    rx: /https?:\/\/(?:[^/\s:@]+:[^@\s/]+@|[^\s]*[?&](?:token|access_token|api[_-]?key|secret|password|passwd|pwd|signature|sig)=)/i,
  },
];

/** Return reason codes only. Never return the matched text. */
export function scanConversationFactSensitive(
  text: string,
  configuredPatterns: readonly string[],
): ConversationFactSensitiveReason[] {
  const reasons: ConversationFactSensitiveReason[] = [];
  for (const pattern of SENSITIVE_PATTERNS) {
    pattern.rx.lastIndex = 0;
    if (pattern.rx.test(text)) reasons.push(pattern.reason);
  }
  const lower = text.toLocaleLowerCase('en-US');
  if (configuredPatterns.some((pattern) => {
    const needle = pattern.trim().toLocaleLowerCase('en-US');
    return needle.length > 0 && lower.includes(needle);
  })) reasons.push('configured_pattern');
  return reasons;
}

function globalRegex(rx: RegExp): RegExp {
  return new RegExp(rx.source, rx.flags.includes('g') ? rx.flags : `${rx.flags}g`);
}

/**
 * Remove sensitive values before a conversation segment is sent to the facts
 * extractor. The post-LLM scanner remains mandatory and catches hallucinated
 * values; this layer prevents copying source secrets into candidates at all.
 */
export function redactConversationFactSensitive(
  text: string,
  configuredPatterns: readonly string[],
): string {
  let redacted = text;
  for (const { rx } of SENSITIVE_PATTERNS) redacted = redacted.replace(globalRegex(rx), REDACTION);
  for (const raw of configuredPatterns) {
    const needle = raw.trim();
    if (!needle) continue;
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    redacted = redacted.replace(new RegExp(escaped, 'gi'), REDACTION);
  }
  return redacted;
}
