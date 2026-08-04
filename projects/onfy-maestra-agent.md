---
type: project
title: Onfy Maestra Agent
repo: 'https://github.com/miroslavb/onfy-maestra-agent'
owner: miroslavb
status: rate-limit-resolved-bulk-feasible
created: '2026-05-19T00:00:00.000Z'
updated: '2026-06-01T00:00:00.000Z'
ingested_via: 'mcp:put_page'
ingested_at: '2026-06-01T12:54:27.817Z'
source_kind: 'mcp:put_page'
aliases:
  - Онфи Маэстра
  - Онфи
tags:
  - agent
  - aws
  - claude-code
  - gdpr-tooling
  - infrastructure
  - maestra-rest
  - pgvector
  - prompt-injection
  - slack
---

# Onfy × Maestra Agent — Agentic CRM Layer

**What this is.** Production-grade agent infrastructure that wraps **Maestra CRM**
(SaaS REST API at `api.maestra.io`) with autonomous assistants for
[[companies/onfy]]. The agent designs, deploys, and audits CRM flows on
behalf of operators; a deterministic PII firewall prevents leakage of
Personal/Health data to LLM providers; a parallel prompt-injection firewall
prevents the agent from being coerced.

For business context, segments, flow map → [[companies/onfy]].
For the email-automation roadmap the agent will operate on → [[projects/onfy-email-automation]].
For HWG / DSGVO / MDR rules encoded as guardrails → [[concepts/onfy-regulatory-guardrails]].

This page covers the **agent infrastructure** only.

## Repo + status
- **Repo:** https://github.com/miroslavb/onfy-maestra-agent (private)
- **Bootstrapped:** 2026-05-19 (commit b604005)
- **Latest:** **HEAD `2b14310`**, 2026-06-01 — **OQ-V3 rate-limit RESOLVED.** The vendor raised the `onfy.agent` method priority and a clean **distinct-ID re-ramp** measured real ceilings **sync `CustomerGetData` 8 RPS / async `customerEditByID` 10 RPS** (the 2026-05-29 "sub-1-RPS" was a *constant-fake-ID per-contact artefact*, not a global cap). ⇒ **bulk de-bounce (34.8k) / win-back (31.9k) now feasible as ~3 h batch jobs.** Pushed origin **and** mirror (`main` fast-forwarded `7dff003 → 2b14310`); **push credential restored** (revoked `ghp_0MX…` removed from `/root/.git-credentials`, working least-privilege PAT in place). Prior: `9c66f21` (Positioning-2026 retention-lever doc), `b6b577b` (per-contact rate-limit answer recorded + async re-ramp probe authored).
- **Status:** Pre-production. **Rate-limit no longer blocks bulk** (token bucket async ≤5 / sync ≤3 RPS). Delta Sharing verified + **freshness re-confirmed** (the prior "staged-freeze" was our own fetcher bug, not a vendor freeze — see below); M06 pipeline done; **live Maestra v3 agent integration validated + probe-confirmed** via the dedicated `onfy.agent` Custom Integration; **agent-facing v3 op-set wired in `mcp_bridge`**. Remaining gates to live writes: `chat_bridge` approval-token issuance (writes 412 until then) + marketing subscribing L03/L09 flows to the `triggerFlow` "Operation triggered" event. **Security: a separate Delta Sharing token (`1TWM…`) is still LIVE + hardcoded in `scripts/*` — rotate + move to env.**

## Stack at a glance

| Layer | Choice | Why (terse) |
|-------|--------|-------------|
| Operator chat | **Slack default** + dashboard (HTMX) | Onfy ops already live in Slack; dashboard for power-user actions; shared audit trail |
| Trust ladder | L0 instruction / L1 quoted / L2 external | Only L0 can authorize tool calls; L1/L2 spotlight-wrapped |
| chat_bridge | FastAPI · Slack HMAC + dashboard JWT | Verifies inbound; tags trust tier; cascades to guards |
| prompt_guard | Deterministic regex + heuristics + optional LLM-judge | 6-layer defense (auth/classifier/spotlight/privilege/output/canary) |
| Agent runtime | `claude-code` default; `hermes`/`openclaw` pluggable | Native MCP, Bedrock-friendly |
| LLM | Bedrock Claude Sonnet 4.6 (eu-central-1) → Anthropic direct (opt-in) | Data residency |
| **Maestra transport** | **HTTPS REST → mcp_bridge wrapper → agent MCP** (ADR-0013) | Maestra is SaaS, no native MCP; wrapper holds creds + enforces allowlist + spotlight wrap |
| **Data export** | **Delta Sharing** (Parquet, signed URLs, CDF) | Bulk analytical data: 329K orders/year, segments, mailings, A/B tests |
| Memory | Postgres 16 + **pgvector** HNSW | One DB to operate |
| Embeddings | Bedrock cohere-multilingual-v3 → local e5-small | German-first; CPU fallback fits 4 GB |
| ~~Maestra VPN~~ | **WireGuard opt-in only (default off)** after ADR-0013 | Original plan retired; ADR-0004 partially superseded |
| PII firewall | **Presidio** + de_core_news_lg + custom DE recognizers | Deterministic — required for GDPR Art. 25 |
| Observability | Grafana **LGTM** + Alertmanager | Single pane, all FOSS, fits 4 GB |
| Backups | Restic → S3 (SSE-KMS, Object Lock 90 d) + pg_dump daily | RTO 30 m, RPO ≤ 24 h |
| IaC | Terraform (AWS) + Ansible (CIS L1) + docker-compose | Right tool per layer |
| CI/CD | GitHub Actions + OIDC → AWS | No static keys; TDD ≥ 80 %; Playwright matrix |
| Secrets | SOPS + age (repo) + AWS Secrets Manager (runtime) | 3-tier rotation |

Host: AWS EC2 (eu-central-1), 2 vCPU / 4 GB / 100 GB NVMe; stateless app
containers ready for horizontal scale behind ALB (`enable_alb=true`).

## Architecture Decision Records (in repo, `docs/adr/`)
1. Agent runtime (claude-code)
2. Vector DB (pgvector)
3. Embeddings (Bedrock primary + local fallback)
4. ~~VPN (WireGuard)~~ — **Partially superseded by ADR-0013**; WG opt-in only
5. Observability (Grafana LGTM)
6. PII firewall (Presidio)
7. IaC (Terraform + Ansible + Compose)
8. CI/CD (GitHub Actions + OIDC)
9. E2E (Playwright TS)
10. Secrets (SOPS + age + Secrets Manager)
11. Chat channel (Slack-first + dashboard)
12. Prompt-injection defense (6 layers)
13. **Maestra transport: REST API GW with self-hosted MCP wrapper** *(2026-05-19)*
14. **Delta Sharing integration: bulk analytical data** *(2026-05-22)*
15. (ADR-0015 Bedrock geo-zone), **16. Maestra integration architecture (dual-channel REST + Delta Sharing via `mcp_bridge`)**, 17 (mirror DB ingest), 0021 (GDPR), 0022 (L09 adaptive reactivation) — see `docs/adr/`

## Delta Sharing Integration (Verified 2026-05-22/23; freshness re-confirmed 2026-06-01)

### Status
✅ **Verified and tested with full year data** (329,984 orders, €16.9M revenue). Live feed is **fresh to today** (token now provisioned to the tg-bridge env as `MAESTRA_DELTA_SHARING_TOKEN`; `GET /shares` → 200, shares `exports` + `heartbeat`).

### Configuration
- **Endpoint:** `https://delta-sharing.maestra.io/delta-sharing`
- **Auth:** Bearer token (long-lived static)
- **Format:** Parquet files via signed URLs (10 min validity)
- **Tables:** 23 tables across 4 schemas (CDP, ProcessingOrders, Mailings, AbTests)

### Full Year Analysis (May 2025 → May 2026)
- **Script:** `scripts/onfy_year_analysis.py` (pushed to repo main branch, commit 22befc0)
- **Report:** `docs/reports/onfy_orders_year_analysis_2025-2026.md` (pushed, commit 0246bff)
- **Data volume:** 364 Parquet files, 330K raw rows → 329,984 active orders (deduplication overhead <1%)

[Full analysis results → [[concepts/onfy-maestra-delta-sharing#year-analysis-results]]]

### Key Findings
- **329,984 orders, €16.9M revenue, 245,428 unique customers**
- **12% repeat rate** (88% single-order customers — retention gap)
- **Seasonal pattern:** Peak Aug-Oct (38K-40K orders/month), decline Nov-Feb
- **Peak quarter:** Q4 2025 (93,166 orders, €4.89M)
- **Average LTV:** €68.89 (VIP customers: €412.89)

### DS re-analysis (2026-05-29) — list-hygiene lever; "staged-freeze" overturned 2026-06-01
- Re-ran off cached parquet (`/root/.cache/m06`; system `/usr/bin/python3` has duckdb/pandas/polars, venv does not).
- **~~Staged freeze confirmed~~ — OVERTURNED 2026-06-01:** the apparent freeze (Orders 2024-08, Purchases 2024-09, CSH 2025-02) was **NOT a vendor freeze**. Root cause: our own `m06_delta_fetcher._pull_full_history` did an early `break` on the first 400/404 (a CDF gap mid-walk) against a **never-refreshed cache**. A live REST probe shows the `exports` share is **fresh to today** (Orders/Purchases/CSH current). Fetcher hardened (metadata-driven end + skip-gaps/continue) + regression test added (work in tree at session end). ⇒ **revenue/RFM analysis on current data IS possible**; the "DWH mirror for freshness" rationale (ADR-0017) is void — mirror is only for product→brand/basket dimensions.
- **Headline lever — list hygiene:** bounce ∩ subscribed = **34,797 = 11.4% of the 305,632 consented base** we actively mail (deliverability waste). This seeded the two pilots below.

## M06 Retention Pipeline (Completed 2026-05-23)

### Status
✅ **Completed** — 7,902 actions generated for 14,104 loyal customers

### Results
- **Target:** 14,104 loyal customers (≥3 orders, avg LTV €285.12)
- **Actions generated:** 7,902
  - churn_intervention: 5,005 (medium priority)
  - loyalty_recognition: 2,126 (high priority)
  - reorder_reminder: 771 (low priority)
- **Script:** `scripts/m06_loyal_retention_pipeline.py`
- **Reports:** `docs/reports/m06/` (actions, alerts, summary)

[Full pipeline details → [[concepts/onfy-m06-pipeline]]]

## Operator pilots (authored 2026-05-29, commit 784f609)

Two operator-run pilots, each **3 phases** (offline candidates → live verify → gated apply), safe-by-default, IDs resolved via MergedCustomers; sample CSVs live **outside** the repo (`/root/.cache/{debounce,winback}/sample.csv`, pseudonymous, NOT committed).

- **`scripts/debounce_pilot.py`** — suppress hard-bounced-but-still-subscribed addresses via `customerEditByID` (the 34,797 lever above). **OQ#1 (ID-space) CLOSED** on the verify run: DS `unmergedCustomerId` == API `customerID` (95% Found, 20-sample).
- **`scripts/winback_rfm.py`** — RFM win-back via `triggerFlow` (`reason` = RFM bucket). Tier A = Too-valuable-to-lose / Churn-risk / Almost-dormant = **31,985** customers. No-op until marketing subscribes a flow to the `triggerFlow` "Operation triggered" event.

**Feasibility (2026-06-01):** the rate-limit blocker is **RESOLVED** — both pilots are now feasible as **~3 h throttled batch jobs** at the token-bucket rate (async ≤5 RPS), not the earlier "~10 h+ / infeasible". Remaining gate for win-back: marketing must subscribe a flow to the "Operation triggered" event.

## ✅ Rate-limit RESOLVED (2026-06-01)

**OQ-V3 closed.** The 2026-05-29 "sub-1-RPS, bulk infeasible" reading was an **artefact**: the old ramp reused **one constant fake ID** (tripping the per-contact `15 async ops/contact/min` cap), the method priority was un-raised, and the measurement ran inside a penalty window. The vendor (2026-06-01) **raised the `onfy.agent` method priority** and asked us to retry with **distinct IDs** (their logs showed the constant `rate-ramp-probe-fake-id` repeatedly hitting the per-contact limit — confirming the artefact).

**Clean distinct-ID re-ramp** (`scripts/rate_ramp_probe.py`, both modes — report `docs/reports/maestra_async_ramp_2026-06-01.md`):

| path | operation | clean to | first 429 |
|------|-----------|----------|-----------|
| sync (read) | `CustomerGetData` | **8 RPS** | 13 RPS (15%) |
| async (write) | `customerEditByID` | **10 RPS** | 20 RPS (8%) |

- **No-op verified:** after an async no-field edit on a fake ID, `CustomerGetData` on that ID → `NotFound` (no contact created — `customerEditByID` does not upsert).
- **`triggerFlow` (win-back op):** single-shot `200`, post-call `CustomerGetData` → `NotFound` (no contact created; no-op while no flow is subscribed to "Operation triggered"); same async-CDP class ⇒ shares the ~10-RPS per-project async cap. The full `triggerFlow` mass-ramp was **not run** (auto-mode classifier flagged high-frequency prod `triggerFlow` as high-severity); accepted by proxy.
- **Token bucket** (ADR-0016 §2.2): async writes **≤ 5 RPS**, sync reads **≤ 3 RPS** (sync shows a lingering penalty under sustained repeat). The bridge's 429 `Retry-After`/exponential backoff (`_maestra_request`, cap `MAESTRA_RATE_LIMIT_MAX_WAIT`) remains the safety net.
- ⇒ **bulk de-bounce (34,797) / win-back (31,985) are feasible as ~3 h throttled batch jobs**, retracting the earlier "~10 h+ / infeasible".

Minor remainder: no `Retry-After` header on 429; test-key vs prod quota now moot (the test key clears 10 RPS async after the priority change). Vendor binding limit on record: **15 async CDP ops / contact / min** (per-contact, never gates 1-op-per-contact bulk).

## Maestra v3 agent integration (validated 2026-05-28 / 29)

The agent talks to Maestra v3 RPC (`api.maestra.io/v3/operations`) through a **dedicated Custom Integration `onfy.agent`** (touchpoint=agent; = **`Other #1`**, `folderId=12`) — a separate trust boundary from the 6 product endpoints (`onfy.{website,ios,android}{,.dev}`). See ADR-0016 §2.2.1.

**Verified op set on `onfy.agent` (live admin audit 2026-05-29, probe-confirmed):**
- `CustomerGetData` (op 1433) — read; first live 200 on 2026-05-28; probe `200 Success / NotFound`.
- `customerEditByID` (op 1793) — edit by id. **Real System name is `customerEditByID`, NOT `CustomerEdit`/`webCustomerEdit`** (those don't exist — probe → `400 "Operation not found"`; prior `403`s on them were misnamed calls).
- `customerEditByEmail` (op 1263) — unsubscribe / edit by email.
- `customerReimport` (op 1434) — bulk upsert by ids.
- `triggerFlow` (op **1895**, authored 2026-05-29) — flow trigger; emits the `"Operation triggered"` event that scenarios subscribe to; optional `reason` Operation variable; probe `200`. Used **instead of** `MessageSend` — which **does** exist in the tenant catalog (bound to the product endpoint `onfy.website`, 28 flows) but is deliberately **not** bound to `onfy.agent`: the 2026-05-29 probe (P4) returns `403 "Operation can't be used in provided endpoint"`, *not* absence. Transactional email is flow-owned by design, so the agent triggers flows rather than binding `MessageSend`. Marketing must subscribe L03/L09 flows to the event for a call to do anything.

All four customer ops were **already bound** to `Other #1` (no enablement writes needed); only `triggerFlow` was newly created. Enablement = adding `Other #1` to a method's *API endpoints* binding (methods are shared multi-endpoint objects, not per-endpoint copies). **No sandbox exists** (vendor-confirmed OQ-V7) — every probe hit production (active probes are read-only / no-op).

**Probe (2026-05-29, prod, read-only/no-op):** 6 controls via `scripts/maestra_probe.sh` on `onfy.agent`. `CustomerGetData`→`200 NotFound` and `triggerFlow`→`200` (both **bound + callable**). Controls: `CustomerEdit`→`400` (genuinely absent), **`MessageSend`→`403`** (exists in catalog, **unbound** on the agent endpoint), bogus endpoint→`401` (endpoint validated before secret). Auth-header parity confirmed: canonical `Authorization: SecretKey {k}` ≡ legacy `Authorization: Mindbox secretKey="{k}"`.

**Write-op binding re-probe (commit 6d7f54d, empty `{}`, user-authorized):** `customerEditByID` / `customerEditByEmail` / `customerReimport` → **200** (not 403) = all 3 API-bound. **`returns-validation-errors` is OFF confirmed** (empty `{}` → 200, not 400) ⇒ Maestra **silently accepts malformed writes**, so **bridge-side Pydantic validation (422 before the call) is load-bearing**. All 5 agent ops are now API-bound-confirmed.

**Vendor OQ batch (2026-05-28):** 27/36 resolved. Top blocker **V2 closed — data at rest in Germany (eu-central-1)**. V11 (Delta Sharing field encryption) still open. **OQ-V3 (rate limits) RESOLVED 2026-06-01** — see Rate-limit section above. Incident: 4/6 product integrations in `Bad` health status (self-serve key rotation broken there). Detail in `docs/MAESTRA_VENDOR_QUESTIONS_2026-05-28.md` §5.1–5.3.

**Code-side: WIRED (2026-05-29, commit 1b0f93a).** `mcp_bridge` was rewritten (v0.2.0 → v0.3.0) from the 3-tool **v2** REST skeleton (`/v2/{audiences,flows,campaigns}`) to the live **v3 RPC** transport. The allowlist (`src/mcp_bridge/operations.py`) now keys on the validated System names above. New capabilities, mapped to ADR-0016:
- **Transport** — `SecretKey` auth, `POST /{sync|async}?endpointId=onfy.agent&operation=<SystemName>&transactionId`, nested JSON envelope, per-endpointId credential `MAESTRA_SECRET_KEY_onfy.agent` (request-time read for SIGHUP hot-swap). JSON confirmed working (resolves §1.2 XML assumption).
- **Write-gate (§2.4)** — write ops require an HMAC-signed `X-Maestra-Approval-Token` bound to operator+operation+customer+expiry; default-deny → 412. `mint_approval_token` seam provided for `chat_bridge` / ADR-0011 Slack `:thumbsup:` issuance (issuance wiring is the remaining chat_bridge follow-up). Writes stay **default-denied** until then.
- **PII redaction (§2.3)** — structural field redaction (`src/mcp_bridge/redaction.py`: email→email_domain, drop phone/name/birthDate/sex) + `prompt_guard` → `pii_guard` egress cascade, fail-closed on block/outage.
- **Idempotency + async (§2.5)** — stable `transactionId` reused across tenacity retries; `TransactionAlreadyProcessed` → `idempotent:true`; async writes → 202 + txn id (getOperationStatus poll opt-in, OQ-A1 not hard-depended-on).
- **429 backoff (§2.2)** — added 2026-05-29 (commits 27de9a5/821fbc5); token bucket re-tuned 2026-06-01 to async ≤5 / sync ≤3 RPS after the clean re-ramp.
- **Tests/quality** — `tests/unit/test_mcp_bridge.py`, **24** tests via respx (transport/auth/envelope, default-deny, write-gate incl. cross-customer replay, PII redaction, fail-closed, idempotency, async 202, retry txn-stability, 429 backoff). ruff + mypy --strict clean. (Project-wide 80% coverage gate runs in CI; this milestone validated locally for the bridge modules.)

**Remaining to make it live end-to-end:** (1) ~~probe-confirm~~ **DONE 2026-05-29**; (2) ~~resolve the rate-limit blocker with Maestra~~ **DONE 2026-06-01** (token bucket async ≤5 / sync ≤3 RPS; bulk feasible); (3) marketing subscribes L03/L09 flows to the `triggerFlow` `"Operation triggered"` event; (4) `chat_bridge` mints approval tokens to unlock writes; (5) rotate the LIVE hardcoded Delta Sharing token `1TWM…` (the GitHub PAT is now rotated).

## CSO audit status (initial 2026-05-19, updated 2026-06-01)
**Original:** 3 CRITICAL · 7 HIGH · 10 MEDIUM. Live status:
- **F5 (network_mode: host)** — **CLOSED** by ADR-0013 (mcp_bridge now on standard internal network).
- **F10 (WG peer CIDR)** — **N/A** while ENABLE_WIREGUARD=false (default).
- **F16 (Maestra Bearer token)** — downgraded to MEDIUM; still long-lived static; rotation needs ADR-0013 §6 Q6.
- **PII egress** — bridge now redacts at egress (structural + pii_guard cascade, fail-closed) per ADR-0016 §2.3; HIGH item #3 below partially addressed in code (canary still pending).
- Other CRITICAL/HIGH items unchanged. Top blockers before prod data:
  1. ~~**CRITICAL** — rotate compromised GitHub PAT `ghp_0MX…`~~ **CLOSED 2026-06-01:** revoked 2026-05-29; the dead token has now been removed from `/root/.git-credentials` and replaced with a working least-privilege PAT (Contents-RW on both repos); push to origin + mirror verified. (Same token in CloudStrix `settings.local.json` still needs re-credentialing — separate project.)
  2. **CRITICAL (new, surfaced 2026-06-01)** — Maestra **Delta Sharing token `1TWM…` is LIVE and hardcoded** as `DEFAULT_TOKEN` in `scripts/{onfy_year_analysis,m06_pipeline,m06_delta_fetcher}.py` (+ referenced in several docs), and mirrored to `onfycode`. Verified live (`GET /shares` → 200). It is a **different value** from the env token now provisioned to the tg-bridge (`MAESTRA_DELTA_SHARING_TOKEN`), i.e. not a rotation. **Rotate in Maestra + move scripts to read from env.**
  3. **CRITICAL** — replace placeholder age keys in `.sops.yaml`.
  4. **HIGH** — PII guard egress enforcement: structural + cascade now in `mcp_bridge`; still needs mandatory-proxy + weekly canary.
  5. **HIGH** — Audit log schema lacks `prev_hash` despite hash-chain claim.
  6. **HIGH** — Postgres rotation script lacks server-side rotation; Restic rotation script breaks prior snapshots.

(Prompt-injection defense added 2026-05-19; needs second CSO pass.)

## Open vendor questions (ADR-0013 §6 — route via Onfy's Maestra account channel)
1. Maestra auth model — real machine API key or just admin password + 2FA? ✅ **Answered:** Bearer token for Delta Sharing (separate from REST API auth)
2. Data residency (EU vs other) — DPA + SCC implications. ✅ **Answered:** data at rest in Germany (eu-central-1).
3. Rate limits per token / per tool. ✅ **RESOLVED (OQ-V3, 2026-06-01)** — vendor raised the `onfy.agent` method priority; distinct-ID re-ramp → sync `CustomerGetData` 8 RPS / async `customerEditByID` 10 RPS clean; bulk feasible (~3 h). Token bucket async ≤5 / sync ≤3 RPS. Report `docs/reports/maestra_async_ramp_2026-06-01.md`.
4. Webhook subscription model for push events (payment_error, delivery_confirmed, etc.).
5. Credential rotation API — manual UI flow or automatable? (OQ-V4: manual via CSM until self-service ships.)

## Outstanding work (priority)
1. **NOW (SEC)** — rotate the LIVE hardcoded Delta Sharing token `1TWM…` in Maestra + move `scripts/*` to read `MAESTRA_DELTA_SHARING_TOKEN` from env (env already provisioned); replace `.sops.yaml` placeholder keys
2. **P0** — resume the operator pilots on the now-feasible rate budget (de-bounce / win-back as ~3 h batch jobs at async ≤5 RPS)
3. **P0** — audit hash-chain, fix rotation scripts, harden PII egress (mandatory-proxy + canary)
4. **P0** — implement `scripts/gdpr_request.py` SQL (Art. 15/17, 72 h SLA)
5. **P0** — second CSO audit pass (post-channel + post-Maestra-transport + post-bridge-v3)
6. **P1** — `chat_bridge` approval-token issuance (Slack `:thumbsup:`) to unlock write ops (writes are 412 until then)
7. **P1** — marketing subscribes L03/L09 to `triggerFlow` event (probe-confirm DONE)
8. **P1** — first staging deploy via `./scripts/bootstrap.sh --env staging`
9. **P1** — daily sync pipeline: Delta Sharing → PostgreSQL (per ADR-0017) — **scope narrowed** to product→brand/basket dimensions now that DS freshness is confirmed (no longer needed for freshness)
10. **P2** — build malicious-corpus library for weekly prompt-injection canary
11. **P2** — retention campaigns based on year analysis (target 88% single-order → 20% repeat)

## Completed work milestones
- **2026-05-19** — Initial scaffold (200+ files), ADR-0013 accepted
- **2026-05-22** — Delta Sharing endpoint discovered and tested (sample data: 910 orders, €42K)
- **2026-05-23** — Full year analysis completed (329K orders, €16.9M), script and report pushed to repo
- **2026-05-23** — M06 retention pipeline completed (7,902 actions for 14,104 loyal customers), results pushed to repo (commit 8500869)
- **2026-05-28** — Vendor OQ batch (27/36 resolved; V2 residency=Germany closed); first live Maestra v3 call via `onfy.agent` (`CustomerGetData` → 200)
- **2026-05-29** — onfy.agent op set verified (real System names; all 4 customer ops already bound); `triggerFlow` op 1895 created; commit 959397b pushed origin+mirror
- **2026-05-29** — `mcp_bridge` wired to Maestra v3 RPC op-set (v0.2.0→v0.3.0): write-gate (§2.4) + PII egress redaction (§2.3) + idempotency/async (§2.5); 22 unit tests, ruff + mypy --strict clean; commit **1b0f93a** pushed origin+mirror
- **2026-05-29** — `onfy.agent` op-set **probe-confirmed live** (6 controls; `CustomerGetData`/`triggerFlow`→200; `MessageSend`→403 = exists-but-unbound); commit **3bdd50e** pushed origin+mirror
- **2026-05-29** — Write-op binding re-probe (`customerEditByID/ByEmail/customerReimport`→200 = all bound; `returns-validation-errors` OFF ⇒ bridge Pydantic validation load-bearing); commit **6d7f54d**
- **2026-05-29** — DS re-analysis (list-hygiene lever = 34,797 bounce∩subscribed = 11.4% of consented base); two operator pilots authored (`debounce_pilot.py` + `winback_rfm.py`); commit **784f609**
- **2026-05-29** — Rate-limit blocker discovered (even 1 RPS → ~60% 429 on `onfy.agent`, OQ-V3 reopened); bridge hardened for 429 (Retry-After backoff, 24 tests); vendor evidence pack authored; **HEAD 7dff003** pushed origin+mirror
- **2026-06-01** — **OQ-V3 rate-limit RESOLVED**: vendor raised the `onfy.agent` method priority; clean distinct-ID re-ramp → sync `CustomerGetData` 8 RPS / async `customerEditByID` 10 RPS clean (the 2026-05-29 sub-1-RPS retracted as a constant-fake-ID per-contact artefact); `triggerFlow` single-shot 200 (no-op, same async class); bulk de-bounce/win-back now feasible (~3 h batch jobs at async ≤5 RPS); report `maestra_async_ramp_2026-06-01.md`; commit **2b14310** pushed origin+mirror (`main` ff `7dff003→2b14310`). **Push credential restored** (revoked `ghp_0MX…` removed from `/root/.git-credentials`, working PAT in place). **DS staged-freeze overturned** (our `m06_delta_fetcher` early-break bug, not a vendor freeze — share fresh to today). Live DS token `1TWM…` surfaced as a still-open secret to rotate.

## Timeline

- **2026-06-01** | **OQ-V3 rate-limit RESOLVED** — vendor raised the `onfy.agent` method priority; clean distinct-ID re-ramp → sync `CustomerGetData` 8 RPS / async `customerEditByID` 10 RPS clean (the 2026-05-29 "sub-1-RPS" was a constant-fake-ID per-contact artefact). `triggerFlow` single-shot 200, no contact created (same async class). Bulk de-bounce 34.8k / win-back 31.9k now feasible (~3 h batch jobs); token bucket async ≤5 / sync ≤3 RPS. Committed 2b14310 + report `maestra_async_ramp_2026-06-01.md`; pushed origin+mirror (`main` ff 7dff003→2b14310). Push credential restored (revoked ghp_0MX… removed from /root/.git-credentials, working PAT in place). Separately: DS "staged-freeze" overturned (our fetcher early-break bug, not vendor — share fresh to today). Surfaced: live hardcoded DS token 1TWM… still to rotate. [Source: User session (Telegram bridge), 2026-06-01]
- **2026-05-29** | Rate-limit blocker discovered: even 1 RPS → ~60% 429 on `onfy.agent` (sustained sub-1-RPS); vendor "8k/method/min" off by ~2 orders of magnitude ⇒ **OQ-V3 reopened**; bulk per-customer ops (de-bounce 34.8k / win-back 32k) infeasible as <1-RPS loops. Bridge hardened for 429 (Retry-After backoff, 24 tests green). Vendor evidence pack authored; user left to ask Maestra (test-vs-prod quota / bulk path). HEAD 7dff003 pushed origin+mirror. [Source: User session, 2026-05-29]
- **2026-05-29** | DS re-analysis (list-hygiene lever = 34,797 bounce∩subscribed, 11.4% of consented base); two operator pilots authored (de-bounce + RFM win-back), commit 784f609. OQ#1 (ID-space) closed: DS unmergedCustomerId == API customerID. [Source: User session, 2026-05-29]
- **2026-05-29** | Write-op binding re-probe: `customerEditByID/ByEmail/customerReimport`→200 (all API-bound); `returns-validation-errors` OFF ⇒ Maestra silently accepts malformed writes ⇒ bridge Pydantic validation load-bearing; commit 6d7f54d. [Source: User session, 2026-05-29]
- **2026-05-29** | `onfy.agent` op-set probe-confirmed live (prod, read-only/no-op): `CustomerGetData`/`triggerFlow`→200; `MessageSend`→403 (**exists but unbound** — corrected the earlier "doesn't exist" claim across ADR-0016/FLOW_TRIGGERS/vendor-questions/partner-brief/ADR-0022 + probe script); auth-header parity confirmed; commit 3bdd50e pushed origin+mirror. [Source: User session, 2026-05-29]
- **2026-05-29** | `mcp_bridge` wired to live Maestra v3 RPC op-set (ADR-0016 §2.2–2.6): write-gate + PII egress redaction + idempotency/async; 22 tests green (ruff + mypy --strict clean); commit 1b0f93a pushed origin+mirror. Writes default-denied until chat_bridge mints approval tokens. [Source: User session, 2026-05-29]
- **2026-05-29** | onfy.agent op set verified live (real System names; all 4 customer ops already bound to `Other #1`); `triggerFlow` op 1895 authored; commit 959397b pushed origin+mirror. [Source: User session, 2026-05-29]
- **2026-05-28** | Vendor OQ batch 27/36 resolved (V2 residency=Germany closed); first validated live Maestra v3 call via `onfy.agent` (`CustomerGetData` → 200). [Source: User session, 2026-05-28]
- **2026-05-23** | M06 retention pipeline completed — 7,902 actions generated for 14,104 loyal customers. Results pushed to repo. [Source: User session, 2026-05-23]
- **2026-05-23** | Full year analysis completed — 329,984 orders, €16.9M revenue. Script and report pushed to repo. [Source: User session, 2026-05-23]
- **2026-05-22** | Delta Sharing endpoint discovered and tested — 910 orders sample, €42K revenue. [Source: User session, 2026-05-22]
- **2026-05-19** | Initial scaffold completed — 200+ files, ADR-0013 accepted, CSO audit initiated. [Source: User session, 2026-05-19]

## Inversion vs. the email-automation project
[[projects/onfy-email-automation]] is *content* (flows, copy, segments). This
project is the *tooling* that makes a human + agent pair able to ship those
flows safely and faster. The two move on different cadences; the contract
between them is narrow: the agent only talks to the Maestra REST API via
`mcp_bridge`, and nothing else.

**Now with data:** Delta Sharing integration enables the agent to access bulk analytical data (orders, segments, mailings) for data-driven flow design. The year analysis (329K orders) provides baseline metrics for campaign effectiveness measurement.

**M06 pipeline:** First production use of Delta Sharing data — automated retention actions for loyal customers, demonstrating the value of data-driven CRM automation.
