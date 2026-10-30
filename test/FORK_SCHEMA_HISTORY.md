# Upstream history fixtures in the host fork

The 32 compressed SQL fixtures under `fixtures/schema-history/` remain byte for
byte identical to upstream commit `f48cc461965af08581be7cec7b66a1a67c4839af`.
They are fresh **upstream** schemas 260–275, not snapshots of past host-fork
releases. Their gzip SHA256 values and exact seed-table counts are pinned in
`fixtures/schema-history-fork-manifest.json`.

`helpers/schema-history-fork-adapter.ts` is a test-only bridge. It runs after
restoring an original fixture into a cold disposable database and before
native `initSchema`. It has no production import or CLI entry point.

1. Verify the gzip hash, upstream provenance, header, embedded version, table
   inventory and seed inventory. Unknown versions and engine-label mismatches
   refuse. The eight actual fork migration files are SHA256-pinned too.
2. Inside one transaction, require the expected restored version and exact
   table set. Require every table's exact row count. Compare each seeded
   table's full typed row multiset with the original dump through
   `json_populate_recordset` and `EXCEPT ALL`; every other table must be empty.
   There is no generic nonempty-table exemption or permission to convert user
   data. A private fact or a same-count changed source row refuses.
3. Run the actual SQL and handler for fork migrations 141–147 and 152, in
   order. Each native verify hook must return true. Migration 142 retains its
   nested transaction; a fault-injection test proves that a later refusal
   rolls its real DDL back with the outer transaction.
4. Require all eight verify hooks again, the exact proposal evidence columns,
   JSONB-object constraint, receipt/health tables, NULLS NOT DISTINCT link
   identity, and world defaults/configuration. PostgreSQL explicitly enables
   and checks RLS on the two new fork tables, without FORCE or added policies.
5. Only then conditionally change the original version U to U+8 (268–283).
   This stamp represents the shared upstream schema plus the verified fork
   overlays. It does not claim that native later migrations already ran.
6. Assert the exact pending migration names/versions from the pinned mapping,
   including forward fork migration 288; expected count is 280−U. Call native
   `initSchema`, compare its full catalog and function settings with a fresh
   fork install, run native migrations again and require zero applied, then
   compare the catalog again.

No historical migration module, compressed fixture, catalog golden, catalog
normalizer or production migration runner is altered by this adapter. Future
fixtures or migration tails require an explicit manifest review; assertions
must not be loosened to accept a new lineage.

Verified 2026-10-30 in the network-isolated 3 GiB preparation container:

- Adapter: 7/7 cases, 57 assertions. Covers hashes, mislabeled metadata,
  wrong restored version, nonempty canonical corpus, changed service row,
  rollback after native verify failure, and successful eight-overlay stamping.
- All 16 PGLite histories plus existing drift-detector tests: 25/25 cases,
  80 assertions. Each history reached 288, matched the fresh catalog and
  repeated with zero migrations. Existing strict function-setting comparison
  remains unchanged.

The first history run rejected four incorrectly extracted manifest names
(index-descriptor names rather than exported migration names). The manifest
was corrected from the pinned upstream migration exports; exact assertions
were retained and the whole history run passed. Logs remain in
`/root/ops/gbrain-upgrade-prep-20261030/continuation-1/` as
`schema-history-adapter-first.log`, `schema-history-all-pglite-first.log` and
`schema-history-all-pglite-final.log`.

PostgreSQL history uses the same adapter in
`e2e/schema-history-upgrade.test.ts`; its separate disposable-database run is
owned by the integration lane. PGLite results alone do not establish PostgreSQL
or production migration acceptance. Restored production-fork lineage and
retrieval/cutover gates remain separate requirements.
