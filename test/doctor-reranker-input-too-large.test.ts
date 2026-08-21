import { describe, test, expect } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { withEnv } from './helpers/with-env.ts';
import { logRerankFailure } from '../src/core/rerank-audit.ts';
import { checkRerankerHealth } from '../src/commands/doctor.ts';

describe('reranker input-too-large doctor classification', () => {
  test('one capacity failure warns with -b/-ub guidance', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-rerank-input-doctor-'));
    try {
      await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
        logRerankFailure({
          model: 'llama-server-reranker:bge-reranker-v2-m3',
          reason: 'input_too_large',
          query_hash: 'longinput',
          doc_count: 12,
          error_summary: 'input (2308 tokens) is too large to process; physical batch size 2048',
        });
        const check = await checkRerankerHealth({
          async getConfig(key: string): Promise<string | null> {
            return key === 'search.reranker.enabled' ? 'true' : null;
          },
        } as any);
        expect(check.status).toBe('warn');
        expect(check.message).toContain('input-too-large');
        expect(check.message).toContain('-b/-ub');
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
