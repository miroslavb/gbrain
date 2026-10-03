import type { Migration } from './types.ts';

export const v143: Migration = {
    version: 143,
    name: 'take_proposal_rejection_reason_receipts',
    // Aggregate-only first-failure counts make strict-contract misses
    // actionable without persisting source text, candidate text, or secret
    // fingerprints. Existing receipts converge to an empty histogram.
    idempotent: true,
    sql: `
      ALTER TABLE proposal_page_runs
        ADD COLUMN IF NOT EXISTS rejection_reason_counts JSONB NOT NULL DEFAULT '{}'::jsonb;
    `,
    verify: async (engine) => {
      const rows = await engine.executeRaw<{
        is_nullable: string;
        column_default: string | null;
        data_type: string;
      }>(`
        SELECT is_nullable, column_default, data_type
          FROM information_schema.columns
         WHERE table_schema='public'
           AND table_name='proposal_page_runs'
           AND column_name='rejection_reason_counts'
      `);
      const row = rows[0];
      return row?.is_nullable === 'NO' && row?.data_type === 'jsonb' && /\{\}/.test(row.column_default ?? '');
    },
  };
