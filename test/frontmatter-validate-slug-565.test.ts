import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync, spawnSync } from 'child_process';

const fence = '---';

function runValidate(path: string): { stdout: string; code: number } {
  const r = spawnSync(process.execPath, ['run', 'src/cli.ts', 'frontmatter', 'validate', path], {
    encoding: 'utf8',
    cwd: process.cwd(),
    env: process.env,
  });
  return { stdout: r.stdout ?? '', code: r.status ?? -1 };
}

// Regression for #565. Single-file `frontmatter validate` derived the expected
// slug from the ABSOLUTE path: `relative(resolve(target), file)` is empty when
// the target IS the file, so it fell back to `|| file` (the full path),
// yielding bogus "root/<abs-path>" slugs and a false SLUG_MISMATCH. The hook
// installed by `frontmatter install-hook` validates staged files one-by-one,
// so this rejected every commit in a markdown brain. The expected slug must be
// derived relative to the brain root (nearest `.git`).
describe('frontmatter validate single-file slug (#565)', () => {
  let brain: string;

  beforeEach(() => {
    brain = mkdtempSync(join(tmpdir(), 'fm-565-'));
    execFileSync('git', ['init', '-q', brain]);
  });

  afterEach(() => {
    rmSync(brain, { recursive: true, force: true });
  });

  test('single file with a correct nested slug validates clean', () => {
    mkdirSync(join(brain, 'companies'), { recursive: true });
    const f = join(brain, 'companies', 'readme.md');
    writeFileSync(f, `${fence}\ntype: company\ntitle: Readme\nslug: companies/readme\n${fence}\n\nbody`);
    const { stdout, code } = runValidate(f);
    expect(stdout).not.toContain('SLUG_MISMATCH');
    expect(code).toBe(0);
  });

  test('directory validation still derives brain-root-relative slugs', () => {
    mkdirSync(join(brain, 'people'), { recursive: true });
    writeFileSync(
      join(brain, 'people', 'alice.md'),
      `${fence}\ntype: person\ntitle: Alice\nslug: people/alice\n${fence}\n\nbody`,
    );
    const { stdout, code } = runValidate(join(brain, 'people'));
    expect(stdout).not.toContain('SLUG_MISMATCH');
    expect(code).toBe(0);
  });

  test('invalid .git marker is ignored and falls back to the file directory', () => {
    rmSync(join(brain, '.git'), { recursive: true, force: true });
    // A stale/empty marker is not a repository. The old ancestor walk treated
    // it as the root and derived nested/note instead of the basename fallback.
    mkdirSync(join(brain, '.git'));
    mkdirSync(join(brain, 'nested'));
    const f = join(brain, 'nested', 'note.md');
    writeFileSync(f, `${fence}\ntype: note\ntitle: Note\nslug: note\n${fence}\n\nbody`);
    const { stdout, code } = runValidate(f);
    expect(stdout).not.toContain('SLUG_MISMATCH');
    expect(code).toBe(0);
  });
});
