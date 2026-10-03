import type { Migration } from './types.ts';

export const v142: Migration = {
    version: 142,
    name: 'grounded_take_proposal_receipts',
    // The legacy queue predates grounded evidence and per-page terminal
    // receipts. Keep those rows as audit history (NULL evidence/source_hash),
    // while new producer runs publish proposals and a terminal page receipt
    // atomically. Successful receipts become the hardened idempotency and
    // acceptance authority; failed/quality-rejected attempts remain retryable.
    // Some production brains briefly shipped a v127 prototype with `outcome`,
    // a four-column primary key, and no surrogate id. Converge that shape
    // additively before creating indexes; CREATE IF NOT EXISTS does not alter
    // a table that already exists.
    // Keep in sync with schema.sql, pglite-schema.ts, and embedded schema.
    // Handler-only is intentional: postgres.js parses a multi-statement SQL
    // string before executing its leading ALTERs, so references to the newly
    // added `status` column fail against the v127 prototype. Separate calls in
    // one transaction make every DDL result visible to the next statement.
    idempotent: true,
    sql: '',
    handler: async (engine) => {
      await engine.transaction(async (tx) => {
        await tx.executeRaw(`ALTER TABLE take_proposals ADD COLUMN IF NOT EXISTS evidence_span TEXT`);
        await tx.executeRaw(`ALTER TABLE take_proposals ADD COLUMN IF NOT EXISTS source_hash TEXT`);
        await tx.executeRaw(`
          CREATE TABLE IF NOT EXISTS proposal_page_runs (
            id BIGSERIAL PRIMARY KEY,
            source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
            page_slug TEXT NOT NULL,
            source_hash TEXT NOT NULL,
            prompt_version TEXT NOT NULL,
            proposal_run_id TEXT NOT NULL,
            model_id TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('completed','empty','quality_rejected','failed')),
            proposal_count INTEGER NOT NULL DEFAULT 0 CHECK (proposal_count >= 0),
            evidence_span_count INTEGER NOT NULL DEFAULT 0 CHECK (evidence_span_count >= 0),
            error_code TEXT,
            completed_at TIMESTAMPTZ NOT NULL DEFAULT now()
          )
        `);
        await tx.executeRaw(`ALTER TABLE proposal_page_runs ADD COLUMN IF NOT EXISTS id BIGSERIAL`);
        await tx.executeRaw(`ALTER TABLE proposal_page_runs ADD COLUMN IF NOT EXISTS status TEXT`);
        await tx.executeRaw(`ALTER TABLE proposal_page_runs ADD COLUMN IF NOT EXISTS outcome TEXT`);
        await tx.executeRaw(`ALTER TABLE proposal_page_runs ADD COLUMN IF NOT EXISTS evidence_span_count INTEGER NOT NULL DEFAULT 0`);
        await tx.executeRaw(`ALTER TABLE proposal_page_runs ADD COLUMN IF NOT EXISTS error_code TEXT`);
        await tx.executeRaw(`
          UPDATE proposal_page_runs
             SET status = COALESCE(status, outcome),
                 evidence_span_count = CASE
                   WHEN COALESCE(status, outcome) = 'completed' THEN proposal_count
                   ELSE evidence_span_count
                 END
           WHERE status IS NULL
        `);
        await tx.executeRaw(`ALTER TABLE proposal_page_runs ALTER COLUMN status SET NOT NULL`);
        await tx.executeRaw(`ALTER TABLE proposal_page_runs DROP COLUMN IF EXISTS outcome`);
        await tx.executeRaw(`ALTER TABLE proposal_page_runs DROP CONSTRAINT IF EXISTS proposal_page_runs_pkey`);
        await tx.executeRaw(`ALTER TABLE proposal_page_runs ADD CONSTRAINT proposal_page_runs_pkey PRIMARY KEY (id)`);
        await tx.executeRaw(`
          CREATE UNIQUE INDEX IF NOT EXISTS proposal_page_runs_identity_idx
            ON proposal_page_runs (source_id, page_slug, source_hash, prompt_version, proposal_run_id)
        `);
        const statusCheck = await tx.executeRaw<{ exists: boolean }>(`
          SELECT EXISTS (
            SELECT 1 FROM pg_constraint
             WHERE conrelid = 'proposal_page_runs'::regclass
               AND conname = 'proposal_page_runs_status_check'
          ) AS exists
        `);
        if (!statusCheck[0]?.exists) {
          await tx.executeRaw(`
            ALTER TABLE proposal_page_runs ADD CONSTRAINT proposal_page_runs_status_check
              CHECK (status IN ('completed','empty','quality_rejected','failed'))
          `);
        }
        await tx.executeRaw(`
          CREATE INDEX IF NOT EXISTS proposal_page_runs_cache_idx
            ON proposal_page_runs (source_id, page_slug, source_hash, prompt_version)
            WHERE status IN ('completed','empty')
        `);
        await tx.executeRaw(`
          CREATE INDEX IF NOT EXISTS proposal_page_runs_run_idx
            ON proposal_page_runs (proposal_run_id, completed_at)
        `);
      });
    },
    verify: async (engine) => {
      const rows = await engine.executeRaw<{ column_count: number; identity_index: boolean }>(`
        SELECT
          (SELECT COUNT(*)::int FROM information_schema.columns
            WHERE table_schema='public' AND table_name='proposal_page_runs'
              AND column_name IN ('id','status','evidence_span_count','error_code')) AS column_count,
          to_regclass('public.proposal_page_runs_identity_idx') IS NOT NULL AS identity_index
      `);
      return rows[0]?.column_count === 4 && rows[0]?.identity_index === true;
    },
  };
