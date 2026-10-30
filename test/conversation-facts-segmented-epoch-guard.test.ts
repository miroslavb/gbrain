import { expect, test } from 'bun:test';
import { processSegmentedConversationPage } from '../src/core/facts/conversation-incremental.ts';

test('segmented conversation extraction refuses before any reads, model calls or partial publication', async () => {
  let touched = false;
  const inaccessible = new Proxy({}, { get() { touched = true; throw new Error('segmented state was touched'); } });
  await expect(processSegmentedConversationPage(inaccessible as never, inaccessible as never, { gapMinutes: null }))
    .rejects.toThrow('whole-page atomic epoch publication');
  expect(touched).toBe(false);
});
