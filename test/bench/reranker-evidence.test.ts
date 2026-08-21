import { describe, expect, test } from 'bun:test';
import {
  buildRerankerBenchmarkReceipt,
  parseRerankAuditJsonl,
  type RerankerAuditSnapshot,
} from '../../src/core/bench/reranker-evidence.ts';

const before: RerankerAuditSnapshot = {
  valid_line_count: 1,
  invalid_lines: [],
  newest_timestamp: '2026-08-21T10:00:00.000Z',
  reasons: { timeout: 1 },
};

describe('reranker benchmark evidence', () => {
  test('rejects a reranker-expected result without a score', () => {
    const receipt = buildRerankerBenchmarkReceipt({
      expected: true,
      resultSets: [[{ rerank_score: 0.9 }, { rerank_score: null }]],
      before,
      after: before,
    });
    expect(receipt.pass).toBe(false);
    expect(receipt.failure_reason).toBe('missing_rerank_score');
    expect(receipt.expected_result_count).toBe(2);
    expect(receipt.scored_result_count).toBe(1);
  });

  test('validates every audit JSONL line and names malformed input', () => {
    const snapshot = parseRerankAuditJsonl([
      { file: 'rerank-failures-2026-W34.jsonl', content: '{"ts":"2026-08-21T10:00:00.000Z","model":"m","reason":"timeout","doc_count":1}\nnot-json\n' },
    ]);
    expect(snapshot.invalid_lines).toEqual([
      { file: 'rerank-failures-2026-W34.jsonl', line: 2, reason: 'invalid_json' },
    ]);
    const receipt = buildRerankerBenchmarkReceipt({
      expected: true,
      resultSets: [[{ rerank_score: 0.5 }]],
      before,
      after: snapshot,
    });
    expect(receipt.pass).toBe(false);
    expect(receipt.failure_reason).toBe('invalid_rerank_audit_jsonl');
  });

  test('records reason and timestamp deltas and fails on a new audit failure', () => {
    const after: RerankerAuditSnapshot = {
      valid_line_count: 3,
      invalid_lines: [],
      newest_timestamp: '2026-08-21T10:05:00.000Z',
      reasons: { timeout: 1, input_too_large: 2 },
    };
    const receipt = buildRerankerBenchmarkReceipt({
      expected: true,
      resultSets: [[{ rerank_score: 0.8 }]],
      before,
      after,
    });
    expect(receipt.pass).toBe(false);
    expect(receipt.failure_reason).toBe('new_rerank_audit_failure');
    expect(receipt.audit).toMatchObject({
      valid_line_delta: 2,
      newest_timestamp_before: '2026-08-21T10:00:00.000Z',
      newest_timestamp_after: '2026-08-21T10:05:00.000Z',
      newest_timestamp_delta_ms: 300_000,
      reason_deltas: { input_too_large: 2 },
    });
  });
});
