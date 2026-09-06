/** Real PostgreSQL SQL, isolated entirely in transaction-local temporary tables. */
import {describe,test,expect} from 'bun:test';
import postgres from 'postgres';
import {findCandidateDuplicates,type PgFactsDeps} from '../../src/core/postgres-engine/facts.ts';
// The normal E2E runner validates/isolates DATABASE_URL. A dedicated URL also
// supports running this rollback-only regression directly.
const url=process.env.GBRAIN_TEST_CANDIDATE_URL ?? process.env.DATABASE_URL;
const d=url?describe:describe.skip;

async function fixture(run:(sql:any,deps:PgFactsDeps)=>Promise<void>){
 const db=postgres(url!,{max:1,onnotice:()=>{}});
 const rollback=Symbol('fixture rollback');
 try{
  await db.begin(async sql=>{
   await sql`CREATE TEMP TABLE facts (
    id bigint PRIMARY KEY, source_id text, entity_slug text, fact text,
    kind text DEFAULT 'fact', visibility text DEFAULT 'world', notability text DEFAULT 'medium',
    confidence float8 DEFAULT 1, context text, source text DEFAULT 'fixture', source_session text,
    valid_from timestamptz DEFAULT now(), valid_until timestamptz, expired_at timestamptz,
    superseded_by bigint, consolidated_at timestamptz, consolidated_into bigint,
    created_at timestamptz DEFAULT now(),embedded_at timestamptz,embedding vector(3)
   ) ON COMMIT DROP`;
   await sql`SET LOCAL search_path = pg_temp, public`;
   await sql`INSERT INTO facts(id,source_id,entity_slug,fact,embedding)
     SELECT 1000+g,'other','projects/foreign','closer outside scope','[1,0,0]'::vector
     FROM generate_series(1,300) g`;
   await sql`INSERT INTO facts(id,source_id,entity_slug,fact,embedding,expired_at) VALUES
    (1,'default','projects/test','nearest eligible','[0.9,0.1,0]',NULL),
    (2,'default','projects/test','second eligible','[0.8,0.2,0]',NULL),
    (3,'default','projects/test','tied eligible','[0.8,0.2,0]',NULL),
    (4,'other','projects/test','wrong source','[1,0,0]',NULL),
    (5,'default','projects/foreign','wrong entity','[1,0,0]',NULL),
    (6,'default','projects/test','expired','[1,0,0]',now()),
    (7,'default','projects/test','no vector',NULL,NULL)`;
   await sql`INSERT INTO facts(id,source_id,entity_slug,fact,embedding,created_at)
     SELECT 3000+g,'default','projects/test','distant eligible','[0,1,0]'::vector,'2000-01-01'::timestamptz
     FROM generate_series(1,300) g`;
   await sql`CREATE INDEX fact_scope ON facts(source_id,entity_slug)`;
   await sql`CREATE INDEX fact_ann ON facts USING hnsw(embedding vector_cosine_ops) WITH(m=8,ef_construction=16)`;
   await sql`ANALYZE facts`;
   await sql`SET LOCAL hnsw.ef_search=1`;
   const [setting]=await sql`SELECT current_setting('hnsw.iterative_scan',true) AS mode`;
   if(setting.mode!=null)await sql`SET LOCAL hnsw.iterative_scan=off`;
   await sql`SET LOCAL enable_seqscan=off`;
   await sql`SET LOCAL enable_bitmapscan=off`;
   await run(sql,{sql} as unknown as PgFactsDeps);
   throw rollback;
  });
 }catch(e){if(e!==rollback)throw e;}finally{await db.end();}
}

d('source/entity fact candidate scope on Postgres',()=>{
 test('rank scoped candidates even when foreign vectors are globally closer',async()=>{
  await fixture(async(sql,deps)=>{
   const legacy="SELECT * FROM facts WHERE source_id='default' AND entity_slug='projects/test' AND expired_at IS NULL AND embedding IS NOT NULL ORDER BY embedding <=> '[1,0,0]'::vector LIMIT 5";
   const plan=await sql.unsafe('EXPLAIN '+legacy);
   expect(JSON.stringify(plan)).toContain('fact_ann');
   expect(await sql.unsafe(legacy)).toHaveLength(0);
   const rows=await findCandidateDuplicates(deps,'default','projects/test','query',{embedding:new Float32Array([1,0,0]),k:5});
   expect(rows.map(x=>x.id)).toEqual([1,2,3,3001,3002]);
   expect(rows.every(x=>x.source_id==='default'&&x.entity_slug==='projects/test'&&!x.expired_at&&x.embedding)).toBe(true);
  });
 });
 test('keep requested k and empty scope; never widen the source',async()=>{
  await fixture(async(_sql,deps)=>{
   const opts={embedding:new Float32Array([1,0,0]),k:1};
   expect((await findCandidateDuplicates(deps,'default','projects/test','query',opts)).map(x=>x.id)).toEqual([1]);
   expect(await findCandidateDuplicates(deps,'missing','projects/test','query',opts)).toEqual([]);
  });
 });
 test('preserve no-vector recency fallback including active NULL-vector rows',async()=>{
  await fixture(async(_sql,deps)=>{
   expect((await findCandidateDuplicates(deps,'default','projects/test','query',{k:1})).map(x=>x.id)).toEqual([7]);
  });
 });
});
