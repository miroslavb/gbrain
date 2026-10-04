/** Derived rows and their terminal receipt must survive or roll back together.
 * Real managed PGLite and source guard; no coordinator or journal mocks. */
import { expect, test } from 'bun:test';
import { managedBrain } from './helpers/managed-brain.ts';
import { withDerivedFactsWrite } from '../src/core/persistence/derived-facts.ts';

test('derived facts commit with their attributed receipt; callback failure rolls back facts, receipt and counters', async () => {
  await managedBrain(async ({ engine }) => {
    const write = (fact: string) => withDerivedFactsWrite(engine, 'default', ['people/example'], async tx => {
      await tx.insertFact({ fact, entity_slug: 'people/example', source: 'fixture:derived', visibility: 'world' }, { source_id: 'default' });
      if (fact === 'rolled back') throw new Error('sidecar changed');
      return 7;
    });
    expect(await write('committed fact')).toBe(7);
    const receipts = () => engine.executeRaw<{ id: string; state: string; n: number }>(
      `SELECT r.id::text,r.state,count(f.id)::int AS n FROM persistence_requests r
       LEFT JOIN facts f ON f.write_request_id=r.id
       WHERE r.intent->>'kind'='derived_facts_transaction' GROUP BY r.id ORDER BY r.id`);
    const before = await receipts();
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ state: 'committed', n: 1 });
    const counters = () => engine.executeRaw('SELECT key,outstanding_count,intent_bytes,lifetime_ids,terminal_bytes FROM persistence_counters ORDER BY key');
    const counts = await counters();
    await expect(write('rolled back')).rejects.toThrow('sidecar changed');
    expect(await receipts()).toEqual(before);
    expect(await counters()).toEqual(counts);
    expect(await engine.executeRaw("SELECT id FROM facts WHERE fact='rolled back'")).toEqual([]);
  });
}, 60_000);
