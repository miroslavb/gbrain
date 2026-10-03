import type { Migration } from './types.ts';
import { MANAGED_WRITER_GUARD_SQL } from '../persistence/writer-guard-schema.ts';

export const v164: Migration = { version: 164, name: 'managed_alias_and_source_checkpoint_guards', idempotent: true, sql: MANAGED_WRITER_GUARD_SQL };
