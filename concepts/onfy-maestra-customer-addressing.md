---
type: concept
title: Onfy × Maestra — Verified Customer Addressing (customerID GUID)
effective_date: '2026-06-16T00:00:00.000Z'
ingested_via: 'mcp:put_page'
ingested_at: '2026-06-16T05:03:00.592Z'
source_kind: 'mcp:put_page'
tags:
  - addressability
  - adr-0027
  - delta-sharing
  - maestra
  - onfy
  - reactivation
  - v3-api
---

# Verified customer-addressing method (Onfy × Maestra)

**The verified, production way to address an Onfy customer in the Maestra v3 API from a
Delta-Sharing-built cohort is the `customerID` GUID → `ids.customerID`.** Confirmed
end-to-end on 2026-06-16 (ADR-0027). Supersedes the broken numeric-id approach.

## The problem it solves
The DS `unmergedCustomerId` and the v3 `mindboxId` are **two different id spaces** (they
coincide only for old customers). Using the numeric `unmergedCustomerId` as the v3
`customerID` resolved only **~15%** of the cohort — the rest returned `NotFound`. That was
the ~85% addressability blocker on the reactivation pilot.

## The verified method
1. **Resolve on EC2** (`scripts/resolve_addressable_cohort.py`): stream
   `CDP.ExternalCustomerIdsHistory`, fold each `unmergedCustomerId` to its latest active
   **`customerID` GUID** (kind `7ba3b069-17d2-42c8-b5d2-f4b73500fa63`).
2. **Address in v3** via `mcp_bridge.operations._CustomerRef` →
   `customer = {"ids": {"customerID": "<GUID>"}}` for `triggerFlow` / `CustomerGetData`.

## Tenant-specific facts (important)
- `CDP.ExternalCustomerIdsHistory` on the Onfy tenant has **19 kinds**, but **NO plaintext
  `email` or `phone` kind**. Kinds are `customerID`, `emailHash`, and 17 event/marketing
  kinds (orderID, parcelID, campaign, prescription, formID, …).
- **`customerID` GUID is the only sendable stable id.** `emailHash` is a hash (not
  sendable, present for only ~7.5k customers); the rest are not customer addressing.
- So the generic email-vs-external resolver (`reactivation.identity.resolve_identities`)
  has an **empty email path here** — all addressing flows through
  `external_ids["customerID"]`. `DEFAULT_EMAIL_KINDS` needs no extension (no email kind
  exists to add).

## Result
**90,078 / 90,327 = 99.7%** of the L11–L16 mailable reactivation cohort is addressable via
`ids.customerID` (620,213 GUIDs resolved over 4.66M history rows; 249 unaddressable, 0
hash-only). Blocker closed. Verified end-to-end by a guardrail dry-run over the real
addressable cohort (`sent 77,591 / held 9,056 / blocked 3,431` — all the AC5 health screen,
no addressing/PII failures).

## Engineering note
`ExternalCustomerIdsHistory` is large (4.66M rows, one 128 MB CDF chunk) → the whole-table
`fetch()` OOM-killed the 768 MB container. `scripts/m06_delta_fetcher.py::iter_change_feed`
now streams CDF row-batches via pyarrow `iter_batches` with column projection (peak RAM ~one
batch), and the resolver folds straight into a compact `cust→GUID` map.

## Related
- [[projects/onfy-maestra-agent]] — parent project
- [[concepts/onfy-m13-reactivation-router]] — the reactivation cohort this addresses
- [[concepts/onfy-maestra-delta-sharing]] — the DS source
- [[companies/onfy]] — business context

[Source: ADR-0027 + docs/reports/guardrail_addressable_dryrun_2026-06-16.md;
verified on EC2 prod 2026-06-16; PR miroslavb/onfy-maestra-agent#36.]
