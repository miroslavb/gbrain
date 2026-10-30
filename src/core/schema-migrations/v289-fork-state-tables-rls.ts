import type { Migration } from './types.ts';
import { protectTables } from './v283-rls-backfill-unguarded-tables.ts';

// Fork-only tables are absent from v283's frozen upstream inventory. Cover both
// fresh installs without the auto-RLS event trigger and migration-only upgrades.
// Reuse the owner/BYPASSRLS, exemption, public/search-path and timeout guards;
// enable only, with no FORCE, policies, grants, row changes or ownership changes.
export const v289: Migration = {
  version: 289,
  name: 'fork_state_tables_rls',
  idempotent: true,
  transaction: false,
  sql: '',
  handler: async engine => {
    await protectTables(engine, ['proposal_page_runs', 'extract_health_state'], 'v289');
  },
};
