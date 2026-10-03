import type { Migration } from './types.ts';
import { PERSISTENCE_EFFECT_PARKED_INDEX_SQL } from '../persistence/effect-schema.ts';
import { dropInvalidConcurrentIndex } from './helpers.ts';

export const v178: Migration = {
  version: 178, name: 'index_parked_persistence_effects', idempotent: true, transaction: false, sql: '',
  handler: async engine => {
    if (engine.kind === 'postgres') await dropInvalidConcurrentIndex(engine, 178, 'persistence_effects_parked');
    await engine.runMigration(178, engine.kind === 'postgres'
      ? PERSISTENCE_EFFECT_PARKED_INDEX_SQL.replace('CREATE INDEX', 'CREATE INDEX CONCURRENTLY')
      : PERSISTENCE_EFFECT_PARKED_INDEX_SQL);
  },
};
