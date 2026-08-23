#!/usr/bin/env python3
"""Mark a conversation page as non-extractable (operator decision).

Inserts the same durable audit row the extractor's own
buildNonExtractableAuditRow() writes, so findFreshExtractionOutcomes()
suppresses future LLM extraction for this page snapshot.

Usage: python3 mark_non_extractable.py <slug> <reason>
"""
import re
import subprocess
import sys

SLUG = sys.argv[1]
REASON = sys.argv[2].replace("'", "''")

DB = "json.load(open('/root/.gbrain/config.json')).get('database_url','')"
q = f"""
PGPASSWORD=$(python3 -c "
import re,json
u={DB}
m=re.search(r'://([^:]+):([^@]+)@',u)
print(m.group(2) if m else '')") psql "$(python3 -c "
import json
print({DB})")" -tAc "SELECT content_hash, coalesce(effective_date::date::text,'none') FROM pages WHERE slug='{SLUG}'"
"""
r = subprocess.run(['bash', '-lc', q], capture_output=True, text=True, timeout=60)
line = r.stdout.strip().split('|')
if len(line) != 2:
    print('page not found or bad output:', r.stdout, r.stderr)
    sys.exit(1)
chash, edate = line[0], line[1]
token = f'page-{chash}-{edate}'
source = 'cli:extract-conversation-facts:non-extractable:v2'

ins = f"""
PGPASSWORD=$(python3 -c "
import re,json
u={DB}
m=re.search(r'://([^:]+):([^@]+)@',u)
print(m.group(2) if m else '')") psql "$(python3 -c "
import json
print({DB})")" -c "
INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, context, source, source_session, confidence, source_markdown_slug, row_num)
VALUES ('default', NULL, 'EXTRACTION_NOT_APPLICABLE', 'fact', 'private', 'low',
        'scanned, not extractable: operator decision — {REASON}',
        '{source}', '{source}:{SLUG}:{token}', 1.0, '{SLUG}', 0)
ON CONFLICT DO NOTHING
RETURNING id"
"""
r2 = subprocess.run(['bash', '-lc', ins], capture_output=True, text=True, timeout=60)
print(r2.stdout.strip() or r2.stderr.strip())
