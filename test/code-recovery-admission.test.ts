import { describe, test, expect } from 'bun:test';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { AUTOMATIC_CODE_CHUNKER_VERSION, CHUNKER_VERSION } from '../src/core/chunkers/code.ts';
import { positionalArgs } from '../src/commands/code-scope.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { performSync } from '../src/commands/sync.ts';

describe('finite v7 admission', () => {
  test('v7 does not advance the automatic source recovery floor', () => {
    expect(CHUNKER_VERSION).toBe(7);
    expect(AUTOMATIC_CODE_CHUNKER_VERSION).toBe(6);
    for (const path of ['src/commands/sync.ts', 'src/core/sync-cost-gate.ts',
                        'src/commands/doctor/checks/extraction-sync.ts']) {
      const text = readFileSync(new URL('../' + path, import.meta.url), 'utf8');
      expect(text).toContain('String(AUTOMATIC_CODE_CHUNKER_VERSION)');
      expect(text).not.toMatch(/\bString\(CHUNKER_VERSION\)/);
    }
  });
  test('file flag before a reference symbol cannot become that symbol', () => {
    expect(positionalArgs(['--file', 'hooks/read.py', '--source', 'memory', 'read'])).toEqual(['read']);
    expect(positionalArgs(['--file=hooks/read.py', 'read'])).toEqual(['read']);
  });
  test('an unchanged v6 source really stays up_to_date without a full walk', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'code-recovery-admission-'));
    const engine = new PGLiteEngine();
    try {
      execFileSync('git', ['init', '-b', 'main', repo]);
      writeFileSync(join(repo, 'sample.py'), 'def camera():\n    return 1\n');
      execFileSync('git', ['-C', repo, 'add', 'sample.py']);
      execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture']);
      const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      await engine.connect({}); await engine.initSchema();
      await engine.executeRaw(`INSERT INTO sources(id,name,local_path,last_commit,chunker_version,config)
        VALUES('admitted','admitted',$1,$2,'6','{"strategy":"code"}'::jsonb)`, [repo, head]);
      const before = await engine.executeRaw('SELECT count(*)::int AS n FROM pages');
      const result = await performSync(engine, { repoPath: repo, sourceId: 'admitted',
        noPull: true, noEmbed: true, noExtract: true, strategy: 'code' });
      expect(result.status).toBe('up_to_date');
      expect(await engine.executeRaw('SELECT count(*)::int AS n FROM pages')).toEqual(before);
      expect((await engine.executeRaw<{ chunker_version: string }>(
        "SELECT chunker_version FROM sources WHERE id='admitted'"))[0].chunker_version).toBe('6');
    } finally { await engine.disconnect(); rmSync(repo, { recursive: true, force: true }); }
  }, 120000);
});
