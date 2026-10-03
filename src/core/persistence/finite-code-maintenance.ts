/** Bounded host code refresh: immutable manifest/file preimages, local authority,
 * and database-only publication through the durable writer coordinator. */
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
import { importCodeFile } from '../import-file.ts';
import { slugifyCodePath } from '../sync.ts';
import { CHUNKER_VERSION } from '../chunkers/code.ts';
import { PROPOSE_TAKES_ALLOWED_PAGE_TYPES } from '../cycle/propose-takes.ts';
import { sealPageTextProjection } from '../page-state/projections.ts';
import { sha256 } from './digest.ts';
import { maintenancePreflight, submitDatabaseMaintenanceIntent } from './prepared-maintenance.ts';
import type { PreparedMutation } from './coordinator.ts';
import type { PreparedContentImport } from './prepared-import.ts';
import type { WriteRequest } from './model.ts';

type Entry = { path: string; action: 'index' | 'tombstone'; expected_content_hash?: string; chunker_version?: number };
export interface FiniteCodeInput {
  sourceId: string; sourcePath: string; manifestPath: string; manifestHash: string;
  inputHash: string; expectedRevision: string | null; requestId?: string;
  runtimeHead?: string; runtimeSourceHash?: string;
}
interface FiniteCodeIntent extends Record<string, unknown> {
  kind: 'managed_maintenance_finite_code'; sourcePath: string; manifestPath: string;
  manifestHash: string; inputHash: string; expected_revision: string | null;
  runtimeHead: string; runtimeSourceHash: string;
}
const HEX = /^[a-f0-9]{64}$/;
function invalid(message: string): never { throw new OperationError('source_changed', message); }
export function finiteCodeRuntimeAttestation() {
  const core = resolve(import.meta.dir, '../../..');
  const head = execFileSync('git', ['-C', core, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const files = execFileSync('git', ['-C', core, 'ls-files', '-z', 'src'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  if (!files.length || files.length > 5000) invalid('The finite import runtime inventory is outside its bounds.');
  return { runtimeHead: head, runtimeSourceHash: sha256(JSON.stringify(files.map(path => [path, sha256(readFileSync(join(core, path)))]))) };
}
function attestRuntime(p: FiniteCodeIntent) {
  const current = finiteCodeRuntimeAttestation();
  if (current.runtimeHead !== p.runtimeHead || current.runtimeSourceHash !== p.runtimeSourceHash) invalid('The finite import runtime changed after review.');
}
function relativePath(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 512 && !isAbsolute(value) &&
    !/[\\\x00-\x1f\x7f]/.test(value) && /\.(ts|py)$/.test(value) &&
    value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}
function readRegular(path: string, max: number): Buffer {
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path) invalid('The finite import path is not canonical.');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const a = fstatSync(fd);
    if (!a.isFile() || a.size > max) invalid('The finite import exceeds its file bounds.');
    const bytes = readFileSync(fd), b = fstatSync(fd), final = lstatSync(path);
    const stamp = (value: ReturnType<typeof fstatSync>) =>
      [value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs].join(':');
    if (bytes.length !== a.size || stamp(a) !== stamp(b) || stamp(b) !== stamp(final) || realpathSync(path) !== path) {
      invalid('The finite import file changed during reading.');
    }
    return bytes;
  } finally { closeSync(fd); }
}
function absent(path: string): void {
  try { lstatSync(path); }
  catch (e: unknown) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
  invalid('The reviewed tombstone file still exists.');
}
function readTarget(p: FiniteCodeIntent, sourceId: string) {
  if (!relativePath(p.sourcePath) || !HEX.test(p.manifestHash) || !HEX.test(p.inputHash)) invalid('The finite import identity is incomplete.');
  const bytes = readRegular(p.manifestPath, 32768);
  if (sha256(bytes) !== p.manifestHash) invalid('The reviewed finite manifest changed.');
  const manifest = JSON.parse(bytes.toString('utf8'));
  if (![1, 2].includes(manifest?.version) || manifest.mode !== 'lexical_symbols' || manifest.enabled !== true ||
      !Array.isArray(manifest.sources) || !manifest.sources.length || manifest.sources.length > 3) invalid('The finite manifest is not admitted.');
  const ids = new Set<string>(); let count = 0, total = 0;
  let target: { entry: Entry; text: string | null; rawBytes: number } | undefined;
  for (const source of manifest.sources) {
    if (!source || typeof source.source_id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(source.source_id) ||
        ids.has(source.source_id) || typeof source.repo !== 'string' || !isAbsolute(source.repo) ||
        resolve(source.repo) !== source.repo || realpathSync(source.repo) !== source.repo ||
        !Array.isArray(source.files) || !source.files.length) invalid('The finite manifest source is invalid.');
    ids.add(source.source_id); const paths = new Set<string>();
    for (const entry of source.files as Entry[]) {
      if (!entry || !relativePath(entry.path) || paths.has(entry.path) || ++count > 13) invalid('The finite manifest file is invalid.');
      paths.add(entry.path);
      const file = join(source.repo, entry.path); let content: Buffer | null;
      // Validate every ancestor even for a tombstone; an absent child below a
      // symlink must not turn into an approved deletion of another coordinate.
      let ancestor = source.repo;
      for (const part of entry.path.split('/').slice(0, -1)) {
        ancestor = join(ancestor, part);
        try { if (!lstatSync(ancestor).isDirectory() || realpathSync(ancestor) !== ancestor) invalid('The finite path has an untrusted ancestor.'); }
        catch (e: unknown) { if (entry.action === 'tombstone' && (e as NodeJS.ErrnoException).code === 'ENOENT') break; throw e; }
      }
      if (entry.action === 'index') {
        if (entry.chunker_version !== CHUNKER_VERSION) invalid('The finite chunker version was not admitted.');
        content = readRegular(file, 131072); total += content.length;
        if (total > 1048576) invalid('The finite manifest exceeds its byte budget.');
      } else if (entry.action === 'tombstone' && typeof entry.expected_content_hash === 'string' && HEX.test(entry.expected_content_hash)) {
        absent(file); content = null;
      } else invalid('The finite manifest action is invalid.');
      if (source.source_id === sourceId && entry.path === p.sourcePath) {
        if ((content === null ? entry.expected_content_hash : sha256(content)) !== p.inputHash) invalid('The reviewed finite file hash changed.');
        target = { entry, text: content === null ? null : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content), rawBytes: content?.length ?? 0 };
      }
    }
  }
  if (!target) invalid('The requested file is outside the finite manifest.');
  return target;
}
async function assertTarget(engine: BrainEngine, sourceId: string, incarnation: string | undefined,
  slug: string, sourcePath: string, lock = false) {
  const [source] = await engine.executeRaw<{ id: string; incarnation: string; local_path: string | null; archived: boolean; config: Record<string, unknown> }>(
    `SELECT id,incarnation,local_path,archived,config FROM sources WHERE id=$1${lock ? ' FOR SHARE' : ''}`, [sourceId]);
  if (!source || source.local_path !== null || source.archived || source.config?.federated !== false || source.config.remote_url ||
      incarnation && source.incarnation !== incarnation) invalid('Finite refresh requires the same active, nonfederated, pathless source.');
  const page = await engine.getPage(slug, { sourceId, includeDeleted: true });
  const [kind] = await engine.executeRaw<{ page_kind: string }>('SELECT page_kind FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]);
  if (page && (kind?.page_kind !== 'code' || page.frontmatter?.file !== sourcePath ||
      PROPOSE_TAKES_ALLOWED_PAGE_TYPES.includes(page.type as never))) invalid('The finite page identity or taxonomy changed.');
  return page;
}

/** The host checks its canonical manifest location and exact CLI argument set.
 * This additional core fence survives retries, restarts and publication races. */
export async function publishFiniteCodeFile(engine: BrainEngine, input: FiniteCodeInput) {
  // Resolve local source-wide authority before opening any manifest or file.
  const authority = await maintenancePreflight(engine, input.sourceId);
  if (!authority || authority.binding || authority.writer.remote !== false || authority.writer.principal.kind !== 'local_cli') {
    throw new OperationError('writer_coordinator_required', 'Finite managed refresh requires database-only local CLI maintenance.');
  }
  const runtime = finiteCodeRuntimeAttestation();
  if (input.runtimeHead !== undefined && input.runtimeHead !== runtime.runtimeHead ||
      input.runtimeSourceHash !== undefined && input.runtimeSourceHash !== runtime.runtimeSourceHash) invalid('The finite import runtime changed after host review.');
  const p: FiniteCodeIntent = { kind: 'managed_maintenance_finite_code', sourcePath: input.sourcePath,
    manifestPath: input.manifestPath, manifestHash: input.manifestHash, inputHash: input.inputHash,
    expected_revision: input.expectedRevision, ...runtime };
  readTarget(p, input.sourceId);
  const slug = slugifyCodePath(input.sourcePath);
  await assertTarget(engine, input.sourceId, undefined, slug, input.sourcePath);
  return submitDatabaseMaintenanceIntent(engine, authority, slug, p, input.requestId ?? randomUUID());
}

export async function prepareFiniteCodeMutation(engine: BrainEngine, row: WriteRequest): Promise<PreparedMutation> {
  if (row.authority.remote !== false || row.principal_kind !== 'local_cli' || row.worktree_id || row.intent?.kind !== 'managed_maintenance_finite_code') {
    throw new OperationError('permission_denied', 'Finite code refresh requires trusted database-only local CLI authority.');
  }
  const p = row.intent as FiniteCodeIntent;
  attestRuntime(p);
  if (slugifyCodePath(p.sourcePath) !== row.slug) invalid('The finite path no longer names the accepted page.');
  const target = readTarget(p, row.source_id);
  const page = await assertTarget(engine, row.source_id, row.source_incarnation, row.slug, p.sourcePath);
  if ((page?.id ?? null) !== row.page_id || (page?.knowledge_revision ?? null) !== p.expected_revision) {
    throw new OperationError('revision_conflict', 'The finite page changed after admission.');
  }
  const validate = async (tx: BrainEngine) => {
    attestRuntime(p);
    readTarget(p, row.source_id);
    await assertTarget(tx, row.source_id, row.source_incarnation, row.slug, p.sourcePath, true);
  };
  if (target.entry.action === 'tombstone') {
    if (page && page.content_hash !== p.inputHash) invalid('The reviewed tombstone content hash changed.');
    return { observedRevision: p.expected_revision, noop: !page || !!page.deleted_at, deferEmbedding: true, validate,
      apply: async tx => {
        if (page && !page.deleted_at) await tx.softDeletePage(row.slug, { sourceId: row.source_id });
        readTarget(p, row.source_id);
        attestRuntime(p);
        return { ok: true, status: 'tombstoned', source_id: row.source_id, slug: row.slug, model_calls: 0, jobs_enqueued: 0 };
      } };
  }
  let ready: PreparedContentImport | undefined;
  await importCodeFile(engine, p.sourcePath, target.text!, { sourceId: row.source_id, noEmbed: true, force: true,
    prepare: async value => { ready = value; return value.result; } });
  if (!ready || ready.slug !== row.slug || ready.observedRevision !== p.expected_revision) invalid('The finite import could not be prepared against its accepted revision.');
  const prepared = ready;
  return { observedRevision: p.expected_revision, noop: false, deferEmbedding: true,
    validate: async tx => { await validate(tx); await prepared.validate(tx); }, apply: async tx => {
      await prepared.apply(tx);
      const marker = { atom_extract: false, code_chunker_version: CHUNKER_VERSION,
        embed_skip: { reason: 'finite_lexical_symbols', bytes: target.rawBytes } };
      await tx.executeRaw('UPDATE pages SET frontmatter=frontmatter || $3::text::jsonb WHERE source_id=$1 AND slug=$2', [row.source_id, row.slug, JSON.stringify(marker)]);
      await sealPageTextProjection(tx, row.slug, row.source_id);
      const after = await tx.getPage(row.slug, { sourceId: row.source_id });
      const [kind] = await tx.executeRaw<{ page_kind: string }>('SELECT page_kind FROM pages WHERE source_id=$1 AND slug=$2', [row.source_id, row.slug]);
      if (!after || kind?.page_kind !== 'code' || after.frontmatter?.file !== p.sourcePath ||
          after.frontmatter?.atom_extract !== false || (after.frontmatter?.embed_skip as Record<string, unknown> | undefined)?.reason !== 'finite_lexical_symbols' ||
          after.frontmatter?.code_chunker_version !== CHUNKER_VERSION ||
          after.compiled_truth !== target.text!.replaceAll('\0', '\\0') || page && after.type !== page.type) invalid('The finite publication readback did not match its admitted file.');
      if (target.rawBytes === 0 && (await tx.getChunks(row.slug, { sourceId: row.source_id })).length) invalid('An empty finite file retained stale chunks.');
      readTarget(p, row.source_id);
      attestRuntime(p);
      return { ok: true, status: target.rawBytes ? 'indexed' : 'empty_indexed', source_id: row.source_id,
        slug: row.slug, sha256: p.inputHash, chunker_version: CHUNKER_VERSION, model_calls: 0, jobs_enqueued: 0,
        source_path: null, mode: 'lexical_symbols', transaction: 'managed_single_file_atomic' };
    } };
}
