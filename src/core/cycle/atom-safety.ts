import { isIP } from 'node:net';
import type { ChatOpts, ChatResult } from '../ai/gateway.ts';
import { BudgetExhausted } from '../budget/budget-tracker.ts';

export const ATOM_SAFETY_REASONS = [
  'ip_address',
  'email',
  'phone',
  'credential_or_token',
  'private_path',
  'secret_url',
  'configured_pattern',
] as const;

export type AtomSafetyReason = typeof ATOM_SAFETY_REASONS[number];

export interface AtomCandidateText {
  title: string;
  body: string;
  source_quote?: string;
}

export interface ConfiguredSensitivePatterns {
  patterns: string[];
  invalid: boolean;
}

const MAX_CONFIGURED_PATTERNS = 32;
const MAX_CONFIGURED_PATTERN_CHARS = 256;
const MAX_CONFIGURED_PATTERN_JSON_CHARS = 16_384;

/**
 * Parse case-insensitive literal sensitive patterns from the DB config plane.
 * Literal matching is intentional: arbitrary regular expressions can create a
 * ReDoS path over model output. Invalid configuration is surfaced to the
 * caller, which rejects every candidate fail-closed for that batch.
 */
export function parseConfiguredSensitivePatterns(raw: string | null | undefined): ConfiguredSensitivePatterns {
  if (raw === null || raw === undefined || raw.trim() === '') return { patterns: [], invalid: false };
  if (raw.length > MAX_CONFIGURED_PATTERN_JSON_CHARS) return { patterns: [], invalid: true };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length > MAX_CONFIGURED_PATTERNS) {
      return { patterns: [], invalid: true };
    }
    const patterns: string[] = [];
    for (const value of parsed) {
      if (
        typeof value !== 'string' ||
        value.length === 0 ||
        value.length > MAX_CONFIGURED_PATTERN_CHARS
      ) {
        return { patterns: [], invalid: true };
      }
      patterns.push(value.toLocaleLowerCase('en-US'));
    }
    return { patterns, invalid: false };
  } catch {
    return { patterns: [], invalid: true };
  }
}

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,63}\b/i;
const PHONE_RE = /(?:\+\d{1,3}[\s.-]*)?(?:\(\d{2,4}\)[\s.-]*|\d{2,4}[\s.-]+)\d{3}[\s.-]+\d{4}\b/;
const TOKEN_PREFIX_RE = /\b(?:sk-[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|AKIA[0-9A-Z]{16})\b/;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/;
const CREDENTIAL_ASSIGNMENT_RE = /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|pwd|secret|bearer)\b\s*(?:=|:|\bis\b)\s*["']?[A-Za-z0-9_./+=~-]{8,}/i;
const PRIVATE_KEY_RE = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;
const UNIX_PRIVATE_PATH_RE = /(?:^|[\s("'`])\/(?:home\/[^/\s]+|Users\/[^/\s]+|root|private|var\/(?:lib|log|run)\/[^/\s]+)(?:\/[^\s"'`)]+)*/;
const WINDOWS_PRIVATE_PATH_RE = /\b[A-Za-z]:\\Users\\[^\s"'()]+/;
const URL_RE = /https?:\/\/[^\s<>"']+/gi;
const SECRET_QUERY_KEYS = new Set([
  'access_token',
  'api_key',
  'apikey',
  'auth',
  'authorization',
  'client_secret',
  'key',
  'password',
  'passwd',
  'pwd',
  'secret',
  'signature',
  'sig',
  'token',
]);

function containsIpAddress(text: string): boolean {
  const ipv4Candidates = text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) ?? [];
  for (const candidate of ipv4Candidates) {
    if (candidate.split('.').every((part) => Number(part) <= 255)) return true;
  }
  const colonCandidates = text.match(/[0-9A-Fa-f:]{2,}/g) ?? [];
  return colonCandidates.some((candidate) => candidate.includes(':') && isIP(candidate) === 6);
}

function containsSecretUrl(text: string): boolean {
  URL_RE.lastIndex = 0;
  for (const match of text.matchAll(URL_RE)) {
    try {
      const parsed = new URL(match[0].replace(/[),.;!?]+$/g, ''));
      if (parsed.username || parsed.password) return true;
      for (const key of parsed.searchParams.keys()) {
        if (SECRET_QUERY_KEYS.has(key.toLocaleLowerCase('en-US'))) return true;
      }
    } catch {
      // A malformed URL is handled by the other deterministic detectors.
    }
  }
  return false;
}

/**
 * Scan only candidate title/body/source_quote and return stable reason codes.
 * No match offsets or values leave this function.
 */
export function scanAtomCandidate(
  candidate: AtomCandidateText,
  configuredPatterns: readonly string[],
): AtomSafetyReason[] {
  const text = [candidate.title, candidate.body, candidate.source_quote ?? ''].join('\n');
  const reasons = new Set<AtomSafetyReason>();
  if (containsIpAddress(text)) reasons.add('ip_address');
  if (EMAIL_RE.test(text)) reasons.add('email');
  if (PHONE_RE.test(text)) reasons.add('phone');
  if (
    TOKEN_PREFIX_RE.test(text) ||
    JWT_RE.test(text) ||
    CREDENTIAL_ASSIGNMENT_RE.test(text) ||
    PRIVATE_KEY_RE.test(text)
  ) reasons.add('credential_or_token');
  if (UNIX_PRIVATE_PATH_RE.test(text) || WINDOWS_PRIVATE_PATH_RE.test(text)) {
    reasons.add('private_path');
  }
  if (containsSecretUrl(text)) reasons.add('secret_url');
  const lower = text.toLocaleLowerCase('en-US');
  if (configuredPatterns.some((pattern) => lower.includes(pattern))) reasons.add('configured_pattern');
  return ATOM_SAFETY_REASONS.filter((reason) => reasons.has(reason));
}

export const ATOM_SEMANTIC_REASONS = [
  'semantic_source_support',
  'semantic_atomicity',
  'semantic_self_contained',
  'semantic_hidden_causation_or_overgeneralization',
  'semantic_sensitive_content',
] as const;

export type AtomSemanticReason = typeof ATOM_SEMANTIC_REASONS[number];

export interface AtomSemanticScores {
  source_support: 0 | 1;
  exactly_one_claim: 0 | 1;
  self_contained: 0 | 1;
  no_hidden_causation_or_overgeneralization: 0 | 1;
  no_sensitive_content: 0 | 1;
}

export interface AtomSemanticVerdict {
  index: number;
  scores: AtomSemanticScores;
}

export interface AtomSemanticBatchInput {
  sourceText: string;
  candidates: AtomCandidateText[];
}

export interface AtomSemanticBatchResult {
  verdicts: AtomSemanticVerdict[];
  actualModel?: string;
  route?: string;
}

export type AtomSemanticValidator = (
  input: AtomSemanticBatchInput,
) => Promise<AtomSemanticBatchResult>;

export type AtomSemanticValidationErrorCode =
  | 'invalid_json'
  | 'timeout'
  | 'validator_failure';

export class AtomSemanticValidationError extends Error {
  constructor(public readonly code: AtomSemanticValidationErrorCode) {
    super(`atom semantic validation failed: ${code}`);
    this.name = 'AtomSemanticValidationError';
  }
}

export function semanticRejectionReasons(scores: AtomSemanticScores): AtomSemanticReason[] {
  const reasons: AtomSemanticReason[] = [];
  if (scores.source_support !== 1) reasons.push('semantic_source_support');
  if (scores.exactly_one_claim !== 1) reasons.push('semantic_atomicity');
  if (scores.self_contained !== 1) reasons.push('semantic_self_contained');
  if (scores.no_hidden_causation_or_overgeneralization !== 1) {
    reasons.push('semantic_hidden_causation_or_overgeneralization');
  }
  if (scores.no_sensitive_content !== 1) reasons.push('semantic_sensitive_content');
  return reasons;
}

function isBinaryScore(value: unknown): value is 0 | 1 {
  return value === 0 || value === 1;
}

/** Strict parser: malformed, partial, duplicate, or out-of-range output throws. */
export function parseAtomSemanticResponse(raw: string, candidateCount: number): AtomSemanticVerdict[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AtomSemanticValidationError('invalid_json');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AtomSemanticValidationError('invalid_json');
  }
  const verdicts = (parsed as { verdicts?: unknown }).verdicts;
  if (!Array.isArray(verdicts) || verdicts.length !== candidateCount) {
    throw new AtomSemanticValidationError('invalid_json');
  }
  const seen = new Set<number>();
  const normalized: AtomSemanticVerdict[] = [];
  for (const value of verdicts) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new AtomSemanticValidationError('invalid_json');
    }
    const record = value as { index?: unknown; scores?: unknown };
    if (
      !Number.isInteger(record.index) ||
      (record.index as number) < 0 ||
      (record.index as number) >= candidateCount ||
      seen.has(record.index as number) ||
      !record.scores ||
      typeof record.scores !== 'object' ||
      Array.isArray(record.scores)
    ) {
      throw new AtomSemanticValidationError('invalid_json');
    }
    const scores = record.scores as Record<string, unknown>;
    const keys = [
      'source_support',
      'exactly_one_claim',
      'self_contained',
      'no_hidden_causation_or_overgeneralization',
      'no_sensitive_content',
    ] as const;
    if (
      Object.keys(scores).length !== keys.length ||
      !keys.every((key) => isBinaryScore(scores[key]))
    ) {
      throw new AtomSemanticValidationError('invalid_json');
    }
    seen.add(record.index as number);
    normalized.push({
      index: record.index as number,
      scores: {
        source_support: scores.source_support as 0 | 1,
        exactly_one_claim: scores.exactly_one_claim as 0 | 1,
        self_contained: scores.self_contained as 0 | 1,
        no_hidden_causation_or_overgeneralization:
          scores.no_hidden_causation_or_overgeneralization as 0 | 1,
        no_sensitive_content: scores.no_sensitive_content as 0 | 1,
      },
    });
  }
  return normalized.sort((a, b) => a.index - b.index);
}

const SEMANTIC_VALIDATOR_SYSTEM = `You are a fail-closed atom quality gate.
Score every candidate independently with binary 0 or 1 on all five dimensions:
- source_support: the exact source supports the claim without inference.
- exactly_one_claim: exactly one independently checkable claim is present. Score 0 for slash-separated subjects, parenthetical/list enumerations, "including" clauses, or multiple named settings/models/tests even when they share one predicate.
- self_contained: the BODY and source_quote themselves name the specific subject and are a complete standalone sentence without surrounding text. The title cannot repair an incomplete, deictic, vague, or context-dependent body; score 0 for fragments such as "values are not logged" or "the override was unrelated".
- no_hidden_causation_or_overgeneralization: no unsupported cause, quantity, or generalization.
- no_sensitive_content: title, body, and source_quote contain no private or sensitive content.
Return exactly {"verdicts":[{"index":0,"scores":{"source_support":1,"exactly_one_claim":1,"self_contained":1,"no_hidden_causation_or_overgeneralization":1,"no_sensitive_content":1}}]}.
Include one verdict for every index. Use only 0 or 1. Do not include prose or reasons.`;

export interface GatewayAtomSemanticValidatorOpts {
  chat: (opts: ChatOpts) => Promise<ChatResult>;
  model: string;
  timeoutMs?: number;
}

/** Production validator routed through the shared gateway and fallback chain. */
export function createGatewayAtomSemanticValidator(
  opts: GatewayAtomSemanticValidatorOpts,
): AtomSemanticValidator {
  return async (input) => {
    if (input.candidates.length === 0) return { verdicts: [] };
    if (input.candidates.length > 25) throw new AtomSemanticValidationError('validator_failure');
    const timeoutMs = opts.timeoutMs ?? 30_000;
    let result: ChatResult;
    try {
      result = await opts.chat({
        model: opts.model,
        system: SEMANTIC_VALIDATOR_SYSTEM,
        messages: [{
          role: 'user',
          content: JSON.stringify({
            source: input.sourceText.slice(0, 50_000),
            candidates: input.candidates,
          }),
        }],
        maxTokens: 2048,
        abortSignal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // The caller's shared BudgetTracker owns phase-level budget policy.
      // Preserve its typed stop signal so extract_atoms marks the budget
      // exhausted and skips the remainder instead of misclassifying every
      // candidate as a semantic-validator failure.
      if (error instanceof BudgetExhausted) throw error;
      if (error instanceof AtomSemanticValidationError) throw error;
      const name = error instanceof Error ? error.name : '';
      throw new AtomSemanticValidationError(name === 'TimeoutError' || name === 'AbortError'
        ? 'timeout'
        : 'validator_failure');
    }
    return {
      verdicts: parseAtomSemanticResponse(result.text, input.candidates.length),
      actualModel: result.model,
      route: result.providerId,
    };
  };
}
