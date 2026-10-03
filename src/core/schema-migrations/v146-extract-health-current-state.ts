import type { Migration } from './types.ts';

export const v146: Migration = {
    version: 146,
    name: 'extract_health_current_state',
    // Seven-day rollups are historical telemetry, not current state. Keep a
    // compact per-(kind,source) outcome so doctor can distinguish an old halt
    // from an extractor that recovered on a later bounded run.
    idempotent: true,
    sql: `
      CREATE TABLE IF NOT EXISTS extract_health_state (
        kind TEXT NOT NULL,
        source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        last_outcome TEXT NOT NULL CHECK (last_outcome IN ('halt', 'completed', 'unknown')),
        last_outcome_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        consecutive_halts INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_halts >= 0),
        consecutive_completions INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_completions >= 0),
        PRIMARY KEY (kind, source_id)
      );

      INSERT INTO extract_health_state
        (kind, source_id, last_outcome, last_outcome_at,
         consecutive_halts, consecutive_completions)
      SELECT DISTINCT ON (r.kind, r.source_id)
        r.kind,
        r.source_id,
        CASE
          WHEN r.halt_count > 0 AND r.round_completed_count > 0 THEN 'unknown'
          WHEN r.round_completed_count > 0 THEN 'completed'
          WHEN r.halt_count > 0 THEN 'halt'
          ELSE 'unknown'
        END,
        r.updated_at,
        CASE WHEN r.halt_count > 0 AND r.round_completed_count = 0 THEN r.halt_count ELSE 0 END,
        CASE WHEN r.round_completed_count > 0 AND r.halt_count = 0 THEN r.round_completed_count ELSE 0 END
      FROM extract_rollup_7d r
      JOIN sources s ON s.id = r.source_id
      ORDER BY r.kind, r.source_id, r.day DESC, r.updated_at DESC
      ON CONFLICT (kind, source_id) DO NOTHING;
    `,
    verify: async (engine) => {
      const rows = await engine.executeRaw<{ columns: number; pk_exists: boolean }>(`
        SELECT
          COUNT(*) FILTER (WHERE c.column_name IN (
            'kind','source_id','last_outcome','last_outcome_at',
            'consecutive_halts','consecutive_completions'
          ))::int AS columns,
          EXISTS (
            SELECT 1 FROM pg_constraint
             WHERE conrelid = 'extract_health_state'::regclass
               AND contype = 'p'
          ) AS pk_exists
        FROM information_schema.columns c
        WHERE c.table_schema='public' AND c.table_name='extract_health_state'
      `);
      return rows[0]?.columns === 6 && rows[0]?.pk_exists === true;
    },
  };
