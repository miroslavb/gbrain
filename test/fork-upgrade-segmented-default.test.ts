import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { readPageBodyPolicy } from '../src/core/page-body/limits.ts';
import { PAGE_MAX_BYTES } from '../src/core/page-size-policy.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { conversationPage } from './helpers/conversation-page.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30000);
afterAll(async () => { await engine?.disconnect(); });

test('fork upgrade keeps an unset segmented-storage switch off and a large page inline', async () => {
    expect(await engine.getConfig('pages.segmented_storage')).toBeNull();
    expect(await readPageBodyPolicy(engine)).toMatchObject({segmented:false,maxBytes:PAGE_MAX_BYTES});
    await importFromContent(engine,'sessions/fork-upgrade-large',conversationPage(2*1024*1024,{seed:61}),{noEmbed:true,sourceId:'default'});
    const rows=await engine.executeRaw("SELECT body_storage,octet_length(compiled_truth) AS bytes FROM pages WHERE slug='sessions/fork-upgrade-large'");
    expect(rows[0]?.body_storage).toBe('inline');
    expect(Number(rows[0]?.bytes)).toBeGreaterThan(1024*1024);
},30000);
