import type { Migration } from './types.ts';
import { DECIDE_CALIBRATIONS_SCHEMA_SQL } from '../ai/decide/schema.ts';

// System One decide: calibration and qualification rows keyed by
// (slot, call site, provider, resolved model); DDL in src/core/ai/decide/schema.ts.
export const v193: Migration = {
  version: 193,
  name: 'decide_calibrations',
  idempotent: true,
  sql: DECIDE_CALIBRATIONS_SCHEMA_SQL,
};
