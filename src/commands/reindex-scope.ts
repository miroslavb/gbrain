import { MARKDOWN_CHUNKER_VERSION } from '../core/chunkers/recursive.ts';

export interface ReindexScope {
  type: string | null;
  sourceId: string | null;
  prefix: string | null;
  retrievedSince: string | null;
}

export interface ReindexScopeSql {
  where: string;
  params: unknown[];
}

export interface ReindexHotCursor {
  hotAt: string;
  updatedAt: string;
  id: number;
}

export function normalizeReindexPrefix(raw: string | undefined): string | null {
  if (raw == null || raw.trim().length === 0 || raw.trimStart().startsWith('--')) return null;
  const normalized = raw.trim().replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
  if (
    normalized.length === 0
    || normalized.length > 512
    || normalized.includes('..')
    || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(normalized)
  ) return null;
  return normalized;
}

export function normalizeRetrievedSince(raw: string | undefined): string | null {
  if (raw == null || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) return null;
  return raw;
}

/** Build one parameterized scope predicate shared by count + batch reads. */
export function buildReindexScopeSql(scope: ReindexScope, noEmbed: boolean): ReindexScopeSql {
  const params: unknown[] = [MARKDOWN_CHUNKER_VERSION];
  const clauses = [
    `page_kind = 'markdown'`,
    noEmbed
      ? 'chunker_version < $1'
      : '(chunker_version < $1 OR contextual_retrieval_mode IS NULL)',
    'deleted_at IS NULL',
  ];
  const bind = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  if (scope.type) clauses.push(`type = ${bind(scope.type)}`);
  if (scope.sourceId) clauses.push(`source_id = ${bind(scope.sourceId)}`);
  if (scope.prefix) {
    const p = bind(scope.prefix);
    clauses.push(`(slug = ${p} OR slug LIKE ${p} || '/%')`);
  }
  if (scope.retrievedSince) {
    clauses.push(`last_retrieved_at >= ${bind(`${scope.retrievedSince}T00:00:00.000Z`)}::timestamptz`);
  }
  return { where: clauses.join('\n          AND '), params };
}

export function reindexScopeLabel(scope: ReindexScope, hotFirst: boolean): string {
  return [
    scope.type ? `type=${scope.type}` : null,
    scope.sourceId ? `source=${scope.sourceId}` : null,
    scope.prefix ? `prefix=${scope.prefix}` : null,
    scope.retrievedSince ? `retrieved_since=${scope.retrievedSince}` : null,
    hotFirst ? 'order=hot-first' : null,
  ].filter(Boolean).join(' ');
}

export function toReindexHotCursor(row: {
  id: number;
  hot_at: Date | string;
  updated_at: Date | string;
}): ReindexHotCursor {
  const asIso = (value: Date | string): string => value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
  return { hotAt: asIso(row.hot_at), updatedAt: asIso(row.updated_at), id: row.id };
}
