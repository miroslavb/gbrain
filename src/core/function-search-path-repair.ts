import type { BrainEngine } from './engine.ts';
import { FUNCTION_SEARCH_PATH_HARDENING_SQL, FUNCTION_SEARCH_PATH_PROBLEMS_SQL } from './function-search-path.ts';
import { migrationStatementTimeoutMs } from './migration-timeout.ts';
import { isLockTimeoutError } from './retry-matcher.ts';
import { resolveSchemaLockTimeoutMs, schemaLockBlockedError } from './postgres-engine/schema-lock-timeout.ts';

/** Forward and already-current repair; unlike the frozen v285 helper, missing settings are not skipped. */
export async function convergeFunctionSearchPaths(engine: BrainEngine, label: string): Promise<string[]> {
  const problems = async () => (await engine.executeRaw<{ sig: string }>(
    `${FUNCTION_SEARCH_PATH_PROBLEMS_SQL} ORDER BY 1`)).map(r => r.sig);
  if ((await problems()).length === 0) return [];
  const lockTimeoutMs = resolveSchemaLockTimeoutMs();
  try {
    await engine.transaction(async tx => {
      if (engine.kind === 'postgres') {
        await tx.executeRaw(`SET LOCAL statement_timeout = '${migrationStatementTimeoutMs()}'`);
        await tx.executeRaw(`SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`);
      }
      await tx.runMigration(288, FUNCTION_SEARCH_PATH_HARDENING_SQL);
    });
  } catch (error) {
    if (isLockTimeoutError(error)) throw schemaLockBlockedError({ step: `${label} search_path`, timeoutMs: lockTimeoutMs, sessions: null, sampledDuringWait: false });
    throw error;
  }
  const left = await problems();
  if (left.length > 0) {
    process.stderr.write(`  ${label}: ${left.length} function(s) left with missing or legacy search_path (${left.join(', ')}): `
      + 'ALTER FUNCTION needs the owner. Run gbrain doctor for the SQL to run as that role.\n');
  }
  return left;
}
