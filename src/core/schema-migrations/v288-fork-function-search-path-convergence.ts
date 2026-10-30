import type { Migration } from './types.ts';
import { convergeFunctionSearchPaths } from '../function-search-path-repair.ts';

// Forward convergence for missing settings after initial migration (v219 already repairs the retained v171 trigger).
// v285's legacy-only preflight cannot see later NULL/empty proconfig. Keep every historical module unchanged.
export const v288: Migration = {
  version: 288,
  name: 'fork_function_search_path_convergence',
  idempotent: true,
  transaction: false,
  sql: '',
  handler: async engine => { await convergeFunctionSearchPaths(engine, 'v288'); },
};
