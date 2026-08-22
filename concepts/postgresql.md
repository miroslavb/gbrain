---
type: concept
title: Postgresql
validate: false
ingested_via: put_page
ingested_at: '2026-08-13T03:55:44.120Z'
source_kind: put_page
tags:
  - database
  - infrastructure
---

# PostgreSQL — RDBMS

Основная БД для GBrain (PG16 @ localhost:5432/gbrain) и проектов (BiometalDB, SecEco).

## Key Facts
- GBrain: user=gbrain, db=gbrain, pgvector + pg_trgm extensions
- Schema v13 (migrated from v4 2026-04-20)
- Connection: `[REDACTED CONNECTION URI]`
- 767 JSONB rows repaired during migration

## Pitfalls
- PGLite НЕ подходит для multi-agent — только single-process
- JSONB может потребовать repair после миграций

Credential-bearing connection URI removed from the knowledge page; runtime credentials remain in the protected local configuration only. [Source: Security remediation, 2026-08-13]
