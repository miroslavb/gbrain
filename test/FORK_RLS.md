# Fork state-table RLS regression

The upstream v283 RLS inventory is frozen and does not name the fork tables
`proposal_page_runs` and `extract_health_state`. The superuser-only auto-RLS
event trigger can hide this omission. Before the forward fix, the native
no-auto-RLS PostgreSQL suite failed six of seven cases: a fresh v288 install
left `extract_health_state` without RLS. The proposals table also needed an
explicit raw-schema rule and migration-only repair coverage.

## Forward fix

[`v289-fork-state-tables-rls.ts`](../src/core/schema-migrations/v289-fork-state-tables-rls.ts)
calls the existing v283 `protectTables` helper for exactly those two table names.
It has empty SQL, `transaction: false` and `idempotent: true`; the helper owns
one short transaction per unprotected relation and retains its transaction-local
statement/lock timeouts. Public relations and same-named relations resolved by
the current search path are covered. PGLite remains a no-op.

The helper requires ownership and BYPASSRLS capability, honors the documented
`GBRAIN:RLS_EXEMPT reason=...` comment, and names any unprotected nonexempt
relations on stderr. A skipped relation remains visible to the existing doctor
RLS check. No FORCE RLS, policies, grants, ownership changes or row mutations
are introduced. Applied modules through v288 and the v283 frozen inventory
remain unchanged.

An independent handwritten `fork_proposal_rls` block in
[`src/schema.sql`](../src/schema.sql) protects `proposal_page_runs` during raw
`db.initSchema()` without migrations or the auto-RLS event trigger. It uses the
same owner/BYPASSRLS, exemption and public/search-path conditions and only
enables RLS when still off. The upstream generic RLS list remains unchanged.
The new block's content hash is classified explicitly in
[`scripts/build-schema.ts`](../scripts/build-schema.ts) as `keep: false` for
PGLite, which has no role system. Engine schema blobs and the migration registry
are regenerated through the native build scripts.

## Native verification

Run `test/e2e/rls-every-table-postgres.test.ts` through the repository's E2E runner
against a disposable PostgreSQL server. Every case creates a scratch database
with the auto-RLS event trigger explicitly disabled. The seven existing cases
retain their full public-table assertions; fork tables are not filtered out.
Seven added cases cover:

- Raw `db.initSchema()` protects proposal receipts with RLS on and FORCE off;
  `extract_health_state` is still absent because its creation belongs to a migration.
- The exact standalone canonical raw block preserves explicit exemptions and
  owner-only authority, refuses to enable under a BYPASS nonowner or an owner
  without BYPASS, and covers both public and shadow relations. These cases
  execute the source block directly because unrelated full-schema DDL would
  fail under a nonowner before reaching its guard. Test-only ownership is
  restored and both fixture roles are dropped before cleanup.
- A migration-only v288→v289 apply with both fork RLS flags disabled protects
  both tables, preserves actual rows, owner IDs, ACLs and policy counts, and
  leaves an unrelated unprotected table alone. Native repeat applies zero
  migrations; direct handler repeat is harmless.
- Non-BYPASS and nonowner roles leave the unprotected relation named in the
  diagnostic. An explicit exemption is preserved, and the eligible owner can
  enable the table after that exemption is removed.
- Both public and search-path-shadow tables become protected without FORCE.

On 2026-10-30 the final isolated direct-PostgreSQL run passed all 14 cases with
64 assertions. The negative v288 run and positive v289 runs are retained separately in
preparation receipts (`rls-before-v289.log`, `rls-after-v289.log`, and
`rls-after-v289-guarded-raw.log`). Existing native helper tests also retain
lock-timeout refusal/retry coverage. This
evidence does not claim PgBouncer coverage or production activation.
