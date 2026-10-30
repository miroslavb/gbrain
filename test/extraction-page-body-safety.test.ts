import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { finalizeAtomCompletionReceipt } from '../src/core/cycle/atom-completion-receipt.ts';
import { readAtomPageIdentity } from '../src/core/cycle/extract-atoms-page-state.ts';
import { acceptProposal, listPendingProposals } from '../src/core/take-proposals.ts';
import { collectChronicle } from '../src/core/advisor/collect-chronicle.ts';
import type { AdvisorContext } from '../src/core/advisor/types.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); });

const hash16 = '1234567890abcdef';
const pendingHash = `pending:${hash16}`;
const claim = 'The source supports this exact claim.';
async function makeSegmented(slug: string, lead = claim, sourceId = 'default'): Promise<void> {
  // A native metadata shape is sufficient: these readers must never request a
  // segment, even if a legacy/imported row has no available segment manifest.
  await engine.executeRaw(`UPDATE pages SET body_storage='segmented',compiled_truth=NULL,timeline=NULL,
    body_bytes=$3,truth_bytes=$3,truth_lead=$4 WHERE slug=$1 AND source_id=$2`,
  [slug, sourceId, Buffer.byteLength(lead, 'utf8'), lead]);
}
async function pendingAtom(slug: string): Promise<void> {
  await engine.putPage(slug, { type: 'atom', title: slug, compiled_truth: claim,
    frontmatter: { source_hash: pendingHash } });
}
const receipts = () => engine.executeRaw<{ slug: string; receipt: string }>(
  "SELECT slug,frontmatter->>'source_hash' AS receipt FROM pages WHERE type='atom' ORDER BY slug");

test('segmented atom refuses the entire completion batch before any receipt flips', async () => {
  await pendingAtom('atoms/first');
  await pendingAtom('atoms/second');
  await makeSegmented('atoms/second');
  await expect(finalizeAtomCompletionReceipt(engine, 'default', hash16, ['atoms/first', 'atoms/second']))
    .rejects.toMatchObject({ code: 'page_body_segmented' });
  expect(await receipts()).toEqual([
    { slug: 'atoms/first', receipt: pendingHash }, { slug: 'atoms/second', receipt: pendingHash },
  ]);
});

test('segmented source refuses completion before changing an inline atom', async () => {
  await pendingAtom('atoms/from-origin');
  await engine.putPage('notes/origin', { type: 'note', title: 'Origin', compiled_truth: claim });
  const origin = { slug: 'notes/origin', content: claim, contentHash: (await engine.getPage('notes/origin'))!.content_hash! };
  const identity = await readAtomPageIdentity(engine, 'default', origin);
  await makeSegmented(origin.slug);
  await expect(finalizeAtomCompletionReceipt(engine, 'default', hash16, ['atoms/from-origin'], { ...origin, identity }))
    .rejects.toMatchObject({ code: 'page_body_segmented' });
  expect(await receipts()).toEqual([{ slug: 'atoms/from-origin', receipt: pendingHash }]);
});

async function proposal(sourceId = 'default'): Promise<number> {
  const slug = 'notes/proposal';
  if (sourceId !== 'default') await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
  await engine.putPage(slug, { type: 'note', title: 'Proposal', compiled_truth: claim }, { sourceId });
  const hash = createHash('sha256').update(claim).digest('hex');
  await engine.executeRaw(`INSERT INTO proposal_page_runs
    (source_id,page_slug,source_hash,prompt_version,proposal_run_id,model_id,status,proposal_count,evidence_span_count)
    VALUES($1,$2,$3,'body-safety','body-safety','test-model','completed',1,1)`, [sourceId, slug, hash]);
  const [row] = await engine.executeRaw<{ id: number }>(`INSERT INTO take_proposals
    (source_id,page_slug,content_hash,source_hash,prompt_version,proposal_run_id,claim_text,kind,holder,weight,model_id,evidence_span)
    VALUES($1,$2,$3,$3,'body-safety','body-safety',$4,'take','brain',0.5,'test-model',$4) RETURNING id`,
  [sourceId, slug, hash, claim]);
  return row!.id;
}

test('pending segmented proposal is explicitly refused by list and accept without a queue claim', async () => {
  const id = await proposal();
  await makeSegmented('notes/proposal');
  await expect(listPendingProposals(engine, { sourceId: 'default' })).rejects.toMatchObject({ code: 'page_body_segmented' });
  const raw = engine.executeRaw;
  let claims = 0;
  engine.executeRaw = async function<T>(this: PGLiteEngine, sql: string, params?: unknown[]): Promise<T[]> {
    if (/UPDATE\s+take_proposals/i.test(sql)) claims++;
    return raw.call(this, sql, params) as Promise<T[]>;
  };
  try {
    await expect(acceptProposal({ engine, config: { engine: 'pglite' }, brainDir: '/tmp/unwritten-proposal', sourceId: 'default' }, id))
      .rejects.toMatchObject({ code: 'page_body_segmented' });
  } finally { engine.executeRaw = raw; }
  expect(claims).toBe(0);
  expect(await engine.executeRaw('SELECT status,acted_at,promoted_row_num FROM take_proposals WHERE id=$1', [id]))
    .toEqual([{ status: 'pending', acted_at: null, promoted_row_num: null }]);
});

test('segmented proposal in another source cannot poison an inline scoped list', async () => {
  const local = await proposal();
  await proposal('private-other');
  await makeSegmented('notes/proposal', claim, 'private-other');
  expect((await listPendingProposals(engine, { sourceId: 'default' })).map(row => row.id)).toEqual([local]);
  await expect(listPendingProposals(engine, { sourceId: 'private-other' })).rejects.toMatchObject({ code: 'page_body_segmented' });
});

test('a page becoming segmented after proposal enumeration is refused by the fresh snapshot', async () => {
  await proposal();
  const read = engine.readPageSnapshot;
  engine.readPageSnapshot = async function(slug, opts) {
    await makeSegmented(slug);
    return read.call(this, slug, opts);
  };
  try {
    await expect(listPendingProposals(engine, { sourceId: 'default' })).rejects.toMatchObject({ code: 'page_body_segmented' });
  } finally { engine.readPageSnapshot = read; }
});

async function chronicleGap(scope: Partial<AdvisorContext> = {}): Promise<string | undefined> {
  const findings = await collectChronicle.collect({ engine, remote: false, ...scope } as AdvisorContext);
  return findings.find(finding => finding.id === 'chronicle_coverage_gap')?.title;
}

test('Chronicle threshold uses native JS character length for inline and segmented prefixes, never bytes', async () => {
  for (const [slug, body, segmented] of [
    ['meetings/emoji', '😀'.repeat(40), false],
    ['meetings/short-cyrillic', 'я'.repeat(79), false],
    ['meetings/segmented-emoji', '😀'.repeat(40), true],
    ['meetings/segmented-short-cyrillic', 'я'.repeat(79), true],
  ] as const) {
    await engine.putPage(slug, { type: 'meeting', title: slug, compiled_truth: body });
    if (segmented) await makeSegmented(slug, body);
  }
  expect(await chronicleGap()).toBe("2 recent meeting(s) aren't in the timeline yet");
});

test('Chronicle bounded segmented leads keep source grants and the 100-message threshold', async () => {
  await engine.executeRaw("INSERT INTO sources(id,name) VALUES('private-other','Private other')");
  for (const [sourceId, slug, messages] of [
    ['default', 'conversations/threshold', 100],
    ['default', 'conversations/short', 99],
    ['private-other', 'conversations/threshold', 100],
  ] as const) {
    await engine.putPage(slug, { type: 'conversation', title: slug, compiled_truth: 'x'.repeat(120),
      frontmatter: { message_count: messages } }, { sourceId });
    await makeSegmented(slug, 'x'.repeat(120), sourceId);
  }
  expect(await chronicleGap({ sourceId: 'default' })).toBe("1 recent meeting(s) aren't in the timeline yet");
  expect(await chronicleGap({ allowedSources: [] })).toBeUndefined();
  expect(await chronicleGap({ allowedSources: ['default', 'private-other'] })).toBe("2 recent meeting(s) aren't in the timeline yet");
});
