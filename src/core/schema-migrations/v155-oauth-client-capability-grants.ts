import type { Migration } from './types.ts';
import { repairLegacyClientGrants } from '../grants/migration.ts';
import { GRANT_AUDIT_SCHEMA_SQL, GRANT_COLUMNS_SQL, GRANT_SPEND_COLUMNS_SQL } from '../grants/schema.ts';

export const v155: Migration = {
  version: 155,
  name: 'oauth_client_capability_grants',
  sql: GRANT_COLUMNS_SQL + GRANT_AUDIT_SCHEMA_SQL + GRANT_SPEND_COLUMNS_SQL,
  handler: repairLegacyClientGrants,
};
