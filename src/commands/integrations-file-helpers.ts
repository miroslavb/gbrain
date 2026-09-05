import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export function sha256OfFile(path: string): string {
  const h = createHash('sha256');
  h.update(readFileSync(path));
  return h.digest('hex');
}

/** Static manifest path validation; the caller checks resolved symlink scope. */
export function validateManifestTarget(target: string): string | null {
  if (target.startsWith('/')) return `absolute path not allowed: ${target}`;
  if (target.includes('..')) return `parent-dir escape not allowed: ${target}`;
  if (target.includes('\0')) return `null byte in path: ${target}`;
  return null;
}

export function sha256OfBuffer(buf: Buffer): string {
  const h = createHash('sha256');
  h.update(buf);
  return h.digest('hex');
}
