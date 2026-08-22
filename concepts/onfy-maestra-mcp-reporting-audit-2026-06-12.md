---
type: concept
title: Onfy Maestra MCP Reporting Audit 2026-06-12
date: '2026-06-12T00:00:00.000Z'
source: >-
  live Maestra MCP probes + repo report
  docs/reports/maestra_mcp_reporting_audit_2026-06-12.md
status: verified-read-only-reporting
project: projects/onfy-maestra-agent
ingested_via: 'mcp:put_page'
ingested_at: '2026-06-12T12:15:21.826Z'
source_kind: 'mcp:put_page'
---

# Onfy Maestra MCP Reporting Audit — 2026-06-12

**What this is.** A capability audit of Maestra's hosted MCP endpoint for [[projects/onfy-maestra-agent]]: `https://mcp.omega.maestra.io/c/onfy`.

## Verdict

The hosted Maestra MCP server is useful as a **read-only reporting oracle** for baseline, flow monitoring, and post-launch control. It does **not** expose action tools, raw Delta Sharing data, customer-level cohorts, segment membership, Flow/segment authoring, or `triggerFlow`.

Use it alongside Delta Sharing and the local `mcp_bridge`, not as a replacement for either.

## MCP surface verified

`initialize` returned:

- `serverInfo.name`: `Mindbox.Mcp.Services`
- `serverInfo.version`: `1.0.0.0`
- `protocolVersion`: `2025-03-26`
- capabilities: `tools`

Unavailable MCP methods:

- `resources/list` → method not available
- `prompts/list` → method not available

Available tools:

| Tool | Purpose |
| --- | --- |
| `flow_report` | Flow performance report with summary, optional timeline, and top-20 per-flow breakdown. |
| `campaign_report` | Campaign/mailing performance report with summary, optional timeline, per-campaign or per-folder breakdown. |

Negative capability probes returned `Unknown tool` for action-like names:

- `triggerFlow`
- `customerEditByID`
- `maestra.flow.trigger`
- `flow_trigger`
- `segment_report`

Conclusion: the hosted MCP server is read-only reporting. It cannot launch Maestra actions.

## What `flow_report` provides

Verified fields:

- Revenue
- Orders
- Sends
- InQueue
- Deliveries
- OpenRate
- ClickRate
- ConversionRate
- CTOR
- unsubscribe / spam / bounce metrics
- ScenarioExecutionsCount
- ScenarioClient* metrics, though these returned zeros for the probed Onfy flows

Useful filters in schema:

- `startDate`, `endDate`
- `channels`
- `activeOnly`
- `startedInPeriodOnly`
- `flowNameContains`
- `includeFlowIds`, `excludeFlowIds`
- `folders`
- `brands`
- `timelineBucket`: Day / Week / Month

## What `campaign_report` provides

Verified fields:

- revenue
- orders
- sent / delivered
- delivery/open/click/conversion rates
- unsubscribe/spam/bounce rates
- conversion revenue
- average order value
- per-campaign breakdown
- per-folder breakdown via `groupByFolder=true`

Useful filters in schema:

- `startDate`, `endDate`
- `channels`
- `activationType`: Automatic / Manual
- `brands`
- `groupByFolder`
- `timelineBucket`: Day / Week / Month

## Onfy baseline probes

All values came from read-only MCP calls against the hosted Maestra MCP server on 2026-06-12.

### All email flows

Window: `2026-03-01` through `2026-06-12`, channel `email`.

| Metric | Value |
| --- | ---: |
| Revenue | 103,640.61 |
| Orders | 2,032 |
| Sends | 862,952 |
| Open rate | 33.73% |
| Click rate | 1.53% |
| Conversion rate | 0.23% |

### Abandoned Session flow

Window: `2026-03-01` through `2026-06-12`, channel `email`, `flowNameContains="Abandoned"`.

| Metric | Value |
| --- | ---: |
| Revenue | 15,452.11 |
| Orders | 292 |
| Sends | 40,696 |
| InQueue | 40,728 |
| Deliveries | 40,609 |
| Open rate | 34.66% |
| Click rate | 4.35% |
| Conversion rate | 0.71% |
| ScenarioExecutionsCount | 150,429 |

Flow breakdown included:

- `Abandoned session`
- `Don't use // Abandoned view`

### Reactivation flow family

Window: `2026-03-01` through `2026-06-12`, channel `email`, `flowNameContains="Reactivation"`.

| Metric | Value |
| --- | ---: |
| Revenue | 61,231.52 |
| Orders | 1,155 |
| Sends | 504,997 |
| InQueue | 505,129 |
| Deliveries | 503,881 |
| Open rate | 29.23% |
| Click rate | 1.22% |
| Conversion rate | 0.22% |
| ScenarioExecutionsCount | 646,235 |

Flow breakdown included eight reactivation flows:

- `Reactivation | One month after the first order`
- `Reactivation | 180 days`
- `Reactivation | 45 days`
- `Reactivation | 90 days`
- `Reactivation | 3 months after the first order`
- `Reactivation | 245 days`
- `Reactivation | Two weeks after order`
- `Reactivation | 365 days`

### Behavior/cart flows visible through reporting

These matter because Delta Sharing / CSH does not currently expose all raw cart/session/product behavior rows needed for cohort construction.

Window: `2026-03-01` through `2026-06-12`, channel `email`.

| Flow group | Revenue | Orders | Sends | InQueue | Deliveries | Open rate | Click rate | Conversion rate | ScenarioExecutionsCount |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `Cart product price reduced` | 1,050.69 | 19 | 25,887 | 26,512 | 25,696 | 24.79% | 0.84% | 0.06% | 76,901 |
| `Viewed product price reduced` | 2,908.37 | 59 | 14,284 | 15,185 | 14,275 | 33.53% | 3.75% | 0.41% | 5,453,992 |

Interpretation: the reporting layer knows these behavior-triggered flows ran and how they performed. It still does not expose underlying customer-level segment memberships or product/cart events.

## Campaign/folder probes

Window: `2026-03-01` through `2026-06-12`, channel `email`, `activationType=Automatic`.

Automatic campaign summary:

| Metric | Value |
| --- | ---: |
| Revenue | 71,531.36 |
| Orders | 1,406 |
| Sent | 767,842 |
| Delivered | 765,244 |
| Delivery rate | 99.66% |
| Open rate | 34.03% |
| Click rate | 1.26% |
| CTOR | 3.72% |
| Conversion rate | 0.18% |
| Unsubscribe rate | 1.50% |
| Spam rate | 0.00% |
| Bounce rate | 0.28% |
| Conversions revenue | 68,465.79 |
| Average order value | 50.83 |

Per-folder breakdown:

| Folder | Revenue | Orders | Sent | Open rate | Click rate |
| --- | ---: | ---: | ---: | ---: | ---: |
| Abandoned campaigns | 7,216.82 | 136 | 21,649 | 34.66% | 3.13% |
| Order Delay | 1,080.85 | 21 | 8,874 | 61.52% | 3.43% |
| Reactivation | 43,564.35 | 819 | 402,501 | 29.23% | 1.22% |
| Reduced price | 2,662.69 | 53 | 32,840 | 27.28% | 1.31% |
| Registration without order within 3 days | 2,983.06 | 58 | 80,992 | 42.05% | 1.02% |
| Restock notification | 11,792.39 | 257 | 66,421 | 28.66% | 1.28% |
| Transactional messages | 0.00 | 0 | 60,556 | 37.61% | 0.00% |
| Welcome | 2,231.20 | 62 | 94,025 | 48.84% | 1.83% |

Campaign breakdown exposed useful variant names:

- `Abandoned cart [opt. A]`
- `Abandoned cart [opt. B]`
- `Abandoned cart [promocode]`
- `Abandoned view`
- `Abandoned view [2]`
- Reactivation reminder variants

This is useful for copy/offer hypothesis work and baseline decomposition.

## Delta Sharing comparison

The hosted MCP server gives **new reporting aggregates** relative to Delta Sharing, but not new raw data.

Useful reporting layer:

- Flow and campaign revenue/orders/sends/delivery/open/click/conversion metrics are available directly.
- `InQueue`, `Deliveries`, and `ScenarioExecutionsCount` support operational monitoring.
- Folder and campaign variant names help map Maestra UI structure.
- Behavior-triggered flows are visible even where raw cart/session data is not accessible in Delta Sharing.

Still missing:

- Customer-level cohort rows.
- Segment membership rows for `segmentationId=26 ProductInCart` or `segmentationId=5 ProverkaBroshennojKorziny`.
- Raw cart/session/browse events.
- Cart contents.
- Per-recipient journey state.
- Flow/segment/A-B authoring.
- Write/action operations.

Therefore the hosted MCP server does **not** close the Abandoned Sessions data blocker. The vendor ask to stream seg26 and seg5 membership into `CDP.CustomerSegmentHistory` remains required.

## Recommended use in the pilot

Use this hosted MCP server for:

1. **AC3 baseline**: flow-level and campaign-level baseline for Reactivation and Abandoned Sessions.
2. **AC4 measurement**: 3-week readout versus baseline using the same report filters.
3. **Operational control**: weekly/daily checks on `InQueue`, `Sends`, `Deliveries`, `OpenRate`, `ClickRate`, `ConversionRate`, `ScenarioExecutionsCount`, unsubscribes, bounces, and spam.
4. **Creative enrichment**: campaign variant and folder performance to guide copy and offer hypotheses.

Do not use it for:

1. Building customer cohorts.
2. Reading raw abandoned-cart/session data.
3. Reading cart contents.
4. Triggering flows or editing customers.
5. Authoring Maestra Flows, segments, or A/B tests.

For those paths, keep the existing architecture:

- Delta Sharing + local pipelines for analytical/cohort data.
- `mcp_bridge` for approval-gated Maestra v3 writes.
- One-time Maestra UI setup where Flow/segment authoring remains UI-only.

[Source: live Maestra MCP probes and repo report `docs/reports/maestra_mcp_reporting_audit_2026-06-12.md`, 2026-06-12.]
