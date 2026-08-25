import { execFileSync } from 'node:child_process';
import { isAbsolute, relative, sep } from 'node:path';
import { realpathSync } from 'node:fs';

/** Resolve the real Git worktree containing gbrainHome, or null. */
export function containingGitWorktree(gbrainHome: string): string | null {
  if (!gbrainHome) return null;
  let resolvedHome: string;
  try {
    resolvedHome = realpathSync(gbrainHome);
  } catch {
    return null;
  }
  let output: string;
  try {
    output = execFileSync(
      'git',
      ['-C', resolvedHome, 'rev-parse', '--is-inside-work-tree', '--show-toplevel'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
  } catch {
    return null;
  }
  const lines = output.trim().split(/\r?\n/);
  if (lines[0] !== 'true' || !lines[1]) return null;
  let top: string;
  try {
    top = realpathSync(lines[1]);
  } catch {
    return null;
  }
  const rel = relative(top, resolvedHome);
  if (rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))) return top;
  return null;
}
