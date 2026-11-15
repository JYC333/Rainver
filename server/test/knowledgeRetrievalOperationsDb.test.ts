import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,expect,it} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedSpaceOwnerProject,seedSpaceMember} from './support/domainSeeds.js';
import {buildModuleServer} from './support/moduleServer.js';
import {knowledgeModule} from '../src/modules/knowledge/index.js';
import {memoryModule} from '../src/modules/memory/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {loadConfig} from '../src/config.js';
import {insertKnowledgeItem} from './support/knowledgeFixtures.js';
// Knowledge retrieval feedback and reindex through their formal adapters.
const db=useTestDatabase(import.meta.filename);
let space:string,owner:string,project:string,member:string,app:ReturnType<typeof buildModuleServer>;
const post=(url:string,payload:object={},key=randomUUID())=>app.inject({method:'POST',url,payload,headers:{'idempotency-key':key}});
beforeEach(async()=>{
 await resetTables(db.pool,['spaces','users'],{cascade:true});space=randomUUID();owner=randomUUID();project=randomUUID();member=randomUUID();
 await seedSpaceOwnerProject(db.pool,{space,owner,project,spaceType:'team'});await seedSpaceMember(db.pool,{space,user:member});
 app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),[knowledgeModule,memoryModule,systemActionsModule]);__setAuthIdentityForTests({spaceId:space,userId:owner});
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});
it('hides reindex from a member; an owner rebuilds the projection and queues backfill in the same commit',async()=>{
 const item=randomUUID();await insertKnowledgeItem(db.pool,{id:item,spaceId:space,title:'Alpha',content:'Alpha body',ownerUserId:owner,createdByUserId:owner,visibility:'space_shared'});
 __setAuthIdentityForTests({spaceId:space,userId:member});
 expect((await post('/api/v1/knowledge/retrieval/reindex')).statusCode).toBe(404);
 expect((await db.pool.query("SELECT id FROM jobs WHERE space_id=$1",[space])).rows).toEqual([]);
 __setAuthIdentityForTests({spaceId:space,userId:owner});
 const res=await post('/api/v1/knowledge/retrieval/reindex');expect(res.statusCode,res.body).toBe(200);
 const data=res.json().data;expect(data.space_id).toBe(space);
 expect((await db.pool.query("SELECT object_id FROM retrieval_objects WHERE space_id=$1 AND object_id=$2",[space,item])).rows).toHaveLength(1);
 if(data.embedding_backfill_job_id)expect((await db.pool.query('SELECT id FROM jobs WHERE id=$1',[data.embedding_backfill_job_id])).rows).toHaveLength(1);
});
it('records feedback on a readable result, hides an unreadable one and refuses an invalid signal',async()=>{
 const readable=randomUUID(),hidden=randomUUID();
 await insertKnowledgeItem(db.pool,{id:readable,spaceId:space,title:'Shared',content:'Shared body',ownerUserId:owner,createdByUserId:owner,visibility:'space_shared'});
 await insertKnowledgeItem(db.pool,{id:hidden,spaceId:space,title:'Private',content:'Private body',ownerUserId:owner,createdByUserId:owner,visibility:'private'});
 expect((await post('/api/v1/knowledge/retrieval/reindex')).statusCode).toBe(200);
 __setAuthIdentityForTests({spaceId:space,userId:member});
 const ok=await post('/api/v1/knowledge/retrieval/feedback',{query:'shared',object_type:'knowledge_item',object_id:readable,signal_type:'opened'});expect(ok.statusCode,ok.body).toBe(200);
 expect((await post('/api/v1/knowledge/retrieval/feedback',{query:'private',object_type:'knowledge_item',object_id:hidden,signal_type:'opened'})).statusCode).toBe(404);
 const bad=await post('/api/v1/knowledge/retrieval/feedback',{query:'alpha',object_type:'knowledge_item',object_id:readable,signal_type:'skipped'});expect(bad.statusCode).toBe(422);
 expect((await db.pool.query('SELECT object_id FROM retrieval_feedback_events WHERE space_id=$1',[space])).rows).toEqual([{object_id:readable}]);
});
it('reindexes Memory for an owner and records owner feedback with its read statistic; another member is hidden',async()=>{
 const {insertMemoryEntry}=await import('./support/memoryFixtures.js');
 const entry=randomUUID();await insertMemoryEntry(db.pool,space,{id:entry,owner_user_id:owner,subject_user_id:owner,created_by:owner,title:'Coffee',content:'Prefers oat milk'});
 __setAuthIdentityForTests({spaceId:space,userId:member});
 expect((await post('/api/v1/memory/retrieval/reindex')).statusCode).toBe(404);
 __setAuthIdentityForTests({spaceId:space,userId:owner});
 const re=await post('/api/v1/memory/retrieval/reindex');expect(re.statusCode,re.body).toBe(200);
 const ok=await post('/api/v1/memory/retrieval/feedback',{query:'coffee',object_type:'memory_entry',object_id:entry,signal_type:'opened'});expect(ok.statusCode,ok.body).toBe(200);
 expect((await db.pool.query('SELECT access_count FROM memory_entries WHERE id=$1',[entry])).rows[0].access_count).toBeGreaterThan(0);
 expect((await post('/api/v1/memory/retrieval/feedback',{query:'coffee',object_type:'knowledge_item',object_id:entry,signal_type:'opened'})).statusCode).toBe(422);
 __setAuthIdentityForTests({spaceId:space,userId:member});
 expect((await post('/api/v1/memory/retrieval/feedback',{query:'coffee',object_type:'memory_entry',object_id:entry,signal_type:'opened'})).statusCode).toBe(404);
 expect((await db.pool.query("SELECT actor_user_id FROM retrieval_feedback_events WHERE object_id=$1",[entry])).rows).toEqual([{actor_user_id:owner}]);
});
