import { FACTS_DEFAULT_VISIBILITY_KEY } from '../facts/visibility.ts';
import { OperationError } from '../ops/contract.ts';
import { REMOTE_PRIVATE_PAGES_KEY, privatePagesFilterFragment } from '../search/private-visibility.ts';
import type { SqlEngine, WriteAuthority } from './model.ts';

/** Publication uses fresh policy, independent of the read-side telemetry cache. */
export async function excludesPrivateWrites(engine: SqlEngine, remote: boolean): Promise<boolean> {
  if (!remote || process.env.GBRAIN_REMOTE_PRIVATE_PAGES === '1') return false;
  // Fork world-only host: `facts.default_visibility=world` exposes every page,
  // matching resolveExcludePrivatePages on the read side.
  const rows = await engine.executeRaw<{ key: string; value: string }>(
    'SELECT key,value FROM config WHERE key = ANY($1::text[])', [[REMOTE_PRIVATE_PAGES_KEY, FACTS_DEFAULT_VISIBILITY_KEY]]);
  const value = (key: string) => rows.find(row => row.key === key)?.value?.trim().toLowerCase() ?? '';
  if (value(FACTS_DEFAULT_VISIBILITY_KEY) === 'world') return false;
  return !['visible', 'true', '1'].includes(value(REMOTE_PRIVATE_PAGES_KEY));
}

/** Recheck after page guards at publication; also hide inaccessible receipt targets. */
export async function authorizePageVisibility(engine: SqlEngine, authority: WriteAuthority, slug: string): Promise<void> {
  if (!authority.remote) return;
  if (!(authority.excludePrivate ?? true) && !await excludesPrivateWrites(engine, true)) return;
  const rows = await engine.executeRaw(`SELECT 1 FROM pages WHERE source_id=$1 AND slug=$2
    AND NOT (${privatePagesFilterFragment('pages')}) LIMIT 1`, [authority.sourceId, slug]);
  if (rows.length) throw new OperationError('page_not_found', 'Page not found.');
}
