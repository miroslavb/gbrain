import type { Migration } from './types.ts';

export const v144: Migration = {
    version: 144,
    name: 'take_proposal_rejection_reason_jsonb_object',
    // Positional executeRaw + JSON.stringify stored a JSONB string scalar in
    // real Postgres (PGLite hid the mismatch). Repair those receipts and make
    // the aggregate-only histogram shape a database invariant.
    idempotent: true,
    sql: `
      UPDATE proposal_page_runs
         SET rejection_reason_counts = (rejection_reason_counts #>> '{}')::jsonb
       WHERE jsonb_typeof(rejection_reason_counts) = 'string';
      ALTER TABLE proposal_page_runs
        DROP CONSTRAINT IF EXISTS proposal_page_runs_rejection_reason_counts_object_check;
      ALTER TABLE proposal_page_runs
        ADD CONSTRAINT proposal_page_runs_rejection_reason_counts_object_check
        CHECK (jsonb_typeof(rejection_reason_counts) = 'object');
    `,
    verify: async (engine) => {
      const rows = await engine.executeRaw<{ invalid: number; constraint_exists: boolean }>(`
        SELECT
          COUNT(*) FILTER (WHERE jsonb_typeof(rejection_reason_counts) <> 'object')::int AS invalid,
          EXISTS (
            SELECT 1 FROM pg_constraint
             WHERE conrelid = 'proposal_page_runs'::regclass
               AND conname = 'proposal_page_runs_rejection_reason_counts_object_check'
          ) AS constraint_exists
        FROM proposal_page_runs
      `);
      return rows[0]?.invalid === 0 && rows[0]?.constraint_exists === true;
    },
  };
