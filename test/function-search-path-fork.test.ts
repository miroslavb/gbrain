import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { LATEST_VERSION, runMigrations } from '../src/core/migrate.ts';
import { convergeFunctionSearchPaths } from '../src/core/function-search-path-repair.ts';
import { functionSearchPathProblems } from '../src/commands/doctor/checks/function-search-path.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);
afterAll(async () => { await engine?.disconnect(); });

test('v288 repairs a retained missing pin; head repair also sees another-GUC-only config', async () => {
  const identity = async () => engine.executeRaw(`SELECT prosrc, proowner, prosecdef FROM pg_proc WHERE oid='public.gbrain_clear_atom_page_state()'::regprocedure`);
  const original = await identity();
  await engine.executeRaw('ALTER FUNCTION public.gbrain_clear_atom_page_state() RESET search_path');
  expect((await functionSearchPathProblems(engine)).functions).toEqual(['gbrain_clear_atom_page_state()']);
  await engine.executeRaw("UPDATE config SET value='287' WHERE key='version'");
  expect(await runMigrations(engine)).toEqual({ applied: LATEST_VERSION - 287, current: LATEST_VERSION });
  expect(await functionSearchPathProblems(engine)).toEqual({ functions: [], fix: [] });
  await engine.executeRaw('ALTER FUNCTION public.gbrain_clear_atom_page_state() RESET search_path');
  await engine.executeRaw("ALTER FUNCTION public.gbrain_clear_atom_page_state() SET statement_timeout='7s'");
  expect((await functionSearchPathProblems(engine)).functions).toEqual(['gbrain_clear_atom_page_state()']);
  expect(await runMigrations(engine)).toEqual({ applied: 0, current: LATEST_VERSION });
  const [fn] = await engine.executeRaw<{ proconfig: string[] }>("SELECT proconfig FROM pg_proc WHERE oid='public.gbrain_clear_atom_page_state()'::regprocedure");
  expect(fn!.proconfig).toContain('statement_timeout=7s');
  expect(fn!.proconfig).toContain('search_path=pg_catalog, public, pg_temp');
  expect(await identity()).toEqual(original);
  await engine.executeRaw('ALTER FUNCTION public.gbrain_clear_atom_page_state() RESET statement_timeout');
}, 120_000);

test('unknown functions, same-name overloads and procedures retain their settings and bodies', async () => {
  await engine.executeRaw(`CREATE FUNCTION public.fork_app() RETURNS int LANGUAGE sql AS 'SELECT 1'`);
  await engine.executeRaw(`CREATE FUNCTION public.gbrain_clear_atom_page_state(text) RETURNS text LANGUAGE sql SET search_path=pg_catalog,public AS 'SELECT $1'`);
  await engine.executeRaw(`CREATE PROCEDURE public.fork_proc() LANGUAGE plpgsql AS 'BEGIN END'`);
  const read = () => engine.executeRaw(`SELECT oid::regprocedure::text, proconfig, prosrc, proowner, prosecdef FROM pg_proc
    WHERE oid IN ('public.fork_app()'::regprocedure, 'public.gbrain_clear_atom_page_state(text)'::regprocedure, 'public.fork_proc()'::regprocedure) ORDER BY 1`);
  const before = await read();
  await engine.executeRaw('ALTER FUNCTION public.gbrain_clear_atom_page_state() RESET search_path');
  expect(await convergeFunctionSearchPaths(engine, 'test')).toEqual([]);
  expect(await read()).toEqual(before);
  expect(await functionSearchPathProblems(engine)).toEqual({ functions: [], fix: [] });
  await engine.executeRaw('DROP FUNCTION public.fork_app()');
  await engine.executeRaw('DROP FUNCTION public.gbrain_clear_atom_page_state(text)');
  await engine.executeRaw('DROP PROCEDURE public.fork_proc()');
});

test('atom-state trigger resolves the public ledger despite a caller temporary shadow', async () => {
  const [page] = await engine.executeRaw<{ id: number }>(`INSERT INTO pages(slug,type,title,compiled_truth) VALUES('notes/path-shadow','note','shadow','x') RETURNING id`);
  await engine.executeRaw(`INSERT INTO extract_atoms_page_state(source_incarnation,page_id,content_hash)
    SELECT incarnation,$1,'original' FROM sources WHERE id='default'`, [page!.id]);
  await engine.executeRaw('CREATE TEMP TABLE extract_atoms_page_state (LIKE public.extract_atoms_page_state)');
  try {
    await engine.executeRaw('INSERT INTO pg_temp.extract_atoms_page_state SELECT * FROM public.extract_atoms_page_state WHERE page_id=$1', [page!.id]);
    await engine.executeRaw('UPDATE pages SET deleted_at=now() WHERE id=$1', [page!.id]);
    expect(await engine.executeRaw('SELECT page_id FROM public.extract_atoms_page_state WHERE page_id=$1', [page!.id])).toEqual([]);
    expect(await engine.executeRaw('SELECT page_id FROM pg_temp.extract_atoms_page_state WHERE page_id=$1', [page!.id])).toEqual([{ page_id: page!.id }]);
  } finally {
    await engine.executeRaw('DROP TABLE pg_temp.extract_atoms_page_state');
  }
});
