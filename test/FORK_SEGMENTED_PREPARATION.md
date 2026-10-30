# Segmented-page preparation checks

The host keeps `pages.segmented_storage` off by default. Tests that deliberately
exercise segmented upload and CLI writes opt in only inside their disposable
database. This does not enable the feature on production or change its default.
The Chronicle eligibility fixture supplies the same priced model used by the
native backfill budget test; the fail-closed pricing guard remains intact.

## Visibility fixture interpretation

The host's established single-principal policy makes legacy fact visibility
world-only. Source grants, document ACLs, credential redaction, takes hiding and
withdrawal/purge/hold ledgers remain separate controls. See
[the fork visibility contract](../docs/architecture/key-files/fork-memory-contracts.md#host-visibility-invariant).

The upstream `segmented-privacy-fixture.ts` passes two fact sentinels with
`visibility: private` to `renderFactsTable`. This fork's canonical renderer
serializes those rows as `world`; treating those resulting rows as secret would
test a policy this host does not implement. The scoped remote `get_page` test
therefore classifies exactly those two fact sentinels as host-shared, while
retaining every other forbidden-token assertion. Complete read and markdown
cursor walks must positively expose the ordinary shared fact, so an empty
response cannot pass. Large fences crossing segment cuts can still be omitted
conservatively; the test does not promise full visibility of unsupported blocks.

A separate case constructs an actual raw legacy `private` cell without the
renderer, verifies that cell in stored segment bytes, then verifies shared reads
in both complete views. An out-of-grant source request must still refuse with
`permission_denied`. Other source/document authorization tests and the shared
fixture helper are unchanged.

## Explicit remaining capability limits

The facts-absorb handler still refuses delta extraction when its previous page
snapshot is segmented. The explicit refusal oracle keeps the initial positive
new-page extraction, then requires `page_body_segmented`, zero further model
calls and unchanged page revision/hash, existing fact, receipts, effects and
logs after append. The guard must not be removed or turned into a full-page
fallback merely to satisfy an upstream append-extraction test. Append extraction
requires a separately reviewed implementation; this test does not claim it works.

## Upload replacement policy cases

The earlier upload receipt with eight passes and one failure remains historical
evidence: its combined protection test tried to create a private fact, which the
host rejects before any upload. The reconciled suite makes each policy explicit:

- A private `remember` request returns `invalid_params`, without changing the
  page, its facts, write receipts or upload reservations.
- Raw legacy `private` cells are stored and read back in both inline and
  segmented fixtures. Native remote reads expose the shared claim, and a large
  explicit replacement still carries the same fact as `world`. Its facts fence
  triggers the existing `request_too_large` whole-body normalization/withdrawal
  guard in `page-body/streamed-import.ts`; this is independent of visibility.
  Both layouts require an unpublished terminal failed receipt, exact original
  page revision/hash/raw bytes/facts and released reservations. No fact is omitted
  from the replacement to manufacture success. Positive large uploads without
  protected fences remain covered by the original exact-body/hash tests.
- Takes and timeline rows still refuse `upload_protected_content`. Malformed
  facts fences exercise the facts refusal in both storage layouts. Each refusal
  preserves the page revision, hash and raw body, and releases reserved bytes.
- An out-of-grant large upload refuses before staging or reserving anything.

These are test-only changes; the runtime policy and shared privacy fixtures are
unchanged. The separate remote read tests retain takes, credential, truncated
tail, withdrawal, purge, hold and source-denial oracles. Cross-segment omission
and the segmented prior-snapshot extraction limitation above still apply. The
first continuation-2 run (13 passes, two failures) preserved the incorrect
assumption that a world facts fence could bypass the whole-body limit; its
receipt remains negative evidence. The revised oracle preserves that limit,
and does not qualify arbitrary large fenced writes or enable segmentation.

An `ENOSPC` in the interrupted combined run is resource evidence, not proof of a
segmented storage defect. Re-run the file in an isolated scratch environment
before changing any assertions or increasing memory limits.
