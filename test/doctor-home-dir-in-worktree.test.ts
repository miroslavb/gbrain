import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { containingGitWorktree } from '../src/core/home-worktree.ts';

let scratch: string;

beforeEach(() => {
  scratch = join(tmpdir(), `gbrain-home-worktree-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(scratch, { recursive: true });
});
afterEach(() => { try { rmSync(scratch, { recursive: true, force: true }); } catch {} });

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function initRepo(name = 'repo'): { repo: string; brain: string } {
  const repo = join(scratch, name);
  mkdirSync(repo, { recursive: true });
  git(repo, 'init');
  git(repo, 'config', 'user.email', 'doctor@example.test');
  git(repo, 'config', 'user.name', 'Doctor Test');
  writeFileSync(join(repo, 'seed'), 'seed\n');
  git(repo, 'add', 'seed');
  git(repo, 'commit', '-m', 'seed');
  const brain = join(repo, '.gbrain');
  mkdirSync(brain);
  return { repo, brain };
}

describe('home_dir_in_worktree semantic detector', () => {
  test('real main worktree warns', () => {
    const { repo, brain } = initRepo();
    expect(containingGitWorktree(brain)).toBe(repo);
  });

  test('real linked worktree warns', () => {
    const { repo } = initRepo('main');
    const linked = join(scratch, 'linked');
    git(repo, 'worktree', 'add', '-b', 'linked-test', linked);
    const brain = join(linked, '.gbrain');
    mkdirSync(brain);
    expect(containingGitWorktree(brain)).toBe(linked);
  });

  test('empty/orphan .git and malformed pointer do not warn', () => {
    for (const [name, file] of [['empty', false], ['malformed', true]] as const) {
      const root = join(scratch, name);
      mkdirSync(root, { recursive: true });
      if (file) writeFileSync(join(root, '.git'), 'gitdir: /missing/path\n');
      else mkdirSync(join(root, '.git'));
      const brain = join(root, '.gbrain');
      mkdirSync(brain);
      expect(containingGitWorktree(brain)).toBeNull();
    }
  });

  test('bare repo, sibling prefix collision and symlink target outside are safe', () => {
    const bare = join(scratch, 'bare.git');
    mkdirSync(bare);
    git(bare, 'init', '--bare');
    expect(containingGitWorktree(bare)).toBeNull();

    const { repo } = initRepo('repo-prefix');
    const sibling = `${repo}-safe`;
    mkdirSync(sibling);
    expect(containingGitWorktree(sibling)).toBeNull();

    const outside = join(scratch, 'outside');
    mkdirSync(outside);
    const link = join(repo, '.gbrain-link');
    symlinkSync(outside, link);
    expect(containingGitWorktree(link)).toBeNull();
  });
});
