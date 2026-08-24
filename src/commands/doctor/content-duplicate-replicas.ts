/** Exact duplicate contours intentionally materialized more than once. */
export type DuplicateReplicaClass =
  | 'dependency_tree'
  | 'skill_distribution'
  | 'golden_fixture'
  | 'locale_shadow'
  | 'parallel_backend_reference';

const skillRoot = /^(?:skills|plugin\/skills|plugin-variants\/[^/]+\/skills)\//;

export function classifyDuplicateReplicaGroup(slugs: string[]): DuplicateReplicaClass | null {
  if (slugs.length < 2) return null;
  if (slugs.every((slug) => /(^|\/)(?:\.venv|venv|embedding-venv)(\/|$)/.test(slug))) {
    return 'dependency_tree';
  }
  if (slugs.every((slug) => skillRoot.test(slug))) {
    const suffixes = slugs.map((slug) => slug.replace(skillRoot, ''));
    if (new Set(suffixes).size === 1) return 'skill_distribution';
  }
  if (slugs.some((slug) => slug.startsWith('test/fixtures/golden/')) &&
      slugs.some((slug) => !slug.startsWith('test/fixtures/golden/'))) return 'golden_fixture';
  const localeNormalized = slugs.map((slug) => slug.replace(/^docs\/ru\//, 'docs/'));
  if (slugs.some((slug) => slug.startsWith('docs/ru/')) && new Set(localeNormalized).size === 1) {
    return 'locale_shadow';
  }
  if (slugs.every((slug) => /^skills\/mlops\/inference\/(?:gguf|llama-cpp)\/references\//.test(slug))) {
    return 'parallel_backend_reference';
  }
  return null;
}
