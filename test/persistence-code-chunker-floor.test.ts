import { describe, expect, test } from 'bun:test';
import { parserAcceptedForSync, sourceCodeChunkerStamp, automaticSyncParser } from '../src/core/persistence/code-chunker-admission.ts';
import { syncImportParserFor, type SyncImportParser } from '../src/core/persistence/sync-holds.ts';
import { classifySyncPath, type SyncPathState } from '../src/core/persistence/sync-classify.ts';
import { chunkerStamp, AUTOMATIC_CODE_CHUNKER_VERSION } from '../src/core/chunkers/code.ts';

const current = syncImportParserFor('src/example.ts', null);
const older = { ...current, parser_version: current.parser_version.replace(/chunker=\d+/, `chunker=${AUTOMATIC_CODE_CHUNKER_VERSION}`) };
function classify(recorded: SyncImportParser | null, patch: Partial<SyncPathState> = {}, full = false) {
  const state: SyncPathState = { mode: 'committed', tree: 'blob1', level: 'blob1', present: true, dirty: 'clean', diskOid: null,
    page: { live: true, revision: 'revision1', originMatches: true }, record: { blobOids: ['blob1'], revision: 'revision1', parserSame: false },
    attested: null, levelSha256: null, published: false, hold: null, marker: null, baseline: 'blob1', spelling: false,
    episodeUnsatisfied: full, fullObligation: full, keepDb: false, openWork: false, ...patch };
  state.record!.parserSame = parserAcceptedForSync(recorded, current, { unchanged: state.level === 'blob1' && state.page?.revision === 'revision1', explicitFull: full });
  return classifySyncPath(state).cls;
}
describe('managed automatic code chunker admission', () => {
  test('unchanged source/page keep floor-admitted chunks without mutating actual parser provenance', () => {
    const before = JSON.stringify(older);
    expect(classify(older)).toBe('matched');
    expect(JSON.stringify(older)).toBe(before);
    expect(automaticSyncParser(current)).toEqual(automaticSyncParser(older));
    expect(current.parser_version).toBe(`code=1;chunker=${chunkerStamp()}`);
    expect(sourceCodeChunkerStamp(false)).toBe(String(AUTOMATIC_CODE_CHUNKER_VERSION));
    expect(sourceCodeChunkerStamp(true)).toBe(chunkerStamp());
  });
  test('changed source, changed DB, moved origin and explicit full retain their ordinary guarded action', () => {
    expect(classify(older, { tree: 'blob2', level: 'blob2' })).toBe('import');
    expect(classify(older, { page: { live: true, revision: 'revision2', originMatches: true } })).toBe('db_ahead');
    expect(classify(older, { page: { live: true, revision: 'revision1', originMatches: false } })).toBe('reparse');
    expect(classify(older, {}, true)).toBe('reparse');
  });
  test('unknown, below-floor, future, importer and grammar changes never inherit the exception', () => {
    for (const recorded of [null, { ...older, parser_version: older.parser_version.replace(/chunker=\d+/, 'chunker=5') },
      { ...older, parser_version: older.parser_version.replace(/chunker=\d+/, 'chunker=999') },
      { ...older, parser_version: older.parser_version.replace('code=1', 'code=0') },
      { ...older, parser_version: older.parser_version + ';different_grammar=1' },
      { ...older, markdown_chunker: current.markdown_chunker - 1 }]) expect(classify(recorded)).toBe('reparse');
    expect(parserAcceptedForSync({ ...current, parser_version: 'import=0' }, { ...current, parser_version: 'import=1' }, { unchanged: true, explicitFull: false })).toBe(false);
  });
});
