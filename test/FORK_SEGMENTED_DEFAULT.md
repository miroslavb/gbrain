# Segmented-storage diagnostic contract

The host fork keeps `SEGMENTED_STORAGE_DEFAULT=off`. An unset setting must stay
inline under the 24 MiB ceiling and doctor must report **off by default**.
Doctor uses the native `segmentedStorageRequested` decision, not a separate
hard-coded interpretation of an unset value. Existing blocker details remain
visible; an enable command remains user-owned and subject to the writer gate.

An explicit `on` is exercised in a separate fixture. It permits segmented
writes only when the native writer-compatibility gate passes. Old or unstamped
importers, resident processes and managed admitters/consumers still hold it off.
Explicit `off` remains an operator choice. If the configured switch requests
segmentation but the effective policy is off after a failed configuration read,
doctor warns instead of claiming the storage is on.

The fixture changes in `large-pages/segmented-switch.test.ts` are local:

- The old unset/on test now proves the actual fork default using a real 2 MiB
  import, with an exact diagnostic assertion.
- A separate explicit-on case retains the original segmented-write and engine
  ceiling checks. No shared setup enables the feature.
- The old-writer case also checks truthful default-off diagnostics while
  retaining blocker evidence, then checks the existing explicit-on refusal and
  subsequent promotion after blocker removal.
- The configuration-read test proves that `pages.max_bytes` alone does not
  enable segmentation, explicitly opts in before checking the configured cap,
  and checks the fail-closed diagnostic for an unreadable cap.

Verified 2026-10-30: all 16 PGLite switch tests passed, 107 assertions, including
the unchanged floor/mark, seven-day window, TTL, queued-request and live-process
cases. Execution used the network-none, nonroot, read-only-source, 3 GiB
preparation container. Receipt:
`/root/ops/gbrain-upgrade-prep-20261030/continuation-1/segmented-switch-default-first.log`.
No production configuration or storage policy was changed.
