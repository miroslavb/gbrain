import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { performSync, runSync, syncOneSource } from '../src/commands/sync.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

// The standard preloads isolate GBRAIN_HOME/audit/provider credentials. Only
// disposable Git repos and one in-memory database are used; never pull/embed.
describe('sync inherits the selected source strategy', () => {
  let engine: PGLiteEngine;
  let repo: string;
  const base = { sourceId: 'fixture-a', noPull: true, noEmbed: true, noExtract: true, noSchemaPack: true };
  const cli = ['--source', 'fixture-a', '--no-pull', '--no-embed', '--no-extract', '--no-schema-pack'];
  const md = (body: string) => `---\ntype: note\ntitle: Notes\n---\n\n${body}\n`;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString().trim();
  const commit = () => { git('add', 'app.py', 'notes.md'); git('commit', '-qm', 'fixture'); };
  const page = (sourceId = 'fixture-a') => engine.getPage('app-py', { sourceId });

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });
  afterAll(async () => { await engine.disconnect(); });
  beforeEach(async () => {
    await resetPgliteState(engine);
    repo = mkdtempSync(join(tmpdir(), 'gbrain-source-strategy-'));
    git('init', '-q');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    writeFileSync(join(repo, 'app.py'), 'def answer():\n    return 17\n');
    writeFileSync(join(repo, 'notes.md'), md('Initial notes.'));
    commit();
    for (const id of ['fixture-a', 'fixture-b']) {
      await engine.executeRaw(
        `INSERT INTO sources (id, name, local_path, config) VALUES ($1, $1, $2, $3::text::jsonb)`,
        [id, repo, JSON.stringify({ strategy: id === 'fixture-a' ? 'auto' : 'markdown' })],
      );
    }
  });
  afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

  async function modifiedCodeFixture() {
    await performSync(engine, { ...base, strategy: 'auto' });
    expect(await page()).not.toBeNull();
    await engine.putPage('app-py', { type: 'note', title: 'Independent source', compiled_truth: 'Foreign row.' }, { sourceId: 'fixture-b' });
    writeFileSync(join(repo, 'app.py'), 'def answer():\n    return 29\n');
    writeFileSync(join(repo, 'notes.md'), md('Changed notes.'));
    commit();
  }

  test('single-source CLI omission retains and refreshes modified Python under saved auto', async () => {
    await modifiedCodeFixture();
    await runSync(engine, cli);
    expect((await page())?.compiled_truth).toContain('return 29');
    expect((await page('fixture-b'))?.compiled_truth).toBe('Foreign row.');
    const rows = await engine.executeRaw<{ deleted_at: unknown }>(`SELECT deleted_at FROM pages WHERE source_id = $1 AND slug = 'app-py'`, ['fixture-a']);
    expect(rows[0].deleted_at).toBeNull();
  });

  test('explicit markdown still soft-deletes modified code only in its source', async () => {
    await modifiedCodeFixture();
    await runSync(engine, [...cli, '--strategy', 'markdown']);
    expect(await page()).toBeNull();
    expect((await page('fixture-b'))?.compiled_truth).toBe('Foreign row.');
    const rows = await engine.executeRaw<{ deleted_at: unknown }>(`SELECT deleted_at FROM pages WHERE source_id = $1 AND slug = 'app-py'`, ['fixture-a']);
    expect(rows).toHaveLength(1);
    expect(rows[0].deleted_at).not.toBeNull();
    expect((await engine.getPage('notes', { sourceId: 'fixture-a' }))?.compiled_truth).toContain('Changed notes.');
  });

  test('direct first sync inherits auto before the full import walk', async () => {
    await performSync(engine, base);
    expect((await page())?.compiled_truth).toContain('return 17');
    expect(await engine.getPage('notes', { sourceId: 'fixture-a' })).not.toBeNull();
    expect(await page('fixture-b')).toBeNull();
  });

  test('missing saved strategy keeps the legacy markdown default', async () => {
    await engine.executeRaw(`UPDATE sources SET config = '{}'::jsonb WHERE id = 'fixture-a'`);
    await performSync(engine, base);
    expect(await page()).toBeNull();
    expect(await engine.getPage('notes', { sourceId: 'fixture-a' })).not.toBeNull();
  });

  test('saved code imports code and excludes markdown', async () => {
    await engine.executeRaw(`UPDATE sources SET config = '{"strategy":"code"}'::jsonb WHERE id = 'fixture-a'`);
    await performSync(engine, base);
    expect(await page()).not.toBeNull();
    expect(await engine.getPage('notes', { sourceId: 'fixture-a' })).toBeNull();
  });

  test('--all honors an explicit strategy above each saved source setting', async () => {
    await runSync(engine, ['--all', '--serial', '--no-pull', '--no-embed', '--no-extract', '--no-schema-pack', '--strategy', 'auto']);
    // fixture-b is saved markdown, so this code row proves the explicit override.
    for (const sourceId of ['fixture-a', 'fixture-b']) {
      expect(await page(sourceId)).not.toBeNull();
      expect(await engine.getPage('notes', { sourceId })).not.toBeNull();
    }
  });

  test('worker wrapper applies explicit override and otherwise keeps saved scope', async () => {
    const src = { id: 'fixture-b', name: 'Fixture B', local_path: repo, config: { strategy: 'markdown' } };
    const shared = { dryRun: false, full: true, noPull: true, noEmbed: true, noExtract: true, noSchemaPack: true, skipFailed: false, retryFailed: false, concurrency: undefined };
    await syncOneSource(engine, src, shared);
    expect(await page('fixture-b')).toBeNull();
    await syncOneSource(engine, src, { ...shared, strategy: 'auto' });
    expect(await page('fixture-b')).not.toBeNull();
    expect(await page()).toBeNull();
  });

  test('invalid saved strategy fails before first-sync writes; explicit valid override remains usable', async () => {
    await engine.executeRaw(`UPDATE sources SET config = '{"strategy":"typo"}'::jsonb WHERE id = 'fixture-a'`);
    await expect(performSync(engine, base)).rejects.toThrow('Invalid sync strategy');
    expect(await page()).toBeNull();
    const rows = await engine.executeRaw<{ last_commit: unknown }>(`SELECT last_commit FROM sources WHERE id = 'fixture-a'`);
    expect(rows[0].last_commit).toBeNull();
    await performSync(engine, { ...base, strategy: 'auto' });
    expect(await page()).not.toBeNull();
  });

  test('invalid CLI strategy cannot delete or advance a modified source', async () => {
    await modifiedCodeFixture();
    const before = await engine.executeRaw(`SELECT last_commit FROM sources WHERE id = 'fixture-a'`);
    await expect(runSync(engine, [...cli, '--strategy', 'typo'])).rejects.toThrow('Invalid sync strategy');
    expect((await page())?.compiled_truth).toContain('return 17');
    expect(await engine.executeRaw(`SELECT last_commit FROM sources WHERE id = 'fixture-a'`)).toEqual(before);
  });
});
