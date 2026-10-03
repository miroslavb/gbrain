import type { Migration } from './types.ts';
import { PERSISTENCE_EFFECT_SCHEMA_SQL } from '../persistence/effect-schema.ts';

export const v163: Migration = { version: 163, name: 'recoverable_postcommit_persistence_effects', idempotent: true, sql: PERSISTENCE_EFFECT_SCHEMA_SQL };
