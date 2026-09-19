import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { ATOM_PROCESSING_KEY, atomProcessingWriter, emptyAtomProcessing } from '../src/core/cycle/atom-processing.ts';
import { runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import type { ChatResult } from '../src/core/ai/gateway.ts';

let engine: PGLiteEngine | PostgresEngine;
beforeAll(async () => {
  const postgresUrl = process.env.GBRAIN_ATOM_TEST_POSTGRES;
  if (postgresUrl) {
    const uri = new URL(postgresUrl);
    if (uri.hostname !== '127.0.0.1' || !uri.pathname.startsWith('/gbrain_test')) throw Error('Disposable test DB required');
    engine = new PostgresEngine(); await engine.connect({ database_url: postgresUrl });
  } else {
    engine = new PGLiteEngine(); await engine.connect({});
  }
  await engine.initSchema();
}, 120000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await engine.setConfig(ATOM_PROCESSING_KEY, JSON.stringify(emptyAtomProcessing('a'.repeat(64)))); });
const state = async () => JSON.parse((await engine.getConfig(ATOM_PROCESSING_KEY))!);
const chat = (text: string) => async (): Promise<ChatResult> => ({ text, blocks: [], stopReason: 'end',
  usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
  model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' });
const page = { slug: 'notes/probe', content: 'Enterprise buyers require working prototypes.', contentHash: 'abcdef1234567890' };

describe('actual page processing outcomes', () => {
  test('successful empty extraction is completed, not failed or stalled', async () => {
    await runPhaseExtractAtoms(engine, { _transcripts: [], _pages: [page], _chat: chat('[]') });
    expect(await state()).toMatchObject({ eligible_dispatches: 1, attempted_scans: 1,
      completed_scans: 1, empty_scans: 1, failed_scans: 0, published_atoms: 0 });
  });
  test('malformed and operational errors are failed attempts', async () => {
    await runPhaseExtractAtoms(engine, { _transcripts: [], _pages: [page], _chat: chat('not json') });
    await runPhaseExtractAtoms(engine, { _transcripts: [], _pages: [page],
      _chat: async () => { throw new Error('timeout'); } });
    expect(await state()).toMatchObject({ attempted_scans: 2, completed_scans: 0, failed_scans: 2, empty_scans: 0 });
  });
  test('published counts require the completion flip; transcript outputs are excluded', async () => {
    await engine.putPage(page.slug, { type: 'note', title: 'Probe', compiled_truth: page.content, timeline: '' });
    const answer = JSON.stringify([{ title: 'Prototype requirement', atom_type: 'insight', body: page.content }]);
    await runPhaseExtractAtoms(engine, { _transcripts: [], _pages: [page], _chat: chat(answer) });
    expect(await state()).toMatchObject({ completed_scans: 1, empty_scans: 0, published_atoms: 1 });
    await runPhaseExtractAtoms(engine, { _pages: [], _transcripts: [{ filePath: '/fixture/transcript.txt',
      content: page.content, contentHash: '1234567890abcdef' }], _chat: chat('[]') });
    expect(await state()).toMatchObject({ attempted_scans: 1, completed_scans: 1, published_atoms: 1 });
  });
  test('no-work phase and dry-run are not page attempts', async () => {
    await runPhaseExtractAtoms(engine, { _pages: [], _transcripts: [] });
    await runPhaseExtractAtoms(engine, { _pages: [page], _transcripts: [], dryRun: true, _chat: chat('[]') });
    expect(await state()).toMatchObject({ phase_dispatches: 1, no_work_dispatches: 1, attempted_scans: 0 });
  });
  test('atomic concurrent increments and retired epoch fence', async () => {
    const record = await atomProcessingWriter(engine);
    await Promise.all(Array.from({ length: 20 }, () => record({ eligible_dispatches: 1 })));
    expect((await state()).eligible_dispatches).toBe(20);
    await engine.setConfig(ATOM_PROCESSING_KEY, JSON.stringify(emptyAtomProcessing('b'.repeat(64))));
    await expect(record({ attempted_scans: 1 })).rejects.toThrow('epoch changed');
    expect((await state()).attempted_scans).toBe(0);
  });
});
