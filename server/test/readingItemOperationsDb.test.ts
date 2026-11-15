import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, it, expect } from 'vitest';
import { useTestDatabase } from './support/testDatabase.js';
import { resetTables } from './support/resetTables.js';
import { seedSpaceOwnerProject, seedSpaceMember } from './support/domainSeeds.js';
import { seedArxivSourceChain } from './support/researchSeeds.js';
import { retainReaderBody } from './support/readingMaterial.js';
import { waitForBlockedBy } from './support/lockWait.js';
import { buildModuleServer } from './support/moduleServer.js';
import { informationDigestModule } from '../src/modules/informationDigest/index.js';
import { registerDeepReadingRoutes } from '../src/modules/sources/deepReading/routes.js';
import { systemActionsModule } from '../src/modules/systemActions/index.js';
import { __setAuthIdentityForTests } from '../src/modules/auth/identity.js';
import { loadConfig } from '../src/config.js';
import { createInvitation, acceptInvitation } from '../src/modules/spaces/writers.js';
import { hashOpaqueToken } from '../src/modules/auth/securityPolicy.js';
const db = useTestDatabase(import.meta.filename, {max:5});
let space:string,owner:string,project:string,viewer:string,item:string,personal:string,app:ReturnType<typeof buildModuleServer>;
const variants=['favorite','project','personal'] as const;
type Variant=typeof variants[number];
const write=(kind:Variant,key=randomUUID(),value=true,extra:object={})=>app.inject({
 method:kind==='favorite'?'POST':'PATCH',
 url:`/api/v1/spaces/${space}${kind==='personal'?'':`/projects/${project}`}/reading/items/${kind==='personal'?personal:item}/${kind==='favorite'?'favorite':'state'}`,
 headers:{'idempotency-key':key},payload:kind==='favorite'?{favorite:value,...extra}:{read_status:value?'read':'unread',...extra},
});
const states=async()=> (await db.pool.query('SELECT source_item_id,user_id,read_status,read_origin,favorite,progress_json FROM source_item_user_states ORDER BY source_item_id,user_id')).rows;
beforeEach(async()=>{
 if(!db.available)return;
 await resetTables(db.pool,['spaces','users','source_connectors','source_providers','source_provider_connectors'],{cascade:true});
 space=randomUUID();owner=randomUUID();project=randomUUID();viewer=randomUUID();item=randomUUID();personal=randomUUID();
 await seedSpaceOwnerProject(db.pool,{space,owner,project,spaceType:'team'});
 await seedSpaceMember(db.pool,{space,user:viewer});
 await db.pool.query("INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'viewer','active',now(),now())",[randomUUID(),space,project,viewer]);
 for(const [id,scope] of [[item,project],[personal,null]]){
  await db.pool.query(`INSERT INTO source_items(id,space_id,project_id,owner_user_id,created_by_user_id,visibility,item_type,title,canonical_uri,source_uri,content_hash,content_state,retention_policy,first_seen_at,last_seen_at,created_at,updated_at)
   VALUES($1,$2,$3,$4,$4,'space_shared','external_url','Reading item',$5,$5,'hash','metadata_only','metadata_only',now(),now(),now(),now())`,[id,space,scope,owner,`https://reading.test/${id}`]);
  await retainReaderBody(db.pool,{space,owner,item:id!,text:'Retained reading body'});
 }
 const config=loadConfig({SERVER_DATABASE_URL:db.connectionUri});
 app=buildModuleServer(config,[informationDigestModule,{name:'reading-test',registerRoutes:registerDeepReadingRoutes},systemActionsModule]);
 __setAuthIdentityForTests({spaceId:space,userId:owner});
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});
it.each(variants)('%s writes private state; same-key replay preserves a later edit and checks payload identity',async kind=>{
 const key=randomUUID(),first=await write(kind,key);
 expect(first.statusCode,first.body).toBe(200);
 expect(first.json().data).toMatchObject({space_id:space,item_id:kind==='personal'?personal:item,user_id:owner,...(kind==='favorite'?{favorite:true}:{updated:1})});
 expect((await write(kind,randomUUID(),false)).statusCode).toBe(200);
 const before=await states();
 expect((await write(kind,key)).json().data).toEqual(first.json().data);
 expect(await states()).toEqual(before);
 expect((await write(kind,key,false)).statusCode).toBe(422);
 expect(before.every(s=>s.user_id===owner)).toBe(true);
 expect(before[0]).toMatchObject(kind==='favorite'?{favorite:false}:{read_status:'unread',read_origin:kind==='personal'?'library':'project'});
});
it.each(variants)('%s replay rechecks Source readability',async kind=>{
 const key=randomUUID();expect((await write(kind,key)).statusCode).toBe(200);
 await db.pool.query('UPDATE source_items SET deleted_at=now() WHERE id=$1',[kind==='personal'?personal:item]);
 expect((await write(kind,key)).statusCode).toBe(404);
});
it.each(variants)('%s audit failure rolls back state and receipt, then same-key retry succeeds',async kind=>{
 const key=randomUUID();
 await db.pool.query("CREATE FUNCTION refuse_reading_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'reading audit refused'; END $$");
 await db.pool.query('CREATE TRIGGER refuse_reading_audit BEFORE INSERT ON policy_decision_records FOR EACH ROW EXECUTE FUNCTION refuse_reading_audit()');
 try{const result=await write(kind,key);expect(result.statusCode,result.body).toBe(503);expect(await states()).toEqual([]);expect((await db.pool.query('SELECT * FROM operation_idempotency')).rows).toEqual([]);}
 finally{await db.pool.query('DROP TRIGGER refuse_reading_audit ON policy_decision_records');await db.pool.query('DROP FUNCTION refuse_reading_audit()');}
 expect((await write(kind,key)).statusCode).toBe(200);
});
it.each(['favorite','project'] as const)('%s permits viewer-owned state and refuses replay after Project revocation',async kind=>{
 __setAuthIdentityForTests({spaceId:space,userId:viewer});
 const key=randomUUID();expect((await write(kind,key)).statusCode).toBe(200);
 expect((await states()).every(s=>s.user_id===viewer)).toBe(true);
 await db.pool.query("UPDATE project_members SET status='revoked' WHERE project_id=$1 AND user_id=$2",[project,viewer]);
 expect((await write(kind,key)).statusCode).toBe(404);
});
it.each(variants)('%s rejects caller identity and URL substitutions',async kind=>{
 expect((await write(kind,randomUUID(),true,{user_id:viewer})).statusCode).toBe(422);
 expect((await write(kind,randomUUID(),true,{item_id:personal})).statusCode).toBe(422);
 expect(await states()).toEqual([]);
});
it('holds Source authority until commit, and waits behind a real Source deletion',async()=>{
 const hold=await db.pool.connect();let pending:ReturnType<typeof write>|undefined;
 try{
  await hold.query('BEGIN');const pid=(await hold.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  await hold.query('UPDATE source_items SET deleted_at=now() WHERE id=$1',[item]);
  pending=write('project');await waitForBlockedBy(db.pool,pid);await hold.query('COMMIT');expect((await pending).statusCode).toBe(404);
 }finally{await hold.query('ROLLBACK');hold.release();await pending;}
 expect(await states()).toEqual([]);
});
it.each(variants)('%s replays only while the Source connection still permits reading',async kind=>{
 const connection=randomUUID(),channel=randomUUID();
 await seedArxivSourceChain(db.pool,{space,owner,connection,connector:randomUUID(),channel,now:new Date().toISOString()});
 await db.pool.query("INSERT INTO source_channel_user_subscriptions(id,space_id,source_channel_id,user_id,status,library_enabled,digest_enabled,created_at,updated_at) VALUES($1,$2,$3,$4,'subscribed',true,true,now(),now())",[randomUUID(),space,channel,owner]);
 await db.pool.query('UPDATE source_items SET connection_id=$2 WHERE id=$1',[kind==='personal'?personal:item,connection]);
 const key=randomUUID(),first=await write(kind,key);expect(first.statusCode,first.body).toBe(200);
 await db.pool.query("UPDATE source_connections SET status='archived' WHERE id=$1",[connection]);
 expect((await write(kind,key)).statusCode).toBe(404);
});
it.each(variants)('%s refuses replay when the account or Space membership is revoked',async kind=>{
 const key=randomUUID();expect((await write(kind,key)).statusCode).toBe(200);
 await db.pool.query("UPDATE space_memberships SET status='inactive' WHERE space_id=$1 AND user_id=$2",[space,owner]);
 expect((await write(kind,key)).statusCode).toBe(404);
 await db.pool.query("UPDATE space_memberships SET status='active' WHERE space_id=$1 AND user_id=$2",[space,owner]);
 await db.pool.query("UPDATE users SET status='disabled' WHERE id=$1",[owner]);
 expect((await write(kind,key)).statusCode).toBe(404);
});
it('propagates state across authorized equivalent revisions while favorite remains on its exact item',async()=>{
 await db.pool.query('UPDATE source_items SET canonical_uri=(SELECT canonical_uri FROM source_items WHERE id=$1),reading_initial_hash=\'same\' WHERE id=ANY($2::varchar[])',[item,[item,personal]]);
 expect((await write('project')).json().data.updated).toBe(2);
 expect((await states()).map(s=>s.read_status)).toEqual(['read','read']);
 expect((await write('favorite')).statusCode).toBe(200);
 expect((await states()).filter(s=>s.favorite).map(s=>s.source_item_id)).toEqual([item]);
});
async function topic(kind:'project'|'personal'){
 const source=kind==='personal'?personal:item,connection=randomUUID(),goal=randomUUID(),binding=randomUUID(),version=randomUUID(),run=randomUUID(),change=randomUUID();
 await seedArxivSourceChain(db.pool,{space,owner,connection,connector:randomUUID(),channel:randomUUID(),now:new Date().toISOString()});
 await db.pool.query("INSERT INTO source_goals(id,space_id,owner_user_id,project_id,intent_json,budget_json,status) VALUES($1,$2,$3,$4,'{}','{}','running')",[goal,space,owner,kind==='personal'?null:project]);
 await db.pool.query("INSERT INTO source_goal_bindings(id,space_id,goal_id,source_connection_id,spec_json) VALUES($1,$2,$3,$4,'{}')",[binding,space,goal,connection]);
 await db.pool.query("INSERT INTO source_goal_items(id,space_id,goal_id,source_item_id,source_connection_id,binding_id,version_id,first_goal_run_id,last_goal_run_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8)",[randomUUID(),space,goal,source,connection,binding,version,run]);
 await db.pool.query("INSERT INTO source_goal_item_changes(id,space_id,goal_id,source_item_id,change_kind,evidence_url,delivery_kind,goal_run_id,binding_id,version_id,delivered_at) VALUES($1,$2,$3,$4,'update','https://reading.test/change','evidenced_change',$5,$6,$7,now())",[change,space,goal,source,run,binding,version]);
 return {change,connection,goal};
}
it.each(['project','personal'] as const)('%s acknowledges only the immutable topic change, and rechecks its collecting Source on replay',async kind=>{
 const {change,connection}=await topic(kind),key=randomUUID();
 const first=await write(kind,key,true,{topic_change_id:change,dismissed:true});expect(first.statusCode,first.body).toBe(200);
 expect(await states()).toEqual([]);
 expect((await db.pool.query('SELECT read_status,dismissed,user_id FROM source_goal_change_user_states WHERE change_id=$1',[change])).rows).toEqual([{read_status:'read',dismissed:1,user_id:owner}]);
 expect((await write(kind,key,true,{topic_change_id:change,dismissed:true})).json().data).toEqual(first.json().data);
 await db.pool.query("UPDATE source_connections SET status='archived' WHERE id=$1",[connection]);
 expect((await write(kind,key,true,{topic_change_id:change,dismissed:true})).statusCode).toBe(404);
});
it.each(['project','personal'] as const)('%s topic-change audit failure rolls back its independent state',async kind=>{
 const {change}=await topic(kind);
 await db.pool.query("CREATE FUNCTION refuse_topic_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'topic audit refused'; END $$");
 await db.pool.query('CREATE TRIGGER refuse_topic_audit BEFORE INSERT ON policy_decision_records FOR EACH ROW EXECUTE FUNCTION refuse_topic_audit()');
 try{const result=await write(kind,randomUUID(),true,{topic_change_id:change});expect(result.statusCode,result.body).toBe(503);expect((await db.pool.query('SELECT * FROM source_goal_change_user_states')).rows).toEqual([]);}
 finally{await db.pool.query('DROP TRIGGER refuse_topic_audit ON policy_decision_records');await db.pool.query('DROP FUNCTION refuse_topic_audit()');}
});

it.each(variants)('%s default core admission lets the real invitation writer reach its membership refusal',async kind=>{
 const token=randomUUID(),email=(await db.pool.query('SELECT email FROM users WHERE id=$1',[owner])).rows[0].email;
 await createInvitation(db.pool,owner,space,{email,role:'member',token});
 const writer=await db.pool.connect();let pending:ReturnType<typeof write>|undefined;
 try{
  await writer.query('BEGIN');
  await writer.query("SET LOCAL lock_timeout='750ms'");
  // Pause the canonical invitation owner at its first lock. The active-member
  // ON CONFLICT refusal still locks that membership even though it changes no row.
  await writer.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[owner]);
  const pid=(await writer.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  pending=write(kind);await waitForBlockedBy(db.pool,pid);
  await expect(acceptInvitation(writer,owner,token)).rejects.toMatchObject({statusCode:409});
  await writer.query('ROLLBACK');
  const result=await pending;expect(result.statusCode,result.body).toBe(200);
  expect(await states()).toHaveLength(1);
  expect((await db.pool.query('SELECT status FROM user_invitations WHERE token_hash=$1',[hashOpaqueToken(token)])).rows).toEqual([{status:'available'}]);
 }finally{await writer.query('ROLLBACK');writer.release();await pending;}
});

it.each(['account','membership'] as const)('hides %s revocation committed while core actor admission waits',async kind=>{
 const holder=await db.pool.connect(),key=randomUUID();let pending:ReturnType<typeof write>|undefined;
 try{
  await holder.query('BEGIN');
  const pid=(await holder.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  if(kind==='account')await holder.query("UPDATE users SET status='disabled' WHERE id=$1",[owner]);
  else await holder.query("UPDATE space_memberships SET status='inactive' WHERE space_id=$1 AND user_id=$2",[space,owner]);
  pending=write('favorite',key);await waitForBlockedBy(db.pool,pid);
  await holder.query('COMMIT');
  const result=await pending;expect(result.statusCode,result.body).toBe(404);
  expect(result.json().error.code).toBe('operation_not_found');
  expect(await states()).toEqual([]);
  expect((await db.pool.query('SELECT * FROM operation_idempotency')).rows).toEqual([]);
 }finally{await holder.query('ROLLBACK');holder.release();await pending;}
});
