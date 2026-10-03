import type { Migration } from './types.ts';
import { PAGE_VERSION_DELETION_SCHEMA_SQL } from '../page-state/schema.ts';

export const v166: Migration = { version: 166, name: 'canonical_version_deletion_state', idempotent: true, sql: PAGE_VERSION_DELETION_SCHEMA_SQL };
