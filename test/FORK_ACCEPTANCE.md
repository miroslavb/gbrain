# Fork maintenance acceptance

## Production maintenance acceptance

Run supported unit, slow, verify and PostgreSQL E2E wrappers on the frozen
production candidate itself, preserving its deployed search policy. Use an
allowlisted keyless environment and a private disposable PostgreSQL database,
with owned-container cleanup; production is never the E2E target. Preserve failed
runs and explicit provider/optional skips. Migration-lifecycle fixtures disable
the current PGLite snapshot while connecting, so the empty/rewound-state premise
is exercised. World-only fact visibility remains separate from source grants.
## Authorization regression gates

`test/data-frontmatter.test.ts` and `test/frontmatter-security.test.ts` pin inert
frontmatter parsing, opaque serialization, scalar compatibility, and import
errors. `test/authorization-boundaries.test.ts` covers scalar source grants,
foreign/private facts, and delegated tool exclusions.

`test/oauth-consent-security.test.ts` covers pending consent, CSRF, policy
changes, duplicate decisions, and uncertain completion. Production HTTP flows
live in `test/e2e/serve-http-consent.test.ts`; client-lock races and grant rollback
on Postgres live in `test/e2e/oauth-grant-transactions.test.ts`.

`test/minions-submission-authority.test.ts` covers submission schemas, durable
policy, lifecycle operations, legacy approval snapshots, file confinement, and
both workers. `test/e2e/minions-authority-parity.test.ts` exercises real Postgres
JSONB and authorization behavior. Filesystem write concurrency is pinned by the
existing fence and timeline suites.

`test/guarded-http.test.ts` and `test/guarded-http-tls.serial.test.ts` cover DNS,
TLS identity and ports, redirects, deadlines, body limits, and cleanup. CI runs
these boundaries on Bun 1.4.4, audits root and admin dependencies, and
executes `scripts/test-gitleaks-config.sh` to prove fixture exceptions still
report an unrelated secret in the same file. `scripts/scan-worktree-secrets.sh`
scans tracked files plus new files eligible for commit; tracked ignored files
remain included. Full-history scans use `gitleaks git . --log-opts=--all` from a
complete clone and reports must remain private.

The Docker gate sets `GBRAIN_CI_DISABLE_TEST_ENV_FILE=1` so a bind-mounted
developer `.env.testing` cannot add credentials or change the isolated test
database. Explicit local provider E2E runs can continue using that file.


### Host finite code refresh

`test/persistence-finite-code.test.ts` and its PostgreSQL twin exercise journaled
create/update/replay, empty/tombstone/recreate, wrong file/manifest/runtime
hashes, revisions, source/path authority, captured taxonomy and an actual
post-import file race. Remote authority is admitted only when strictly false;
undefined/null/zero must refuse before filesystem access. All test writes use
enabled managed persistence; a separate fixture seed represents captured
pre-upgrade taxonomy. No fetch/provider call is allowed. A host-stage
process-separated SIGKILL probe independently verifies queued admission and a
fresh consumer; the full13-file canary does not replace these negative cases.
