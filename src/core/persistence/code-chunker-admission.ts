/** Host policy: newer code chunkers are admitted per changed file, never by an automatic whole-source reparse. */
import { AUTOMATIC_CODE_CHUNKER_VERSION, chunkerStamp } from '../chunkers/code.ts';
import type { SyncImportParser } from './sync-holds.ts';

/** Exact provenance is unchanged. Only an unchanged file AND page may keep an admitted older code chunker. */
export function parserAcceptedForSync(recorded: SyncImportParser | null | undefined, current: SyncImportParser,
  opts: { unchanged: boolean; explicitFull: boolean }): boolean {
  if (!recorded || recorded.markdown_chunker !== current.markdown_chunker || (recorded.schema_pack ?? null) !== current.schema_pack) return false;
  if (recorded.parser_version === current.parser_version) return true;
  if (!opts.unchanged || opts.explicitFull) return false;
  const before = /^(code=\d+;chunker=)(\d+)(;.*)?$/.exec(recorded.parser_version);
  const after = /^(code=\d+;chunker=)(\d+)(;.*)?$/.exec(current.parser_version);
  // Grammar/importer changes, unknown provenance, a future version and versions below the recovery floor still reparse.
  return !!before && !!after && before[1] === after[1] && (before[3] ?? '') === (after[3] ?? '')
    && Number(before[2]) >= AUTOMATIC_CODE_CHUNKER_VERSION && Number(before[2]) <= Number(after[2]);
}

/** Source admission metadata is a floor; only an explicit full reparse may claim the current complete chunker stamp. */
export const sourceCodeChunkerStamp = (explicitFull: boolean): string => explicitFull ? chunkerStamp() : String(AUTOMATIC_CODE_CHUNKER_VERSION);

/** Discovery's policy identity stays stable across an unadmitted code-version bump; grammar and importer identities remain exact. */
export function automaticSyncParser(parser: SyncImportParser): SyncImportParser {
  return { ...parser, parser_version: parser.parser_version.replace(/^(code=\d+;chunker=)\d+/, `$1${AUTOMATIC_CODE_CHUNKER_VERSION}`) };
}
