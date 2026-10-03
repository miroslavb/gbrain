import type { Migration } from './types.ts';

export const v152: Migration = {
    version: 152,
    name: 'world_only_host_visibility_convergence_guard',
    // A disposable DB may have run the pre-world-only v0.47.3 candidate,
    // where fork-renumbered upstream migrations occupied v147-v150. The
    // ledger is version-only, so such a DB would otherwise skip canonical
    // v147. Re-apply the host invariant after the upstream train; this is an
    // idempotent no-op for production, which already applied v147 correctly.
    idempotent: true,
    sql: `
      UPDATE facts
         SET visibility = 'world'
       WHERE visibility = 'private';

      ALTER TABLE facts ALTER COLUMN visibility SET DEFAULT 'world';

      UPDATE pages
         SET frontmatter = COALESCE(frontmatter, '{}'::jsonb)
                           || '{"visibility":"world"}'::jsonb
       WHERE frontmatter->>'visibility' = 'private';
    `,
    handler: async (engine) => {
      await engine.setConfig('facts.default_visibility', 'world');
    },
    verify: async (engine) => {
      const rows = await engine.executeRaw<{
        private_facts: number;
        private_pages: number;
        world_default: boolean;
      }>(`
        SELECT
          (SELECT COUNT(*)::int FROM facts WHERE visibility = 'private') AS private_facts,
          (SELECT COUNT(*)::int FROM pages WHERE frontmatter->>'visibility' = 'private') AS private_pages,
          EXISTS (
            SELECT 1
              FROM information_schema.columns
             WHERE table_schema = 'public'
               AND table_name = 'facts'
               AND column_name = 'visibility'
               AND column_default ILIKE '%world%'
          ) AS world_default
      `);
      return rows[0]?.private_facts === 0
        && rows[0]?.private_pages === 0
        && rows[0]?.world_default === true
        && (await engine.getConfig('facts.default_visibility')) === 'world';
    },
  };
