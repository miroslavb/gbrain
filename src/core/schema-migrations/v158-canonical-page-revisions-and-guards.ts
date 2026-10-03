import type { Migration } from './types.ts';
import { PAGE_STATE_SCHEMA_SQL } from '../page-state/schema.ts';

export const v158: Migration = { version: 158, name: 'canonical_page_revisions_and_guards', idempotent: true, sql: PAGE_STATE_SCHEMA_SQL };
