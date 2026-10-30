import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { extractStaleFromDB } from '../src/commands/extract.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { LINK_EXTRACTOR_VERSION_TS } from '../src/core/link-extraction.ts';
import { managedBrain } from './helpers/managed-brain.ts';

test('managed extract --max-pages admits only the requested pages and defers the unbounded mention pass', async () => {
  await managedBrain(async ({ engine, ctx }) => {
    await engine.setConfig('auto_link', 'false');
    for (let i = 0; i < 4; i++) {
      await submitPageMutation(ctx, { operation: 'put_page', params: {
        slug: `notes/capped-${i}`, request_id: randomUUID(),
        content: `---\ntype: note\ntitle: Capped ${i}\n---\n\nLinks [[notes/capped-${(i + 1) % 4}]].\n`,
      } });
    }
    await disposePersistenceConsumer(engine);
    expect(await engine.countStalePagesForExtraction({ versionTs: LINK_EXTRACTOR_VERSION_TS })).toBe(4);
    const result = await extractStaleFromDB(engine, {
      dryRun: false, jsonMode: true, quiet: true, catchUp: true, maxPages: 2,
    });
    expect(result).toMatchObject({ pagesProcessed: 2, pagesAdmitted: 2, pageCapHit: true, mentionsDeferred: true });
    expect(await engine.countStalePagesForExtraction({ versionTs: LINK_EXTRACTOR_VERSION_TS })).toBe(2);
    expect(await engine.executeRaw('SELECT page_id FROM page_mention_state')).toHaveLength(0);
  });
}, 60_000);
