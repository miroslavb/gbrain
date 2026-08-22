---
type: concept
title: Maestra triggerFlow (op 1895) — Email Send Spec v2
created: '2026-06-18T00:00:00.000Z'
updated: '2026-06-18T00:00:00.000Z'
ingested_via: put_page
ingested_at: '2026-06-18T15:10:33.410Z'
source_kind: put_page
tags:
  - api-spec
  - email
  - maestra
  - onfy
  - triggerflow
---

# Maestra triggerFlow (op 1895) — Email Send Spec v2

**Confirmed:** 2026-06-18. Maestra updated method 1895 ("Agent - Trigger flow") to send emails directly. The old `operationCustomParameters` (Variable 1..10 mapping) is superseded by `emailMailing.customParameters`.

Related: [[projects/onfy-maestra-agent]], [[concepts/onfy-maestra-delta-sharing]]

## Endpoint

```
POST https://api.maestra.io/v3/operations/sync?endpointId={endpointId}&operation=triggerFlow
Content-Type: application/json; charset=utf-8
Accept: application/json
Authorization: SecretKey {SecretKey}
```

## Request body (new)

```json
{
  "executionDateTimeUtc": "<optional, for backdated execution>",
  "customer": {
    "ids": {
      "customerID": "<Customer ID>"
    }
  },
  "emailMailing": {
    "customParameters": {
      "subject":         "...",
      "preheader":       "...",
      "headline":        "...",
      "bodyParagraph1":  "...",
      "bodyParagraph2":  "...",
      "bodyParagraph3":  "...",
      "ctaUrl":          "...",
      "ctaText":          "..."
    },
    "attachments": [
      {
        "fileName": "<Attached file name>",
        "body": {
          "fileId": "<Attached file ID (UUID)>"
        }
      }
    ]
  }
}
```

## Key differences from old spec

| Aspect | Old spec | New spec (2026-06-18) |
|--------|----------|----------------------|
| Parameter container | `operationCustomParameters` | `emailMailing.customParameters` |
| Mode | async | **sync** (immediate send) |
| Attachments | not supported | `emailMailing.attachments[]` (optional, via fileId) |
| Backdated execution | not supported | `executionDateTimeUtc` (optional) |
| Response on success | "Operation triggered" | `{"status": "Success"}` |

## Auth

- Header: `Authorization: SecretKey {MAESTRA_SECRET_KEY_ONFY_AGENT}`
- Endpoint ID: `onfy.agent`
- SecretKey and MAESTRA_API_KEY are the same value (alias)

## Attachments — fileId logic (tested 2026-06-18)

`fileId` is a UUID extracted from a Maestra CDN URL:

```
https://ei.mstrimg.com/{UUID}/{filename}.png
                ^^^^^^^^
                this is the fileId
```

Example: `https://ei.mstrimg.com/b6fc7987-66d0-4632-9807-c36165351098/2.png`
→ `fileId = "b6fc7987-66d0-4632-9807-c36165351098"`

The file must already be hosted on Maestra CDN. Arbitrary external URLs (Google CDN, own server) are NOT accepted as fileId.

### Attachment renders INLINE

Tested on fresh account `agent-test-attach-real-02` (miroslav.babitski@gmail.com):
- Email delivered with `logo.png` attachment
- Logo visible **inline** in email body (not just as downloadable file)
- Both logo (template default) and attached image rendered in the email

## Critical: triggerFlow cooldown (tested 2026-06-18)

**`{"status": "Success"}` ≠ delivered.** triggerFlow has a per-customer cooldown:

| Test | Account | Prior emails | Result |
|------|---------|-------------|--------|
| 1st email | agent-test-attach-real-01 | none | ✅ delivered |
| 2nd email (same account) | agent-test-attach-real-01 | 1 prior | ❌ suppressed (cooldown) |
| 1st email (fresh account) | agent-test-attach-real-02 | none | ✅ delivered |

Rules:
1. **First triggerFlow on a fresh customer** → always delivers
2. **Subsequent triggerFlow on same customer** → API returns `Success` but email is NOT delivered (cooldown / dedup)
3. Cooldown window duration: unknown (needs Maestra team clarification)
4. This is flow-level logic, not API-level — the trigger is accepted, the flow decides to suppress

## Test results (2026-06-18)

| Account | HTTP | Response | Delivered | Notes |
|---------|------|----------|-----------|-------|
| agent-test-marketing-admin | 200 | Success | ✅ | first test, no attachment |
| agent-test-miroslav-babitski | 200 | Success | ✅ | first test, no attachment |
| agent-test-attach-real-01 | 200 | Success | ✅ | Probe 1 (no attach) delivered |
| agent-test-attach-real-01 | 200 | Success | ❌ | Probe 2 (with attach) — cooldown |
| agent-test-attach-real-02 | 200 | Success | ✅ | ATTACH-ONLY — delivered with logo inline |

## Implementation

- Script: `scripts/test_email_campaign.py` in [onfy-maestra-agent repo](https://github.com/miroslavb/onfy-maestra-agent/pull/42)
- PR: [#42](https://github.com/miroslavb/onfy-maestra-agent/pull/42)
- Branch: `feat/triggerflow-email-spec-v2`
- Commits: `65526c1` (spec update), `1422137` (attachment + findings)
- Multi-source .env loader: secrets file > EC2 .env > local placeholder
- Auto-fixes MAESTRA_API_BASE missing `/v3/operations` suffix

[Source: User, 2026-06-18]
