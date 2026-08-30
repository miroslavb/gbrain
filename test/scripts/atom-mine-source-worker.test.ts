import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';

const repoRoot = resolve(import.meta.dir, '..', '..');
const worker = join(repoRoot, 'scripts', 'atom-mine-source-worker.sh');
const scratch: string[] = [];

function makeScratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'atom-source-worker-'));
  scratch.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('atom-mine-source-worker', () => {
  it('passes an explicit source and writes aggregate-only receipts', () => {
    const dir = makeScratch();
    const fake = join(dir, 'fake-gbrain');
    const argsFile = join(dir, 'args');
    writeFileSync(fake, `#!/usr/bin/env bash
printf '%s\\n' "$*" >"${argsFile}"
printf '%s\\n' '{"schema_version":"1","timestamp":"2026-01-01T00:00:00Z","duration_ms":10,"status":"ok","brain_dir":null,"phases":[{"phase":"extract_atoms","status":"warn","duration_ms":10,"summary":"bounded","details":{"source_id":"alpha","pages_processed":2,"pages_total":3,"atoms_extracted":1,"candidates":2,"accepted":1,"rejected":1,"malformed_outputs":0,"failures":[{"source":"semantic_validator","error":"semantic_validator_timeout"}]}}],"totals":{}}'
`, { mode: 0o755 });
    chmodSync(fake, 0o755);

    const result = spawnSync('bash', [worker, 'alpha'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ATOM_MINE_REPO_DIR: repoRoot,
        ATOM_MINE_STATE_DIR: dir,
        ATOM_MINE_GBRAIN_BIN: fake,
        ATOM_MINE_MAX_BATCHES: '1',
        ATOM_MINE_SLEEP_SECONDS: '0',
      },
    });

    expect(result.status).toBe(0);
    expect(readFileSync(argsFile, 'utf8').trim()).toBe(
      'dream --source alpha --phase extract_atoms --once --json',
    );
    const receipt = JSON.parse(readFileSync(join(dir, 'alpha.batches.jsonl'), 'utf8'));
    expect(receipt).toMatchObject({
      source_id: 'alpha',
      pages_processed: 2,
      atoms_extracted: 1,
      validator_errors: 1,
      validator_timeouts: 1,
      provider_errors: 0,
      error_streak: 1,
    });
    const heartbeat = JSON.parse(readFileSync(join(dir, 'alpha.heartbeat.json'), 'utf8'));
    expect(heartbeat).toMatchObject({ source_id: 'alpha', state: 'completed', batch: 1 });
    expect(heartbeat).not.toHaveProperty('content');
  });

  it('rejects unsafe source identifiers before invoking the CLI', () => {
    const result = spawnSync('bash', [worker, '../other'], { encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('invalid source id');
  });

  it('matches the engine source-id length boundary', () => {
    const result = spawnSync('bash', [worker, `a${'b'.repeat(32)}`], { encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('invalid source id');
  });

  it('rejects source identifiers with edge hyphens', () => {
    for (const source of ['-alpha', 'alpha-']) {
      const result = spawnSync('bash', [worker, source], { encoding: 'utf8' });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('invalid source id');
    }
  });

  it('fails closed after consecutive validator operational errors', () => {
    const dir = makeScratch();
    const fake = join(dir, 'fake-validator-error');
    writeFileSync(fake, `#!/usr/bin/env bash
printf '%s\\n' '{"schema_version":"1","timestamp":"2026-01-01T00:00:00Z","duration_ms":10,"status":"partial","brain_dir":null,"phases":[{"phase":"extract_atoms","status":"warn","duration_ms":10,"summary":"validator failed","details":{"source_id":"alpha","pages_processed":0,"pages_total":1,"failures":[{"source":"semantic_validator","error":"semantic_validator_invalid_json"}]}}],"totals":{}}'
`, { mode: 0o755 });
    chmodSync(fake, 0o755);

    const result = spawnSync('bash', [worker, 'alpha'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ATOM_MINE_REPO_DIR: repoRoot,
        ATOM_MINE_STATE_DIR: dir,
        ATOM_MINE_GBRAIN_BIN: fake,
        ATOM_MINE_SLEEP_SECONDS: '0',
        ATOM_MINE_MAX_ERROR_STREAK: '2',
      },
    });

    expect(result.status).toBe(1);
    const receipts = readFileSync(join(dir, 'alpha.batches.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    expect(receipts).toHaveLength(2);
    expect(receipts[1]).toMatchObject({ validator_errors: 1, error_streak: 2 });
    const heartbeat = JSON.parse(readFileSync(join(dir, 'alpha.heartbeat.json'), 'utf8'));
    expect(heartbeat).toMatchObject({ state: 'failed', error_streak: 2 });
  });
});
