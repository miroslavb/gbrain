---
type: note
title: GBrain audit remediation completion — 2026-08-31
date: '2026-08-31'
status: completed
visibility: world
captured_at: '2026-08-31T01:28:28.916Z'
captured_via: capture-cli
ingested_via: put_page
ingested_at: '2026-08-31T01:28:30.463Z'
source_kind: put_page
tags:
  - atoms
  - audit
  - gbrain
  - recovery
  - security
---

# GBrain audit remediation completion — 2026-08-31

## Production taxonomy

- Protected job `#80564` converted 165 `session` pages to `conversation` and 97 pages across 14 rare types to `note`, preserving `frontmatter.legacy_type`; exact-window verification found zero mismatches. [Source: production job 80564 read-back and `/root/gbrain-p0-backups/20260830T230518Z-unify-atoms-backup/OPERATIONS_RECEIPT.md`, 2026-08-31]
- The active schema pack is `gbrain-base-v2@1.2.1+3ca87070`. [Source: `gbrain schema active` read-back, 2026-08-31]

## Atom extraction

- The authorized remaining-source drain completed across 17 sources and 113 bounded batches using up to four source-scoped workers; the stabilized global atom backlog is zero. [Source: aggregate atom-worker receipts and production backlog audit, 2026-08-31]
- The run produced 524 new active atom rows after idempotency; all passed canonical hash, source-hash, provenance, exact-quote, contiguous-source, single-sentence, self-contained, and sensitive-content audits with zero violations. [Source: production structural and deterministic atom audits, 2026-08-31]
- Forty-seven source pages were tombstoned fail-closed after repeated deterministic malformed output; there were zero provider errors, validator errors, failed reports, or non-zero worker exits. [Source: aggregate atom-worker receipts, 2026-08-31]
- Routing remained GLM-first with fallback to `openai:gpt-5.6-terra`; a direct no-content probe showed that Ollama.com had reached its weekly usage limit, explaining Terra latching. [Source: synthetic gateway probe and worker route receipts, 2026-08-31]

## Credential-redacted OpenClaw recovery

- Private recovery repositories are [openclaw-knowledge](https://github.com/miroslavb/openclaw-knowledge) at `b140f76b7b53a273d0c20e9abcdd24102cad3d4c`, [openclaw-projects](https://github.com/miroslavb/openclaw-projects) at `a186eed92fa9a3f1d6870f65d70cb0d87704d7eb`, and [openclaw-sessions](https://github.com/miroslavb/openclaw-sessions) at `8eff2a9ace26cc4abd4e482134f88e339436f1f7`. All three were read back as `PRIVATE`. [Source: GitHub repository and remote-SHA read-backs, 2026-08-31]
- Forty-three credential-shaped occurrences were replaced; the final broad tree scan returned zero. Raw rescue checkout push URLs are disabled. [Source: local sanitized-tree scan and Git remote read-back, 2026-08-31]
- `openclaw-knowledge` and `openclaw-sessions` were deleted and recreated after an initial force-push left old objects addressable; the recreated repositories have distinct IDs and both pre-rewrite SHA now return GitHub `404`. `openclaw-projects` was unchanged. [Source: operator authorization plus GitHub API read-backs, 2026-08-31]
- The temporary OAuth `delete_repo` scope was removed after recreation; the primary GitHub CLI token returned to `gist`, `read:org`, and `repo`. [Source: `gh auth status` read-back, 2026-08-31]
- Any of the eight late-found historical credentials that could still be live should be revoked or rotated; repository purge does not replace credential rotation. [Source: security remediation assessment, 2026-08-31]

## Final acceptance

- Production doctor is healthy at 100/100 with no top issues; backup coverage is `overall: ok`, `no_remote: 0`, `pages_at_risk: 0`; the global atom backlog is zero. [Source: fresh production doctor, backup, and backlog read-backs, 2026-08-31]
- The authoritative mode-0600 operations receipt is `/root/gbrain-p0-backups/20260830T230518Z-unify-atoms-backup/OPERATIONS_RECEIPT.md`, SHA-256 `a98e5aacb2b66f8cae2fe2444cc74af41c435876115678c52ea94c4562b9c0c6`. [Source: local checksum and stat read-back, 2026-08-31]

## Related

- [GBrain project](../projects/gbrain.md)
