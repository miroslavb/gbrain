export interface RerankerAuditInvalidLine {
  file: string;
  line: number;
  reason: 'invalid_json' | 'invalid_shape';
}

export interface RerankerAuditSnapshot {
  valid_line_count: number;
  invalid_lines: RerankerAuditInvalidLine[];
  newest_timestamp: string | null;
  reasons: Record<string, number>;
}

export interface RerankerBenchmarkReceipt {
  pass: boolean;
  failure_reason?:
    | 'invalid_rerank_audit_jsonl'
    | 'missing_rerank_score'
    | 'new_rerank_audit_failure';
  rerank_expected: boolean;
  expected_result_count: number;
  scored_result_count: number;
  audit: {
    valid_line_delta: number;
    invalid_line_delta: number;
    newest_timestamp_before: string | null;
    newest_timestamp_after: string | null;
    newest_timestamp_delta_ms: number | null;
    reason_deltas: Record<string, number>;
  };
}

export function parseRerankAuditJsonl(
  files: ReadonlyArray<{ file: string; content: string }>,
): RerankerAuditSnapshot {
  let valid = 0;
  let newest: string | null = null;
  const reasons: Record<string, number> = {};
  const invalid: RerankerAuditInvalidLine[] = [];
  for (const file of files) {
    const lines = file.content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const raw = lines[index]!.trim();
      if (!raw) continue;
      let row: unknown;
      try {
        row = JSON.parse(raw);
      } catch {
        invalid.push({ file: file.file, line: index + 1, reason: 'invalid_json' });
        continue;
      }
      if (!row || typeof row !== 'object') {
        invalid.push({ file: file.file, line: index + 1, reason: 'invalid_shape' });
        continue;
      }
      const record = row as Record<string, unknown>;
      if (typeof record.ts !== 'string' || typeof record.reason !== 'string') {
        invalid.push({ file: file.file, line: index + 1, reason: 'invalid_shape' });
        continue;
      }
      valid++;
      reasons[record.reason] = (reasons[record.reason] ?? 0) + 1;
      if (Number.isFinite(Date.parse(record.ts)) && (!newest || Date.parse(record.ts) > Date.parse(newest))) {
        newest = record.ts;
      }
    }
  }
  return { valid_line_count: valid, invalid_lines: invalid, newest_timestamp: newest, reasons };
}

function timestampDelta(before: string | null, after: string | null): number | null {
  if (!before || !after) return null;
  const a = Date.parse(after);
  const b = Date.parse(before);
  return Number.isFinite(a) && Number.isFinite(b) ? a - b : null;
}

export function buildRerankerBenchmarkReceipt(input: {
  expected: boolean;
  resultSets: ReadonlyArray<ReadonlyArray<{ rerank_score?: number | null }>>;
  before: RerankerAuditSnapshot;
  after: RerankerAuditSnapshot;
}): RerankerBenchmarkReceipt {
  const results = input.resultSets.flat();
  const scored = results.filter((row) => typeof row.rerank_score === 'number' && Number.isFinite(row.rerank_score));
  const reasonDeltas: Record<string, number> = {};
  for (const reason of new Set([...Object.keys(input.before.reasons), ...Object.keys(input.after.reasons)])) {
    const delta = (input.after.reasons[reason] ?? 0) - (input.before.reasons[reason] ?? 0);
    if (delta > 0) reasonDeltas[reason] = delta;
  }
  const audit = {
    valid_line_delta: input.after.valid_line_count - input.before.valid_line_count,
    invalid_line_delta: input.after.invalid_lines.length - input.before.invalid_lines.length,
    newest_timestamp_before: input.before.newest_timestamp,
    newest_timestamp_after: input.after.newest_timestamp,
    newest_timestamp_delta_ms: timestampDelta(input.before.newest_timestamp, input.after.newest_timestamp),
    reason_deltas: reasonDeltas,
  };
  let failure: RerankerBenchmarkReceipt['failure_reason'];
  if (input.after.invalid_lines.length > input.before.invalid_lines.length) {
    failure = 'invalid_rerank_audit_jsonl';
  } else if (input.expected && scored.length !== results.length) {
    failure = 'missing_rerank_score';
  } else if (audit.valid_line_delta > 0 || Object.keys(reasonDeltas).length > 0) {
    failure = 'new_rerank_audit_failure';
  }
  return {
    pass: failure === undefined,
    ...(failure ? { failure_reason: failure } : {}),
    rerank_expected: input.expected,
    expected_result_count: input.expected ? results.length : 0,
    scored_result_count: input.expected ? scored.length : 0,
    audit,
  };
}
