/** Source-layout path resolution, shared by Markdown writers and readers. */
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep as pathSep } from 'node:path';
import { resolveSlugForPath } from './sync.ts';

/**
 * Compute the on-disk path for a (brainDir, slug, source_id) tuple per
 * the v0.32.8 multi-source filing layout:
 *   - Default source: `<brainDir>/<slug>.md`
 *   - Non-default source: `<brainDir>/.sources/<source_id>/<slug>.md`
 *
 * Shared by the dream-cycle reverse-render (`reverseWriteRefs` in
 * synthesize.ts) and the v0.38 put_page write-through path so both
 * sites compute the same path for the same row.
 *
 * NOTE: caller is responsible for validating `source_id` against path-
 * traversal attacks via `validateSourceId` (src/core/utils.ts) BEFORE
 * passing it here. This helper does the filename math only.
 */
export function resolvePageFilePath(
  brainDir: string,
  slug: string,
  sourceId: string,
): string {
  return sourceId === 'default'
    ? join(brainDir, `${slug}.md`)
    : join(brainDir, '.sources', sourceId, `${slug}.md`);
}

/**
 * Map a git-root-relative `pages.source_path` into a source's `local_path`.
 *
 * Scoped syncs keep `source_path` relative to the Git root even when
 * `sources.local_path` points at a subdirectory. A direct join duplicates the
 * scope (`.../public/changelog/public/changelog/...`). Find the same Git root
 * sync uses without spawning a subprocess, then remove that exact scope.
 * Non-Git vaults and Git-root local paths keep the direct path. Under
 * `slugRootMode: 'source-root'` the stored path is already source-relative, so
 * the scope is removed only from the legacy Git-root form write-through minted
 * from the slug (its scope-stripped path names `pageSlug`, #5610). Historical
 * rows may carry a basename-relative `source_path`; when the direct path is
 * absent and the caller provides the page slug, resolve that spelling under
 * the slug's directory before reporting the file as missing.
 *
 * Returns null for an unsafe or non-markdown source path. Callers must still
 * enforce their normal realpath containment check before a write.
 *
 * Segment splitting is platform-aware (`pathSep`), not a blanket
 * `[\\/]+` split: on POSIX, `\` is a legal filename character (real
 * gbrain data has Apple Notes titles containing one), not a directory
 * separator, so splitting on it there reconstructs a path that doesn't
 * exist on disk even though the file does (issue: undeclared_db_only_pages
 * false positive + silent restore/export failure for any such file). On
 * Windows, `\` is the real separator, so it still needs to split there.
 */
function splitLocalPathSegments(value: string): string[] {
  return (pathSep === '\\' ? value.split(/[\\/]+/) : value.split(/\/+/)).filter(Boolean);
}

function safeSlugDirSegments(rawSlug: string | null | undefined): string[] | null {
  if (!rawSlug) return null;
  const value = rawSlug.trim();
  if (!value || value.includes('\0') || isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) return null;
  const segments = splitLocalPathSegments(value);
  if (segments.length === 0 || segments.some(segment => segment === '..')) return null;
  return segments.slice(0, -1);
}

/**
 * The segments of `localPath` below its nearest ancestor holding `.git` (`[]`
 * when `localPath` is that Git root), or null when no ancestor holds one. A
 * caller resolving many pages of one source computes it once and passes it to
 * `resolveSourceLocalFilePath` as `gitScope`.
 */
export function sourceGitScope(localPath: string): string[] | null {
  const absoluteLocalPath = resolve(localPath);
  for (let cursor = absoluteLocalPath; ; cursor = dirname(cursor)) {
    if (existsSync(join(cursor, '.git'))) return splitLocalPathSegments(relative(cursor, absoluteLocalPath));
    if (dirname(cursor) === cursor) return null;
  }
}

export function resolveSourceLocalFilePath(localPath: string, rawSourcePath: string | null | undefined, pageSlug?: string | null, slugRootMode?: 'git-root' | 'source-root', gitScope?: string[] | null): string | null {
  return rawSourcePath && /\.mdx?$/i.test(rawSourcePath.trim()) ? resolveRecordedSourceFilePath(localPath, rawSourcePath, pageSlug, slugRootMode, gitScope) : null;
}
/** #7736: `resolveSourceLocalFilePath` for a recorded path of any extension (a code or image page records its own file, `decisions.json`):
 * the same placement, or null when the path cannot name a file inside the source (absolute, `..`, NUL, empty). */
export function resolveRecordedSourceFilePath(localPath: string, rawSourcePath: string | null | undefined, pageSlug?: string | null, slugRootMode?: 'git-root' | 'source-root', gitScope?: string[] | null): string | null {
  if (!rawSourcePath) return null;
  const value = rawSourcePath.trim();
  if (!value || value.includes('\0')) return null;
  if (isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) return null;
  const sourceSegments = splitLocalPathSegments(value);
  if (sourceSegments.length === 0 || sourceSegments.some(segment => segment === '..')) return null;

  const absoluteLocalPath = resolve(localPath);
  let sourceScopeSegments: string[] = [];
  let resolvedSegments = sourceSegments;
  const scope = gitScope === undefined ? sourceGitScope(localPath) : gitScope;
  if (scope) {
    sourceScopeSegments = scope;
    const scoped = scope.length > 0 && scope.every((segment, index) => segment === sourceSegments[index]);
    if (scoped && (slugRootMode !== 'source-root'
      || !!pageSlug && resolveSlugForPath(sourceSegments.slice(scope.length).join('/')) === pageSlug)) {
      resolvedSegments = sourceSegments.slice(scope.length);
    }
  }
  const directPath = join(absoluteLocalPath, ...resolvedSegments);
  if (existsSync(directPath)) return directPath;

  const slugDirSegments = safeSlugDirSegments(pageSlug);
  if (sourceSegments.length === 1 && slugDirSegments && slugDirSegments.length > 0) {
    const scopedSlugDir =
      slugRootMode !== 'source-root' && sourceScopeSegments.length > 0 &&
      sourceScopeSegments.every((segment, index) => segment === slugDirSegments[index])
        ? slugDirSegments.slice(sourceScopeSegments.length)
        : slugDirSegments;
    const slugRelativePath = join(absoluteLocalPath, ...scopedSlugDir, ...sourceSegments);
    if (existsSync(slugRelativePath)) return slugRelativePath;
  }

  return directPath;
}

/**
 * A `file://` URI whose authority is neither empty, `localhost` nor a Windows
 * drive (`file://C:/...`): the relative path an older file capture stored
 * as typed (#5622), or a host-only alias. It names no local file, so readers treat it as absent.
 */
export function isRelativeFileUri(sourceUri: string | null | undefined): boolean {
  return typeof sourceUri === 'string' && /^file:\/\/(?!\/|localhost\/|[A-Za-z]:[\\/])/i.test(sourceUri);
}
