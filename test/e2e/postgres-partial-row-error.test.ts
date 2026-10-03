import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import postgres from '#postgres';
import { requirePostgresTestDatabase } from '../helpers/test-backends.ts';

const drivers = { esm: postgres, cjs: createRequire(import.meta.url)('#postgres') as typeof postgres };
for (const [name, factory] of Object.entries(drivers)) {
  test(`${name}: a partial-row SQL error cannot put holes in the successor result`, async () => {
    const sql = factory(requirePostgresTestDatabase(), { max: 1 });
    try {
      const [{ pid }] = await sql.unsafe('SELECT pg_backend_pid() AS pid');
      await expect((async () => await sql.unsafe('SELECT i,10/(3-i) AS value FROM generate_series(1,3) i'))()).rejects.toMatchObject({ code: '22012' });
      const rows = await sql.unsafe("SELECT 'healthy' AS marker,pg_backend_pid() AS pid");
      expect(rows).toHaveLength(1);
      expect(rows[0].marker).toBe('healthy');
      expect(rows[0].pid).toBe(pid);
      expect(Object.keys(rows)).toEqual(['0']);
    } finally { await sql.end({ timeout: 1 }); }
  });

  test(`${name}: cancellation after a delivered row resets the successor index on the same connection`, async () => {
    let cancel: (() => Promise<void>) | undefined;
    let cancellation: Promise<void> | undefined;
    let delivered = 0;
    const sql = factory(requirePostgresTestDatabase(), { max: 1, transform: { row: { from(row) {
      if (row.marker === 'cancel-before-completion') {
        delivered++;
        queueMicrotask(() => { cancellation ??= cancel!(); });
      }
      return row;
    } } } });
    const conn = await sql.reserve();
    try {
      const [{ pid }] = await conn.unsafe('SELECT pg_backend_pid() AS pid');
      // Enough rows to flush a complete DataRow before the final sleeping row.
      const pending = conn.unsafe("SELECT 'cancel-before-completion' AS marker,repeat('x',16384) AS padding,pg_sleep(CASE WHEN i=100 THEN 30 ELSE 0 END) FROM generate_series(1,100) i", [], { cancelFence: true });
      cancel = () => pending.cancel();
      await expect((async () => await pending)()).rejects.toMatchObject({ code: '57014' });
      await cancellation;
      expect(delivered).toBeGreaterThan(0);
      expect(delivered).toBeLessThan(100);
      const rows = await conn.unsafe("SELECT 'healthy' AS marker,pg_backend_pid() AS pid");
      expect(rows).toHaveLength(1);
      expect(rows[0].marker).toBe('healthy');
      expect(rows[0].pid).toBe(pid);
      expect(Object.keys(rows)).toEqual(['0']);
    } finally { conn.release(); await sql.end({ timeout: 1 }); }
  }, 10_000);
}
