import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { listTakeProposals } from '../src/commands/takes.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.executeRaw(
    `INSERT INTO take_proposals
       (source_id,page_slug,content_hash,prompt_version,proposal_run_id,claim_text,
        kind,holder,weight,model_id,evidence_span,source_hash,status)
     VALUES
       ('default','concepts/grounded','h1','v1','run-new','Grounded claim','take','brain',0.7,
        'test-model','Exact evidence.','sha256:v1:abc','pending'),
       ('default','concepts/legacy','h2','legacy','run-old','Legacy claim','take','brain',0.5,
        'legacy-model',NULL,NULL,'pending'),
       ('default','concepts/rejected','h3','v1','run-new','Rejected claim','take','brain',0.4,
        'test-model','Rejected evidence.','sha256:v1:def','rejected')`,
  );
});

describe('read-only take proposal consumer', () => {
  test('lists pending proposals and labels grounding without mutating status', async () => {
    const before = await engine.executeRaw<{ status: string; n: number }>(
      `SELECT status, COUNT(*)::int AS n FROM take_proposals GROUP BY status ORDER BY status`,
    );
    const rows = await listTakeProposals(engine, {
      sourceId: 'default',
      status: 'pending',
      limit: 50,
    });
    const after = await engine.executeRaw<{ status: string; n: number }>(
      `SELECT status, COUNT(*)::int AS n FROM take_proposals GROUP BY status ORDER BY status`,
    );

    expect(rows).toHaveLength(2);
    expect(() => JSON.stringify(rows)).not.toThrow();
    expect(typeof rows[0].id).toBe('string');
    expect(rows.find((row) => row.page_slug === 'concepts/grounded')?.grounding_status).toBe('grounded');
    expect(rows.find((row) => row.page_slug === 'concepts/legacy')?.grounding_status).toBe('legacy_unverified');
    expect(after).toEqual(before);
  });

  test('supports status/run filters and clamps limit', async () => {
    const rejected = await listTakeProposals(engine, {
      sourceId: 'default',
      status: 'rejected',
      runId: 'run-new',
      limit: 5000,
    });
    expect(rejected).toHaveLength(1);
    expect(rejected[0].status).toBe('rejected');
  });
});
