import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { contentHash, runPhaseProposeTakes, type ProposeTakesExtractor } from '../src/core/cycle/propose-takes.ts';
import { acceptProposal, listPendingProposals, TakeProposalError } from '../src/core/take-proposals.ts';
import { parseTakesFence } from '../src/core/takes-fence.ts';
import type { OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;
let repo: string;
const slug = 'analysis/consumer-safety';
const body = 'I bet the safe consumer ships this quarter.';
const claim = 'safe consumer ships this quarter';

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  repo = mkdtempSync(join(tmpdir(), 'gbrain-proposal-safety-'));
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('cycle.propose_takes.enabled', 'true');
  await engine.putPage(slug, { type: 'concept', title: slug, compiled_truth: body, frontmatter: {} });
  mkdirSync(join(repo, 'analysis'), { recursive: true });
  writeFileSync(join(repo, `${slug}.md`), `# Consumer safety\n\n${body}\n`, 'utf-8');
});

const ctx = (): OperationContext => ({
  engine, config: {} as never, logger: { info() {}, warn() {}, error() {} } as never,
  dryRun: false, remote: false, sourceId: 'default',
});

const runSafetyProducer = (extractor: ProposeTakesExtractor) => runPhaseProposeTakes(ctx(), {
  extractor,
  pageLimit: 1,
  minPageChars: 0,
  sensitivityConfig: { allowlist: [], blocklistRe: null, patterns: [] },
});

describe('take proposal acceptance quarantine and retry safety', () => {
  test('legacy pending rows are hidden and cannot be accepted', async () => {
    const [legacy] = await engine.executeRaw<{ id: number }>(
      `INSERT INTO take_proposals
        (source_id,page_slug,content_hash,prompt_version,proposal_run_id,claim_text,kind,holder,weight,model_id)
       VALUES ('default',$1,'legacy-hash','legacy-prompt','legacy-run','legacy claim','take','brain',0.5,'legacy-model')
       RETURNING id`,
      [slug],
    );
    expect(await listPendingProposals(engine, { sourceId: 'default' })).toEqual([]);
    await expect(acceptProposal({ engine, brainDir: repo, sourceId: 'default' }, legacy.id))
      .rejects.toMatchObject({ code: 'unverified' } as Partial<TakeProposalError>);
  });

  test('a paraphrased claim is hidden and cannot be accepted even when its surrounding evidence is exact', async () => {
    const hash = contentHash(body);
    const [proposal] = await engine.executeRaw<{ id: number }>(
      `INSERT INTO take_proposals
        (source_id,page_slug,content_hash,source_hash,prompt_version,proposal_run_id,
         claim_text,kind,holder,weight,model_id,evidence_span)
       VALUES ('default',$1,$2,$2,'test-whole-claim','run-paraphrase',
               'The consumer probably ships soon','bet','brain',0.7,'test-model',$3)
       RETURNING id`,
      [slug, hash, body],
    );
    await engine.executeRaw(
      `INSERT INTO proposal_page_runs
        (source_id,page_slug,source_hash,prompt_version,proposal_run_id,model_id,
         status,proposal_count,evidence_span_count)
       VALUES ('default',$1,$2,'test-whole-claim','run-paraphrase','test-model','completed',1,1)`,
      [slug, hash],
    );

    expect(await listPendingProposals(engine, { sourceId: 'default' })).toEqual([]);
    await expect(acceptProposal({ engine, brainDir: repo, sourceId: 'default' }, proposal.id))
      .rejects.toMatchObject({ code: 'unverified' } as Partial<TakeProposalError>);
  });

  test('fault after canonical write leaves pending row; retry reuses the same fence row', async () => {
    const extractor: ProposeTakesExtractor = async () => [
      { claim_text: claim, kind: 'bet', holder: 'brain', weight: 0.7, evidence_span: body },
    ];
    await runSafetyProducer(extractor);
    const [proposal] = await listPendingProposals(engine, { sourceId: 'default' });

    await expect(acceptProposal({
      engine, brainDir: repo, sourceId: 'default',
      afterCanonicalWrite: async () => { throw new Error('injected post-write failure'); },
    }, proposal.id)).rejects.toThrow('injected post-write failure');
    expect((await engine.executeRaw<{ status: string }>(
      `SELECT status FROM take_proposals WHERE id=$1`, [proposal.id],
    ))[0]?.status).toBe('pending');

    await acceptProposal({ engine, brainDir: repo, sourceId: 'default' }, proposal.id);
    const parsed = parseTakesFence(readFileSync(join(repo, `${slug}.md`), 'utf-8'));
    expect(parsed.takes.filter((take) => take.claim === claim)).toHaveLength(1);
    expect((await engine.executeRaw<{ status: string }>(
      `SELECT status FROM take_proposals WHERE id=$1`, [proposal.id],
    ))[0]?.status).toBe('accepted');
  });

  test('acceptance refuses a changed DB snapshot before touching markdown', async () => {
    const extractor: ProposeTakesExtractor = async () => [
      { claim_text: claim, kind: 'bet', holder: 'brain', weight: 0.7, evidence_span: body },
    ];
    await runSafetyProducer(extractor);
    const [proposal] = await listPendingProposals(engine, { sourceId: 'default' });
    await engine.putPage(slug, {
      type: 'concept', title: slug, compiled_truth: `${body} Updated after extraction.`, frontmatter: {},
    });

    expect(await listPendingProposals(engine, { sourceId: 'default' })).toEqual([]);

    await expect(acceptProposal({ engine, brainDir: repo, sourceId: 'default' }, proposal.id))
      .rejects.toMatchObject({ code: 'unverified' } as Partial<TakeProposalError>);
    expect(parseTakesFence(readFileSync(join(repo, `${slug}.md`), 'utf-8')).takes).toHaveLength(0);
  });

  test('acceptance refuses disappeared canonical-file evidence under the write lock', async () => {
    const extractor: ProposeTakesExtractor = async () => [
      { claim_text: claim, kind: 'bet', holder: 'brain', weight: 0.7, evidence_span: body },
    ];
    await runSafetyProducer(extractor);
    const [proposal] = await listPendingProposals(engine, { sourceId: 'default' });
    writeFileSync(join(repo, `${slug}.md`), '# Consumer safety\n\nEvidence was removed.\n', 'utf-8');

    await expect(acceptProposal({ engine, brainDir: repo, sourceId: 'default' }, proposal.id))
      .rejects.toThrow('evidence is absent');
    expect((await engine.executeRaw<{ status: string }>(
      `SELECT status FROM take_proposals WHERE id=$1`, [proposal.id],
    ))[0]?.status).toBe('pending');
  });
});
