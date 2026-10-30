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

The upload replacement suite also contains upstream assumptions about creating
and hiding private facts. A `remember` request for private visibility is refused
by this host. An upload opt-in alone does not reconcile that separate test-policy
conflict; retain its failed receipt until the intended host behavior is reviewed.

An `ENOSPC` in the interrupted combined run is resource evidence, not proof of a
segmented storage defect. Re-run the file in an isolated scratch environment
before changing any assertions or increasing memory limits.
