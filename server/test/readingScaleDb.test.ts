import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { useTestDatabase } from './support/testDatabase.js';
import { seedSpaceOwnerProject } from './support/domainSeeds.js';
import { seedArxivSourceChain } from './support/researchSeeds.js';
import { ReadingService } from '../src/modules/informationDigest/readingService.js';

const db=useTestDatabase(import.meta.filename);
describe('reading at subscription scale',()=>{
  it('pages a retained 20000-item Library and 6000 formal recommendations with a current count',async()=>{
    const space=randomUUID(),owner=randomUUID(),project=randomUUID(),connection=randomUUID(),channel=randomUUID(),digest=randomUUID();
    await seedSpaceOwnerProject(db.pool,{space,owner,project,spaceType:'team'});
    await seedArxivSourceChain(db.pool,{connector:randomUUID(),connection,channel,space,owner,now:'2026-01-01T00:00:00Z'});
    await db.pool.query(`INSERT INTO source_channel_user_subscriptions(id,space_id,source_channel_id,user_id,status,library_enabled,digest_enabled,created_at,updated_at) VALUES($1,$2,$3,$4,'subscribed',true,true,now(),now())`,[randomUUID(),space,channel,owner]);
    await db.pool.query(`INSERT INTO information_digests(id,space_id,digest_type,owner_user_id,digest_date,period_start_utc,period_end_utc,generated_at,created_at,updated_at) VALUES($1,$2,'personal',$3,'2026-01-01','2026-01-01T00:00:00Z','2026-01-02T00:00:00Z','2026-01-02T01:00:00Z',now(),now())`,[digest,space,owner]);
    let captured:{sql:string;values:readonly unknown[]}|undefined;
    const service=new ReadingService({query:async <Row>(sql:string,values?:readonly unknown[])=>{
      if(sql.includes('WITH anchor AS')) captured={sql,values:values??[]};
      const result=await db.pool.query(sql,[...(values??[])]);
      return {rows:result.rows as Row[],rowCount:result.rowCount};
    }});
    const records:Array<Record<string,unknown>>=[];
    let previous=0;
    for(const [size,recommendations] of [[3000,750],[6000,1500],[20000,6000]]) {
      await db.pool.query(`INSERT INTO source_items(id,space_id,owner_user_id,created_by_user_id,visibility,connection_id,item_type,title,source_uri,canonical_uri,content_hash,content_state,retention_policy,first_seen_at,last_seen_at,created_at,updated_at)
        SELECT gen_random_uuid()::text,$1,$2,$2,'space_shared',$3,'feed_entry','Article '||n,'https://scale.test/'||n,'https://scale.test/'||n,md5(n::text),'metadata_only','metadata_only','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z' FROM generate_series($4::int+1,$5::int) n`,[space,owner,connection,previous,size]);
      await db.pool.query(`INSERT INTO information_digest_items(id,space_id,digest_id,source_item_id,section,position,quota_slot,score,rationale,created_at)
        SELECT gen_random_uuid()::text,$1::varchar(36),$2::varchar(36),i.id,'interest',split_part(i.source_uri,'/',4)::int,'interest',1,'Formal retained recommendation','2026-01-02T01:00:00Z'
        FROM source_items i WHERE i.space_id=$1 AND split_part(i.source_uri,'/',4)::int<=$3
          AND NOT EXISTS(SELECT 1 FROM information_digest_items di WHERE di.space_id=$1 AND di.source_item_id=i.id)`,[space,digest,recommendations]);
      await db.pool.query(`INSERT INTO source_item_user_states(id,space_id,source_item_id,user_id,read_status,read_origin,first_opened_at,last_opened_at,created_at,updated_at)
        SELECT gen_random_uuid()::text,$1::varchar(36),i.id,$2::varchar(36),CASE WHEN split_part(i.source_uri,'/',4)::int%5=0 THEN 'read' ELSE 'skimmed' END,'library','2026-01-01T03:00:00Z','2026-01-01T03:00:00Z','2026-01-01T03:00:00Z','2026-01-01T03:00:00Z'
        FROM source_items i WHERE i.space_id=$1 AND NOT EXISTS(SELECT 1 FROM source_item_user_states us WHERE us.space_id=$1 AND us.source_item_id=i.id AND us.user_id=$2)`,[space,owner]);
      await db.pool.query('ANALYZE source_items');await db.pool.query('ANALYZE information_digest_items');await db.pool.query('ANALYZE source_item_user_states');
      for(const view of ['pending','all'] as const) {
        let cursor:string|undefined;const seen=new Set<string>();
        for(const pageNumber of [1,2]) {
          const started=performance.now();
          const page=await service.list({spaceId:space,userId:owner},{view,limit:30,cursor});
          const elapsed=performance.now()-started;
          expect(page.total).toBe(view==='pending'?recommendations-Math.floor(recommendations/5):size);expect(page.items).toHaveLength(30);
          for(const item of page.items) {expect(seen.has(item.key)).toBe(false);seen.add(item.key);}
          cursor=page.next_cursor!;expect(cursor).toBeTruthy();
          const statement=captured!;
          const explained=await db.pool.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) '+statement.sql,[...statement.values]);
          const plan=explained.rows[0]['QUERY PLAN'][0];
          const record={items:size,recommendations,view,page:pageNumber,wall_ms:Math.round(elapsed*100)/100,execution_ms:plan['Execution Time'],planning_ms:plan['Planning Time'],explain:plan};
          records.push(record);writeFileSync('/tmp/rainver-unified-reading-scale.json',JSON.stringify(records,null,2));console.info('Reading scale',JSON.stringify({...record,explain:undefined}));
        }
      }
      previous=size;
    }
    writeFileSync('/tmp/rainver-unified-reading-scale.json',JSON.stringify(records,null,2));
  });
});
