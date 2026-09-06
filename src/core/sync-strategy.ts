import type { BrainEngine } from './engine.ts';
import type { SyncStrategy } from './sync.ts';
import { parseSourceConfig } from './sources-load.ts';

function checkedStrategy(value: unknown, origin: string): SyncStrategy | undefined {
  if (value === undefined || value === 'markdown' || value === 'code' || value === 'auto') return value;
  throw new Error(`Invalid sync strategy (${origin}): expected markdown, code or auto.`);
}

/** An explicit scope wins; absent flags inherit only the selected source. */
export function selectSyncStrategy(explicit: unknown, sourceConfig: unknown): SyncStrategy {
  const override = checkedStrategy(explicit, '--strategy');
  if (override !== undefined) return override;
  // Match existing config readers so legacy scalar/array shapes can reach
  // sync's heal-on-write path. A recovered strategy still requires validation.
  const config = parseSourceConfig(sourceConfig);
  return checkedStrategy(config.strategy, 'source config') ?? 'markdown';
}

/** Preserve missing versus explicitly malformed CLI flags, including bare flags. */
export function parseSyncStrategyArg(args: string[]): SyncStrategy | undefined {
  const index = args.indexOf('--strategy');
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined) throw new Error('--strategy requires markdown, code or auto.');
  return checkedStrategy(value, '--strategy');
}

/** Shared entry for CLI, delegated sync, workers and direct library callers. */
export async function resolveSyncStrategy(
  engine: Pick<BrainEngine, 'executeRaw'>, explicit: unknown, sourceId = 'default',
): Promise<SyncStrategy> {
  const override = checkedStrategy(explicit, '--strategy');
  if (override !== undefined) return override;
  const rows = await engine.executeRaw<{ config: unknown }>(
    'SELECT config FROM sources WHERE id = $1', [sourceId],
  );
  return selectSyncStrategy(undefined, rows[0]?.config);
}
