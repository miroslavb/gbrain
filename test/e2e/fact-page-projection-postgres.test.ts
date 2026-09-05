import { beforeAll, afterAll, describe } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { factPageContract } from '../helpers/fact-page-contract.ts';
const url = process.env.DATABASE_URL;
describe.skipIf(!url)('fact page projection PostgreSQL', () => {
  const engine = new PostgresEngine();
  beforeAll(async () => {
    assertSafeE2eDatabaseUrl(url!);
    await engine.connect({ database_url: url! }); await engine.initSchema();
  });
  afterAll(async () => { await engine.disconnect(); });
  factPageContract(() => engine);
});
