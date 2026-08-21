import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { checkRerankerHealth } from '../src/commands/doctor.ts';
import { logRerankFailure } from '../src/core/rerank-audit.ts';
import { withEnv } from './helpers/with-env.ts';

describe('reranker doctor recovery evidence', () => {
  test('historical capacity failure is distinguished from a reachable current backend', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-rerank-recovery-'));
    try {
      await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
        logRerankFailure({
          model: 'llama-server-reranker:qwen3-reranker',
          reason: 'input_too_large',
          query_hash: 'historic',
          doc_count: 12,
          token_count: 2308,
          error_summary: 'input too large',
        });
        const check = await checkRerankerHealth({
          kind: 'pglite',
          async getConfig(key: string): Promise<string | null> {
            return key === 'search.reranker.enabled' ? 'true' : null;
          },
        } as any, {
          probeReachability: async () => ({
            model: 'llama-server-reranker:qwen3-reranker',
            status: 'ok',
            message: 'reachable',
            elapsed_ms: 17,
          }),
        });
        expect(check.status).toBe('warn');
        expect(check.details).toMatchObject({
          newest_failure_model: 'llama-server-reranker:qwen3-reranker',
          newest_failure_token_count: 2308,
          current_reachability: 'reachable',
          recovered: true,
        });
        expect(check.details?.newest_failure_timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(check.message).toContain('Current probe is reachable');
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
