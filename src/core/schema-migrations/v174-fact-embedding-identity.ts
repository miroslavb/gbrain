import type { Migration } from './types.ts';
import { MANAGED_WRITER_GUARD_SQL } from '../persistence/writer-guard-schema.ts';

export const v174: Migration = {
  version: 174, name: 'fact_embedding_identity', idempotent: true,
  sql: `ALTER TABLE facts ADD COLUMN IF NOT EXISTS embedding_model TEXT;
      ALTER TABLE facts ADD COLUMN IF NOT EXISTS embedded_text_hash TEXT;
      ${MANAGED_WRITER_GUARD_SQL}`,
};
