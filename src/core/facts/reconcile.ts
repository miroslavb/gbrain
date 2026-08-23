/**
 * Page-scoped fact-batch reconcile contract.
 *
 * Kept in a leaf module so both engines and the BrainEngine interface share one
 * shape without growing the size-ratcheted engine.ts façade.
 */
export interface FactPageReconcileOpts {
  slug: string;
  /** Delete only rows owned by these literal source prefixes. */
  includeSourcePrefixes?: string[];
  /** Preserve rows owned by these literal source prefixes while deleting the rest. */
  excludeSourcePrefixes?: string[];
  preserveExpiredLegacy?: boolean;
  /** Lock and recheck the source page inside the reconcile transaction. */
  expectedPage?: {
    contentHash: string | null;
    effectiveDate: Date | string | null;
  };
}

export interface FactBatchInsertOpts {
  deleteForPageFirst?: FactPageReconcileOpts;
  /**
   * Final source-of-truth check run after the page precondition is locked but
   * before any fact row is changed. Intended for sidecars outside the DB.
   */
  preCommitCheck?: () => void | Promise<void>;
  /** Final check after all row mutations but before the transaction commits. */
  postCommitCheck?: () => void | Promise<void>;
  /** Roll back the reconcile if any input row conflicts instead of skipping it. */
  requireAllRows?: boolean;
}

export function validateFactBatchReconcile(
  rows: readonly { source: string; source_markdown_slug: string }[],
  opts?: FactBatchInsertOpts,
): void {
  const reconcile = opts?.deleteForPageFirst;
  if (!reconcile) return;
  const included = reconcile.includeSourcePrefixes;
  const excluded = reconcile.excludeSourcePrefixes;
  if (included !== undefined && excluded !== undefined) {
    throw new Error('insertFacts: includeSourcePrefixes and excludeSourcePrefixes are mutually exclusive');
  }
  if (included?.some((prefix) => prefix.length === 0) || excluded?.some((prefix) => prefix.length === 0)) {
    throw new Error('insertFacts: source ownership prefixes must be non-empty');
  }
  if (rows.some((row) => row.source_markdown_slug !== reconcile.slug)) {
    throw new Error('insertFacts: reconcile slug must match every inserted row');
  }
  if (included !== undefined && rows.some((row) => !included.some((prefix) => row.source.startsWith(prefix)))) {
    throw new Error('insertFacts: reconcile source ownership does not include every inserted row');
  }
  if (excluded !== undefined && rows.some((row) => excluded.some((prefix) => row.source.startsWith(prefix)))) {
    throw new Error('insertFacts: reconcile source ownership excludes an inserted row');
  }
}
