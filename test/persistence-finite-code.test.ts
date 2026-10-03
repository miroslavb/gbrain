/** A finite host refresh must retain its source/file guards inside managed
 * publication, including replay, tombstones and a file race after SQL writes. */
import {afterAll,beforeAll,expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,unlinkSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import type {BrainEngine} from '../src/core/engine.ts';
import {PGLiteEngine} from '../src/core/pglite-engine.ts';
import {publishFiniteCodeFile,prepareFiniteCodeMutation} from '../src/core/persistence/finite-code-maintenance.ts';
import {registerLocalWriter} from '../src/core/persistence/identity.ts';
import {disposePersistenceConsumer} from '../src/core/persistence/service.ts';
import {CHUNKER_VERSION} from '../src/core/chunkers/code.ts';
import {slugifyCodePath} from '../src/core/sync.ts';
import {isolatedPersistencePostgres} from './helpers/persistence-postgres.ts';
import {testBackends} from './helpers/test-backends.ts';
import {withEnv} from './helpers/with-env.ts';
import type {WriteRequest} from '../src/core/persistence/model.ts';
const engines:BrainEngine[]=[],db=mkdtempSync(join(tmpdir(),'gbrain-finite-managed-db-'));
let closePostgres:(()=>Promise<void>)|undefined,fetches=0;
const originalFetch=globalThis.fetch;
const hash=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
beforeAll(async()=>{
 const forbiddenFetch=()=>{fetches++;throw Error('Finite code refresh called a provider')};
 globalThis.fetch=Object.assign(forbiddenFetch,{preconnect:forbiddenFetch});
 if(testBackends().includes('pglite')){const e=new PGLiteEngine();await e.connect({database_path:db});await e.initSchema();engines.push(e)}
 if(testBackends().includes('postgres')){const pg=await isolatedPersistencePostgres(process.env.DATABASE_URL!);engines.push(pg.engine);closePostgres=pg.close}
},120000);
afterAll(async()=>{
 for(const e of engines){await disposePersistenceConsumer(e);await e.disconnect()}
 await closePostgres?.();globalThis.fetch=originalFetch;rmSync(db,{recursive:true,force:true});
 expect(fetches).toBe(0);
});
async function fixture(run:(f:any)=>Promise<void>){
 for(const e of engines){
  const home=mkdtempSync(join(tmpdir(),'gbrain-finite-managed-')),root=join(home,'code'),mp=join(home,'manifest.json');mkdirSync(root);
  const sid='finite-'+randomUUID().slice(0,8),path='sample.ts',slug=slugifyCodePath(path);
  try{await withEnv({GBRAIN_HOME:join(home,'home')},async()=>{
   await disposePersistenceConsumer(e);
   await e.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
   await e.executeRaw('INSERT INTO sources(id,name,config) VALUES($1,$1,$2::text::jsonb)',[sid,JSON.stringify({federated:false})]);
   await registerLocalWriter(e,'cli');await e.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
   const manifest:any={version:2,mode:'lexical_symbols',enabled:true,sources:[{source_id:sid,repo:root,files:[{path,action:'index',symbol:'finiteValue',signature:'function finiteValue',chunker_version:CHUNKER_VERSION}]}]};
   const put=(value:number|string)=>writeFileSync(join(root,path),typeof value==='number'?`export function finiteValue(): number { return ${value}; }\n`:value);
   const input=async(inputHash=hash(readFileSync(join(root,path))))=>{
    writeFileSync(mp,JSON.stringify(manifest));const s=await e.readPageSnapshot(slug,{sourceId:sid,includeDeleted:true});
    return{sourceId:sid,sourcePath:path,manifestPath:mp,manifestHash:hash(readFileSync(mp)),inputHash,expectedRevision:s?.revision??null,requestId:randomUUID()};
   };
   const publish=async(p:any)=>{
    for(let n=0;n<10;n++){try{return await publishFiniteCodeFile(e,p)}catch(x:any){if(x.code!=='write_pending')throw x;await Bun.sleep(100)}}throw Error('Finite publication stayed pending');
   };
   put(47);await run({e,sid,path,slug,root,mp,manifest,put,input,publish});
  })}finally{await disposePersistenceConsumer(e);rmSync(home,{recursive:true,force:true})}
 }
}
test('journaled create/update/replay, empty file, tombstone replay and explicit re-creation',async()=>fixture(async f=>{
 const first=await f.input(),created=await f.publish(first);expect(created.state).toBe('committed');expect(await f.publish(first)).toEqual(created);
 const before=await f.e.readPageSnapshot(f.slug,{sourceId:f.sid});f.put(48);await f.publish(await f.input());
 const after=await f.e.readPageSnapshot(f.slug,{sourceId:f.sid});expect(after.page.id).toBe(before.page.id);expect(after.page.compiled_truth).toContain('return 48');
 const chunks=await f.e.getChunks(f.slug,{sourceId:f.sid,requireSafeChunks:true});expect(chunks.some((x:any)=>x.symbol_name==='finiteValue')).toBe(true);
 expect(after.page.frontmatter.atom_extract).toBe(false);expect(after.page.frontmatter.embed_skip.reason).toBe('finite_lexical_symbols');
 f.put('');await f.publish(await f.input());expect(await f.e.getChunks(f.slug,{sourceId:f.sid})).toHaveLength(0);
 const current=await f.e.getPage(f.slug,{sourceId:f.sid});unlinkSync(join(f.root,f.path));
 f.manifest.sources[0].files=[{path:f.path,action:'tombstone',expected_content_hash:current.content_hash}];
 const removed=await f.publish(await f.input(current.content_hash));expect(removed.state).toBe('committed');
 expect((await f.publish(await f.input(current.content_hash))).state).toBe('committed');expect(await f.e.getPage(f.slug,{sourceId:f.sid})).toBeNull();
 f.manifest.sources[0].files=[{path:f.path,action:'index',symbol:'finiteValue',signature:'function finiteValue',chunker_version:CHUNKER_VERSION}];
 f.put(49);await f.publish(await f.input());expect((await f.e.getPage(f.slug,{sourceId:f.sid})).compiled_truth).toContain('return 49');
}),60000);
test('incorrect manifest/file hashes and stale revisions leave the page unchanged',async()=>fixture(async f=>{
 const p=await f.input();await f.publish(p);const before=await f.e.readPageSnapshot(f.slug,{sourceId:f.sid});
 await expect(f.publish({...await f.input(),inputHash:'0'.repeat(64)})).rejects.toMatchObject({code:'source_changed'});
 await expect(f.publish({...await f.input(),manifestHash:'0'.repeat(64)})).rejects.toMatchObject({code:'source_changed'});
 f.put(48);await expect(f.publish({...await f.input(),expectedRevision:null})).rejects.toMatchObject({code:'revision_conflict'});
 expect((await f.e.readPageSnapshot(f.slug,{sourceId:f.sid})).revision).toBe(before.revision);
}),60000);
test('file drift after SQL import rolls back body, revision and chunks atomically',async()=>fixture(async f=>{
 await f.publish(await f.input());const before=await f.e.readPageSnapshot(f.slug,{sourceId:f.sid});
 const beforeChunks=await f.e.getChunks(f.slug,{sourceId:f.sid});f.put(48);const p=await f.input();
 const transaction=f.e.transaction;let injected=false;
 f.e.transaction=async function(run:any){return transaction.call(this,async(tx:any)=>{
  const execute=tx.executeRaw;
  tx.executeRaw=async function(sql:string,params?:any[]){const result=await execute.call(this,sql,params);
   if(!injected&&sql.startsWith('UPDATE pages SET frontmatter=frontmatter ||')&&params?.[0]===f.sid){injected=true;f.put(999)}return result};
  try{return await run(tx)}finally{tx.executeRaw=execute}
 })};
 try{await expect(f.publish(p)).rejects.toMatchObject({code:'source_changed'})}finally{f.e.transaction=transaction}
 expect(injected).toBe(true);const after=await f.e.readPageSnapshot(f.slug,{sourceId:f.sid});
 expect(after.revision).toBe(before.revision);expect(after.page.compiled_truth).toBe(before.page.compiled_truth);
 expect(await f.e.getChunks(f.slug,{sourceId:f.sid})).toEqual(beforeChunks);
}),60000);
test('source policy, path escape, symlink and unlisted file are refused',async()=>fixture(async f=>{
 const p=await f.input();await expect(f.publish({...p,sourcePath:'../sample.ts'})).rejects.toMatchObject({code:'source_changed'});
 await expect(f.publish({...p,sourcePath:'other.ts'})).rejects.toMatchObject({code:'source_changed'});
 await f.e.executeRaw("UPDATE sources SET config='{\"federated\":true}'::jsonb WHERE id=$1",[f.sid]);
 await expect(f.publish(p)).rejects.toMatchObject({code:'source_changed'});
 await f.e.executeRaw("UPDATE sources SET config='{\"federated\":false}'::jsonb WHERE id=$1",[f.sid]);
 const other=join(f.root,'original.ts');writeFileSync(other,readFileSync(join(f.root,f.path)));unlinkSync(join(f.root,f.path));symlinkSync(other,join(f.root,f.path));
 await expect(f.publish(p)).rejects.toMatchObject({code:'source_changed'});expect(await f.e.getPage(f.slug,{sourceId:f.sid})).toBeNull();
}),60000);
test('persisted mutation refuses remote and non-CLI principals before filesystem access',async()=>fixture(async f=>{
 const created=await f.publish(await f.input());const [row]=await f.e.executeRaw('SELECT * FROM persistence_requests WHERE request_id=$1::uuid',[created.request_id]);
 for(const remote of [true,undefined,null,0])await expect(prepareFiniteCodeMutation(f.e,{...row,authority:{...row.authority,remote}} as WriteRequest)).rejects.toMatchObject({code:'permission_denied'});
 await expect(prepareFiniteCodeMutation(f.e,{...row,principal_kind:'oauth_client'} as WriteRequest)).rejects.toMatchObject({code:'permission_denied'});
}),60000);

test('runtime attestation and exact tombstone preimage are mandatory',async()=>fixture(async f=>{
 const p=await f.input();await expect(f.publish({...p,runtimeSourceHash:'0'.repeat(64)})).rejects.toMatchObject({code:'source_changed'});
 expect(await f.e.getPage(f.slug,{sourceId:f.sid})).toBeNull();await f.publish(p);
 const before=await f.e.readPageSnapshot(f.slug,{sourceId:f.sid});unlinkSync(join(f.root,f.path));
 f.manifest.sources[0].files=[{path:f.path,action:'tombstone',expected_content_hash:'b'.repeat(64)}];
 await expect(f.publish(await f.input('b'.repeat(64)))).rejects.toMatchObject({code:'source_changed'});
 expect((await f.e.readPageSnapshot(f.slug,{sourceId:f.sid})).revision).toBe(before.revision);
}),60000);
test('captured retaxonomy is preserved and extraction-eligible taxonomy refuses publication',async()=>fixture(async f=>{
 await f.publish(await f.input());
 // Seed captured pre-upgrade taxonomy outside the managed mutation under test.
 // Managed publication remains enabled for every publish/assertion below.
 const seedCapturedType=async(type:string)=>{
  await disposePersistenceConsumer(f.e);await f.e.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  try{await f.e.executeRaw('UPDATE pages SET type=$3 WHERE source_id=$1 AND slug=$2',[f.sid,f.slug,type])}
  finally{await f.e.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1')}
 };
 await seedCapturedType('note');
 f.put(48);await f.publish(await f.input());expect((await f.e.getPage(f.slug,{sourceId:f.sid})).type).toBe('note');
 await seedCapturedType('concept');
 const before=await f.e.readPageSnapshot(f.slug,{sourceId:f.sid});f.put(49);
 await expect(f.publish(await f.input())).rejects.toMatchObject({code:'source_changed'});
 const after=await f.e.readPageSnapshot(f.slug,{sourceId:f.sid});expect(after.revision).toBe(before.revision);
 expect(after.page.type).toBe('concept');expect(after.page.compiled_truth).toContain('return 48');
}),60000);
