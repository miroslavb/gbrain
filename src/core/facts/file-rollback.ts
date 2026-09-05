/** Compensate our own rename on a DB failure while the page lock is held.
 * Never overwrite a later uncooperative editor. Power-loss recovery remains
 * markdown → sync; an old content_hash deliberately keeps that work pending.
 */
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';

export function rollbackFactFile(path: string, written: string, original: string | null): void {
  if (readFileSync(path, 'utf8') !== written) {
    throw new Error('Fact write failed with concurrent file drift; preserve file and reconcile before retry');
  }
  if (original === null) {
    unlinkSync(path);
  } else {
    writeFileSync(path + '.tmp', original, 'utf8');
    renameSync(path + '.tmp', path);
  }
}
