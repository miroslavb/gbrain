/** Candidate retrieval against the real halfvec/HNSW embedded engine. */
import {describe,test,expect} from 'bun:test';
import {PGlite} from '@electric-sql/pglite';
import {vector} from '@electric-sql/pglite/vector';
import {findCandidateDuplicates} from '../src/core/pglite-engine/facts.ts';

describe('exact source/entity fact candidates on PGlite',()=>{
 test('keeps eligible neighbours, deterministic ties, k and recency despite closer foreign vectors',async()=>{
  const db=await PGlite.create({extensions:{vector}});
  try{
   await db.exec(`CREATE EXTENSION vector;
    CREATE TABLE facts (
     id bigint PRIMARY KEY, source_id text, entity_slug text, fact text,
     kind text DEFAULT 'fact', visibility text DEFAULT 'world', notability text DEFAULT 'medium',
     confidence float8 DEFAULT 1, context text, source text DEFAULT 'fixture', source_session text,
     valid_from timestamptz DEFAULT now(), valid_until timestamptz, expired_at timestamptz,
     superseded_by bigint, consolidated_at timestamptz, consolidated_into bigint,
     created_at timestamptz DEFAULT now(),embedded_at timestamptz,embedding halfvec(3)
    );
    INSERT INTO facts(id,source_id,entity_slug,fact,embedding)
     SELECT 1000+g,'other','projects/foreign','outside scope','[1,0,0]'::halfvec FROM generate_series(1,300) g;
    INSERT INTO facts(id,source_id,entity_slug,fact,embedding,expired_at) VALUES
     (1,'default','projects/test','nearest eligible','[0.9,0.1,0]',NULL),
     (2,'default','projects/test','second eligible','[0.8,0.2,0]',NULL),
     (3,'default','projects/test','tied eligible','[0.8,0.2,0]',NULL),
     (4,'other','projects/test','wrong source','[1,0,0]',NULL),
     (5,'default','projects/foreign','wrong entity','[1,0,0]',NULL),
     (6,'default','projects/test','expired','[1,0,0]',now()),
     (7,'default','projects/test','no vector',NULL,NULL);
    INSERT INTO facts(id,source_id,entity_slug,fact,embedding,created_at)
     SELECT 3000+g,'default','projects/test','distant eligible','[0,1,0]'::halfvec,
      '2000-01-01'::timestamptz FROM generate_series(1,300) g;
    CREATE INDEX candidate_scope ON facts(source_id,entity_slug);
    CREATE INDEX candidate_ann ON facts USING hnsw(embedding halfvec_cosine_ops) WITH(m=8,ef_construction=16);
    ANALYZE facts;
    SET hnsw.ef_search=1;
    SET hnsw.iterative_scan=off;
    SET enable_seqscan=off;
    SET enable_bitmapscan=off;`);
   const embedding=new Float32Array([1,0,0]);
   // Both indexes exist. This control proves the fixture exercises the old
   // global ANN/post-filter failure, rather than a favourable BTree plan.
   const legacySql=`SELECT * FROM facts WHERE source_id=$1 AND entity_slug=$2
    AND expired_at IS NULL AND embedding IS NOT NULL ORDER BY embedding <=> $3::vector LIMIT $4`;
   const params=['default','projects/test','[1,0,0]',5];
   const legacyPlan=await db.query('EXPLAIN '+legacySql,params);
   expect(JSON.stringify(legacyPlan.rows)).toContain('candidate_ann');
   expect((await db.query(legacySql,params)).rows).toEqual([]);
   const result=await findCandidateDuplicates({db},'default','projects/test','query',{embedding,k:5});
   expect(result.map(row=>row.id)).toEqual([1,2,3,3001,3002]);
   expect(result.every(row=>row.source_id==='default'&&row.entity_slug==='projects/test'&&!row.expired_at&&row.embedding)).toBe(true);
   expect((await findCandidateDuplicates({db},'default','projects/test','query',{embedding,k:1})).map(row=>row.id)).toEqual([1]);
   expect(await findCandidateDuplicates({db},'missing','projects/test','query',{embedding,k:5})).toEqual([]);
   expect((await findCandidateDuplicates({db},'default','projects/test','query',{k:1})).map(row=>row.id)).toEqual([7]);
  }finally{await db.close();}
 },30000);
});
