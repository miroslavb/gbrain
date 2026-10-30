/** Test-only provenance gate for immutable upstream SQL dumps. Never imported by production. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import manifest from '../fixtures/schema-history-fork-manifest.json';

export type SchemaHistoryEngine = 'pglite' | 'postgres';
export const SCHEMA_HISTORY_UPSTREAM = 'f48cc461965af08581be7cec7b66a1a67c4839af';
export const schemaHistoryForkManifest = manifest;
const ROOT = resolve(import.meta.dir, '..', '..');
export const historySha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export function historyRefuse(reason: string): never { throw new Error(`schema-history fixture refused: ${reason}`); }

export function verifiedSchemaHistoryFixture(engine: SchemaHistoryEngine, version: number, bytes?: Uint8Array) {
  if (manifest.formatVersion !== 1 || manifest.upstreamCommit !== SCHEMA_HISTORY_UPSTREAM) historyRefuse('unknown manifest provenance');
  const metadata = manifest.fixtures.find(entry => entry.engine === engine && entry.upstreamVersion === version);
  if (!metadata || metadata.forkVersion !== version + 8) historyRefuse(`unlisted ${engine} v${version}`);
  const raw = bytes ?? readFileSync(resolve(ROOT, 'test/fixtures/schema-history', engine, `v${version}.sql.gz`));
  if (historySha256(raw) !== metadata.sha256) historyRefuse(`hash mismatch for ${engine} v${version}`);
  const sql = Buffer.from(Bun.gunzipSync(Buffer.from(raw))).toString('utf8');
  if (!sql.startsWith(`-- gbrain schema-history fixture: a fresh brain at schema v${version}.\n`)) historyRefuse('wrong fixture header');
  const tables = [...sql.matchAll(/^CREATE (?:UNLOGGED )?TABLE "([^"\n]+)" \(/gm)].map(match => match[1]).sort();
  if (tables.length !== metadata.tableCount || new Set(tables).size !== tables.length) historyRefuse('table inventory mismatch');
  const seeds = new Map<string, unknown[]>();
  for (const match of sql.matchAll(/json_populate_recordset\(NULL::"([^"\n]+)", \$gbrain_fixture\$([\s\S]*?)\$gbrain_fixture\$\)/g)) {
    const rows: unknown = JSON.parse(match[2]);
    if (!Array.isArray(rows) || seeds.has(match[1]) || !tables.includes(match[1])) historyRefuse('unexpected fixture seed');
    seeds.set(match[1], rows);
  }
  const counts = Object.fromEntries([...seeds].sort(([a], [b]) => a.localeCompare(b)).map(([table, rows]) => [table, rows.length]));
  if (JSON.stringify(counts) !== JSON.stringify(metadata.seedCounts)) historyRefuse('seed inventory mismatch');
  const stamps = (seeds.get('config') ?? []).filter((row: any) => row.key === 'version') as Array<{ value: string }>;
  if (stamps.length !== 1 || stamps[0].value !== String(version)) historyRefuse('wrong embedded version');
  return { metadata, sql, tables, seeds };
}

export function verifyForkOverlayFiles(): void {
  for (const overlay of manifest.forkOverlays) {
    if (historySha256(readFileSync(resolve(ROOT, overlay.path))) !== overlay.sha256) historyRefuse(`fork migration file changed: ${overlay.path}`);
  }
}
