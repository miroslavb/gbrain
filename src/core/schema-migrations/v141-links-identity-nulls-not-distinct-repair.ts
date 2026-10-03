import type { Migration } from './types.ts';

export const v141: Migration = {
    version: 141,
    name: 'links_identity_nulls_not_distinct_repair',
    // The v11 migration originally installed an ordinary UNIQUE constraint
    // under the auto-generated *_key name. Its SQL was later strengthened in
    // place to NULLS NOT DISTINCT, but already-versioned brains never replay
    // old migrations. Because extracted markdown edges normally have
    // origin_page_id=NULL, ordinary UNIQUE treats every replay as distinct and
    // silently accumulates graph duplicates. Repair as a NEW migration: hold a
    // writer-blocking lock, retain the earliest row per canonical identity
    // (matching ON CONFLICT DO NOTHING semantics), then install the intended
    // PG15+/PGLite constraint. The helper index bounds the one-time window pass
    // on large brains and is removed after the constraint owns the same shape.
    idempotent: true,
    sql: `
      LOCK TABLE links IN SHARE ROW EXCLUSIVE MODE;
      CREATE INDEX IF NOT EXISTS idx_links_identity_repair_v141
        ON links(from_page_id, to_page_id, link_type, link_source, origin_page_id, id);
      WITH ranked AS MATERIALIZED (
        SELECT id,
               row_number() OVER (
                 PARTITION BY from_page_id, to_page_id, link_type, link_source, origin_page_id
                 ORDER BY id
               ) AS rn
          FROM links
      )
      DELETE FROM links l
       USING ranked r
       WHERE l.id = r.id AND r.rn > 1;
      ALTER TABLE links
        DROP CONSTRAINT IF EXISTS links_from_to_type_source_origin_key;
      ALTER TABLE links
        DROP CONSTRAINT IF EXISTS links_from_to_type_source_origin_unique;
      ALTER TABLE links
        ADD CONSTRAINT links_from_to_type_source_origin_unique
        UNIQUE NULLS NOT DISTINCT
        (from_page_id, to_page_id, link_type, link_source, origin_page_id);
      DROP INDEX IF EXISTS idx_links_identity_repair_v141;
    `,
    verify: async (engine) => {
      const rows = await engine.executeRaw<{ definition: string }>(`
        SELECT pg_get_constraintdef(oid) AS definition
          FROM pg_constraint
         WHERE conrelid = 'links'::regclass
           AND conname = 'links_from_to_type_source_origin_unique'
      `);
      return /UNIQUE NULLS NOT DISTINCT/i.test(rows[0]?.definition ?? '');
    },
  };
