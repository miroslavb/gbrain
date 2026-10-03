import type { Migration } from './types.ts';

export const v147: Migration = {
    version: 147,
    name: 'world_only_host_visibility',
    // This deployment is single-principal: every agent attached to the host
    // must see the same brain. Keep the legacy enum value readable so old
    // dumps/fences can be imported, but remove every storage/default path that
    // can create a hidden tier. Source isolation and document ACL are separate
    // boundaries and intentionally unchanged.
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
