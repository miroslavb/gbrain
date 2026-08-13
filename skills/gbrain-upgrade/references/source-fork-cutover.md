# Source-fork and always-on GBrain cutover

Use this reference when GBrain runs from a source checkout, has downstream
commits/configuration, or is shared by multiple long-lived HTTP/stdio clients.
It extends the normal `gbrain self-upgrade` flow; it does not replace the
operator-confirmation policy in `SKILL.md`.

## 1. Establish the real installation contour

1. Resolve the executable and checkout (`command -v gbrain`, `readlink -f`,
   `git worktree list --porcelain`).
2. Record current package version, HEAD, upstream merge-base, remotes, service
   `ExecStart`, effective systemd drop-ins, and all GBrain process trees.
3. Inspect ordinary changes **and index flags**:
   - `git status --short`
   - `git ls-files -v` — uppercase `S` marks `skip-worktree` overlays hidden from
     ordinary status.
4. Save tracked local diffs separately. For each hidden overlay, save the exact
   bytes plus mode and perform a three-way merge: old HEAD → local overlay →
   candidate. Restore its `skip-worktree` flag after the switch.
5. Enumerate untracked and ignored paths and prove that none collide with the
   candidate tree. Never assume `git clean` is safe.

## 2. Backup before candidate execution

1. Create a custom-format PostgreSQL dump and validate it with
   `pg_restore --list`.
2. If the application role cannot read a legacy table, do **not** weaken grants
   just for backup. Use the local PostgreSQL service role via peer auth, write to
   a temporary path, then install the completed dump as owner root, mode 600.
3. Record a checksum. Remove only proven zero-byte/invalid partial artifacts.
4. Beware: candidate CLI startup can auto-run pending schema migrations even
   when the requested subcommand looks informational (`--help`). Use an isolated
   DB/config environment for candidate CLI probes. If a live additive migration
   is triggered, stop, verify its receipt/table and take a new post-migration
   dump before source switch.

## 3. Build and verify in an isolated worktree

1. Fetch upstream and create a separate candidate worktree/branch. Never rebase
   the production checkout in place.
2. Rebase downstream commits one at a time. Compare each conflict with its
   pre-rebase commit and current upstream implementation; an absent old hunk may
   be semantically absorbed upstream rather than lost.
3. Preserve downstream behavior through explicit regression tests. Update stale
   upstream assertions only when source history proves the fork contract.
4. Run tests with temporary `TMPDIR`/`HOME`/`GBRAIN_HOME`, production DB variables
   removed, and root DAC capabilities dropped. Subprocess fixtures that rely on
   `HOME` must delete inherited `GBRAIN_HOME`, which has higher precedence.
5. Run targeted regressions, generated-artifact parity, verify/typecheck/diff
   checks, the canonical full suite, and an adversarial read-only review.
6. Commit the exact green snapshot and create explicit old/candidate rollback
   refs before cutover.

## 4. Quiesce the live writers

1. Temporarily suppress only the autopilot watchdog schedule and save the
   original crontab byte-for-byte.
2. Stop the GBrain HTTP service and gracefully signal the autopilot parent.
   Do not restart Hermes gateways just to switch GBrain source.
3. Wait for open transactions to reach zero. Durable jobs may remain active
   until their leases expire; verify they have retry/stall recovery before
   proceeding.
4. Take and validate a fresh quiesced dump.

## 5. Switch in place without losing operational files

1. Use absolute `git -C /absolute/production/path` commands; do not trust a tool
   wrapper's requested working directory.
2. Re-run the tracked, hidden-overlay, untracked and ignored collision guards.
3. Switch to the exact green commit, restore tracked patches, restore merged
   hidden overlays and their index flags, then install dependencies with
   lifecycle scripts disabled (`bun install --frozen-lockfile --ignore-scripts`).
4. Apply migrations explicitly and non-interactively. Preserve custom supervisor
   topology with `--no-autopilot-install` when appropriate.
5. Start only GBrain HTTP/autopilot components. Keep the Hermes gateway parent
   alive.

## 6. Refresh stdio clients safely

1. Inventory exact `/root/gbrain/src/cli.ts serve` children and their watchdog
   and gateway parent PIDs.
2. Terminate only each exact Bun child, one at a time. Never signal the Hermes
   parent or use broad `pkill -f` patterns (they can self-match).
3. Wait through the MCP reconnect budget and prove a new child/watchdog PID
   appears for every contour (gateway, dashboard and standalone bridges).
4. Verify with real `search`, `query`, `get_page`, stats and health calls.

## 7. Final verification and persistence

Verify, from fresh evidence:

- source HEAD, package version and remote read-back;
- HTTP health/version/engine;
- schema version and migration ledger;
- critical DB-plane config (for example search mode, fact visibility and
  embedding model/dimensions);
- services, queue recovery, open transactions and all stdio contours;
- doctor output, distinguishing upgrade regressions from pre-existing content
  health/backlogs;
- backup catalogs/checksums and exact crontab restoration.

Push with `--force-with-lease` when the rebase rewrote history. If HTTPS auth
lacks workflow scope and upstream added workflow files, use an already-verified
SSH identity rather than weakening or printing credentials. Finally, update the
existing canonical operations page with inline source citations and re-read it.

## Rollback

A Git reset alone is sufficient only before live schema changes. After migrations,
rollback may require restoring the validated PostgreSQL dump. Keep the pre-upgrade
checkout ref, post-migration dump and operational-overlay manifest until the new
runtime has passed steady-state checks.
