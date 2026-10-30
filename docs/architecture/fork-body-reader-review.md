# Fork reader inventory at the v0.60.502 preparation boundary

Reviewed 2026-10-30 against preparation checkpoint `f61d06dba066`.
This is an explicit inventory reconciliation for existing fork paths and a
behavior-preserving helper extraction. It is not permission to grow reader
baselines during ordinary development. The native scanner implementations and
their negative fixtures remain unchanged. Production remains outside this
preparation checkout; these results do not establish deployment readiness.

`INLINE` records an inline-only or explicitly materialized string path.
`SEGW` records a writer that refuses segmented storage until it uses the segment
writer. `NONE` is only a name collision with a non-body value. The feature being
off by default is not evidence for any of these entries: refusal and reporting
must also hold with `pages.segmented_storage=on`.

## Reader entries

Each row below corresponds to an exact path/unit/kind key in
`scripts/page-body-readers-baseline.tsv`. Paths are relative to `src/`.

| Path and unit | Kind / action | Current behavior and reason | Evidence |
| --- | --- | --- | --- |
| `commands/doctor/checks/content-quality.ts` / `runQuarantine` | sql / INLINE | SQL CASE evaluates the managed-fence marker only for inline pages. Segmented pages are not classified from NULL: the result reports `skipped_segmented`, an explicit inventory reason, and warn status. Query failure also warns. The existing inline classifier policy is retained. | `fork-body-reader-inventory.test.ts` doctor cases; `content-health.test.ts` |
| `core/cycle/atom-completion-receipt.ts` / `finalizeAtomCompletionReceipt` | call:contentHash / INLINE | Native `assertInlineBody` precedes the changed completion receipt's canonical hash. Stored `content_hash` cannot replace a hash of the updated receipt. Refusal leaves pending state intact. | `extraction-page-body-safety.test.ts`; extraction worker review |
| Same unit | sql / SEGW | Origin and output preflights reject segmented pages; publication predicates require inline storage together with pinned identity, source, revision and body evidence. | Same real PGLite completion regressions |
| `core/facts/delta.ts` / `readPriorBody` | field / INLINE | Source-exact page, then `assertInlineBody`. `page_body_segmented` is rethrown, so no full-extraction fallback follows an unread body. | `fork-body-reader-inventory.test.ts` real live page; `facts-page-origin-guard.test.ts` sentinel case |
| `core/facts/delta.ts` / `readLastSnapshotBody` | sql / INLINE | Reads only the latest source-exact version, including its storage class. The native assertion rejects a segmented NULL before it can become empty prior content. | `fork-body-reader-inventory.test.ts` retained segmented version and inline source twin |
| Same unit | field / INLINE | Same assertion precedes body use; segmented refusal escapes the legacy read-error fallback. | Same version test |
| `core/facts/page-projection.ts` / `factPageProjection` | field / INLINE | Parses caller-provided Markdown into strings; does not load a stored page. The publication helper separately guards the target. This entry does not claim an independent input-size bound. | `fact-page-projection.test.ts`; origin/projection regressions |
| `core/facts/page-projection.ts` / `projectFactPageBody` | sql / SEGW | Native origin guard, stored-row lock and `assertInlineBody` precede UPSERT; its conflict branch additionally excludes segmented storage. Failure rolls back the fact transaction. | `facts-page-origin-guard.test.ts` segmented target and competing-origin rollback; projection contract suite |
| Same unit | field / SEGW | Values are parsed input strings. The locked target assertion, not a string sentinel or feature default, prevents replacement of stored segments. | Same projection tests |
| `core/persistence/finite-code-maintenance.ts` / `prepareFiniteCodeMutation` | field / INLINE | `assertTarget` rejects segmented storage before preparation and again in publication. Code input is a manifest-listed file, at most 128 KiB, within 13 files / 3 sources / 1 MiB total. Readback checks exact admitted bytes. | `persistence-finite-code.test.ts`, including refusal before journal admission |
| `core/persistence/reconcile-state.ts` / `readReconcileState` | field / INLINE | World-only fence projection reads parsed canonical file strings after the existing journal-size admission. The database snapshot comes through native `wholeBodySnapshot`: materialize up to 24 MiB, refuse larger metadata before segment reads. | `fork-body-reader-inventory.test.ts` small materialization and over-ceiling refusal with zero segment reads / unchanged file |
| `core/take-proposals.ts` / `listPendingProposals` | field / INLINE | Source-exact native snapshot plus `assertInlineBody` before full evidence and body-only SHA256. Prefixes or a canonical hash would change the proof. | `extraction-page-body-safety.test.ts`; extraction worker review |
| `core/take-proposals.ts` / `assertProposalSnapshotCurrent` | field / INLINE | Same source-exact snapshot assertion before body identity checks. Acceptance checks before CAS; promotion rechecks the revision. | Same proposal regressions |
| `core/sweep.ts` / `runManagedLinksTimelinePass` | field / NONE | `managed.timeline` is the numeric count of extracted timeline entries, not a page body. It was moved unchanged out of `runLinksTimelinePass` during the bounded helper extraction. The original function's real body-reader entry remains. | Direct before/after diff and typed managed result; native scanner test |

The existing `readReconcileState` SQL row now documents the same native
materialization ceiling. Its raw stored-row fields are an audit preimage, not
a fallback body; segmented NULLs are not used as empty content for the merge.
No runtime changes were needed in delta, projection, finite-code or reconcile:
their guards were already present in the preparation checkpoint.

Two migration rows follow the reviewed filename mapping only:
`v189-pages-credential-projection-pending` / `v189` becomes the already-applied
fork `v197` path/unit, and `v248-segmented-page-storage` / `COMMON_SQL` becomes
`v256` / `COMMON_SQL`. Historical migration code is unchanged. The first is
an inline-era migration; the second is storage DDL, neither a live body reader.
The stale `sameContentAnyKeyOrder` field row is removed: its body accesses moved
to `canonicalFields`, whose existing row is retained.

## Canonical deletion and chunk residue

The one finite-code soft-delete site is classified `canonical`, ceiling 1.
It applies an explicit local CLI manifest tombstone to a missing canonical code
file, with exact prior hash/revision, source grants, source incarnation and
native core guard rechecked in the publication transaction. It is not an
automatic derived-item retirement. The finite-code suite checks tombstone
replay, wrong preimages, explicit recreation, remote refusal, source/path
constraints, native budget refusal and rollback after a file race.

`countDeletedPageNullChunks` intentionally counts every generation of NULL
vector residue on deleted pages, excluding `embed_skip` by key existence.
It is a storage census, not retrieval or embedding selection. Its native
`chunk-visibility-ok` marker was moved immediately above the SQL literal so the
unchanged scanner recognizes it. The chunk-visibility baseline is unchanged.
The real generation fixture proves current, staged and retired rows are all
counted after deletion, live pages are excluded, and `embed_skip: false` still
excludes the page under the existing key-existence contract.

## Verification and limits

All execution used the preparation container: no network, nonroot UID 65534,
no capabilities, read-only candidate/dependencies, disposable source snapshot,
3 GiB memory with no additional swap, and synthetic PGLite databases.

- 27 regression cases passed across projection, origin, finite-code, deleted
  residue and pure content classifiers. That first batch also reported one
  test-file load error because the disposable copy omitted LICENSE; the runner
  was corrected and the previously unloaded cases all passed below.
- Final batch: 18 passed, 0 failed (5 new real-storage cases plus 13 native
  scanner unit cases), 74 assertions.
- Native page-body guard: PASS, 648 reviewed rows. Derived census: PASS,
  26 reviewed rows. Chunk visibility: PASS, 88 covered / 84 unchanged baselined
  sites. Derived-census good fixture passed; each of its three bad fixtures
  failed as required.

Host receipts: `/root/ops/gbrain-upgrade-prep-20261030/continuation-1/`:
`facts-inventory-first.log`, `facts-inventory-second.log`, and
`facts-inventory-final.log`. These bounded tests do not replace the restored
PostgreSQL migration, full verification, retrieval or production cutover gates.
