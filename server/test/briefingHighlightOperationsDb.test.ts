import {randomUUID} from 'node:crypto';
import {beforeEach,afterEach,it,expect} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {briefingWorld,SPACE,PROJECT,OWNER,MEMBER,output,outputValue} from './support/briefingFixture.js';
import {buildModuleServer} from './support/moduleServer.js';
import {informationDigestModule} from '../src/modules/informationDigest/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {personalBriefingScope} from '../src/modules/informationDigest/briefing/personalScope.js';
import {ReadingPreferences} from '../src/modules/informationDigest/readingPreferences.js';
import {settleBriefingRun} from '../src/modules/informationDigest/briefing/settlement.js';
const db=useTestDatabase(import.meta.filename,{max:8}),world=briefingWorld(db);
let app:ReturnType<typeof buildModuleServer>,personal:string,project:string;
const url=(isProject:boolean,suffix:string)=>`/api/v1/spaces/${SPACE}/${isProject?`projects/${PROJECT}/information-briefings/${project}`:`information-briefings/personal/${personal}`}/highlights/0/${suffix}`;
const read=(isProject:boolean,suffix:string)=>app.inject({method:'POST',url:url(isProject,suffix),payload:{}});
const adopt=(isProject:boolean,hash:string,key=randomUUID())=>app.inject({method:'POST',url:url(isProject,'adoption'),headers:{'idempotency-key':key},payload:{preview_hash:hash}});
beforeEach(async()=>{
 if(!db.available)return;
 await world.seed();await world.material('Highlight evidence');
 await new ReadingPreferences(db.pool).set({spaceId:SPACE,userId:OWNER},PROJECT,true);
 for(const isProject of [false,true]){
  const result=await world.service().request(isProject?world.adapter():personalBriefingScope(SPACE,OWNER),OWNER,{kind:'manual',execution:{},origin:'manual',label:'Highlight'});
  const value=outputValue();
  if(!isProject){value.highlights[0]!.impact={assessment:'insufficient_context',text:'No focus',context_refs:[]};value.highlights[0]!.statements=[{kind:'fact',text:'Reported',refs:['S1']}];}
  await settleBriefingRun(db.pool,await world.finishRun((await world.runOf(result.briefing.id)).id,output(value)));
  if(isProject)project=result.briefing.id;else personal=result.briefing.id;
 }
 app=buildModuleServer(world.config(),[informationDigestModule,systemActionsModule]);
 __setAuthIdentityForTests({spaceId:SPACE,userId:OWNER});
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});
for(const isProject of [false,true])it(`exposes the ${isProject?'Project':'personal'} read-only previews and one atomic canonical adoption`,async()=>{
 const before=(await db.pool.query('SELECT id FROM runs ORDER BY id')).rows;
 const follow=await read(isProject,'follow-up');expect(follow.statusCode,follow.body).toBe(200);expect(follow.json().data.preview).toContain('Gripper launch');
 const preview=await read(isProject,'adoption/preview');expect(preview.statusCode,preview.body).toBe(200);
 expect((await db.pool.query('SELECT id FROM operation_idempotency')).rows).toHaveLength(0);
 const key=randomUUID(),hash=preview.json().data.preview_hash;
 const first=await adopt(isProject,hash,key);expect(first.statusCode,first.body).toBe(201);
 const replay=await adopt(isProject,hash,key);expect(replay.statusCode,replay.body).toBe(201);expect(replay.json().data).toEqual(first.json().data);
 const distinct=await adopt(isProject,hash);expect(distinct.statusCode,distinct.body).toBe(200);expect(distinct.json().data.task.id).toBe(first.json().data.task.id);
 const tasks=(await db.pool.query("SELECT project_id,visibility,metadata_json FROM tasks WHERE metadata_json->>'source'='information_briefing'")).rows;
 expect(tasks).toHaveLength(1);expect(tasks[0]).toMatchObject({project_id:isProject?PROJECT:null,visibility:isProject?'space_shared':'private'});
 expect((await db.pool.query('SELECT id FROM runs ORDER BY id')).rows).toEqual(before);
});
it('audits cross-owner evidence reads and releases no private audit metadata',async()=>{
 __setAuthIdentityForTests({spaceId:SPACE,userId:MEMBER});
 const response=await read(true,'follow-up');expect(response.statusCode,response.body).toBe(200);
 expect(Object.keys(response.json().data).sort()).toEqual(['briefing_id','highlight','scope_type','project_id','title','preview'].sort());
 expect((await db.pool.query("SELECT id FROM content_access_logs WHERE resource_type='source_item' AND owner_user_id=$1 AND viewer_user_id=$2",[OWNER,MEMBER])).rows.length).toBeGreaterThan(0);
 expect((await read(true,'adoption/preview')).statusCode).toBe(404);
});
it('rejects adoption replay and every preview after Source access is withdrawn',async()=>{
 const preview=await read(false,'adoption/preview'),key=randomUUID();
 expect((await adopt(false,preview.json().data.preview_hash,key)).statusCode).toBe(201);
 await db.pool.query("UPDATE source_connections SET status='archived' WHERE space_id=$1",[SPACE]);
 expect((await adopt(false,preview.json().data.preview_hash,key)).statusCode).toBe(404);
 expect((await read(false,'follow-up')).statusCode).toBe(404);
 expect((await read(false,'adoption/preview')).statusCode).toBe(404);
});
it('rolls back the canonical Task and its receipt when operation audit fails',async()=>{
 const preview=await read(true,'adoption/preview');
 await db.pool.query("CREATE FUNCTION refuse_highlight_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$");
 await db.pool.query('CREATE CONSTRAINT TRIGGER refuse_highlight_audit AFTER INSERT ON policy_decision_records DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_highlight_audit()');
 try{
  const response=await adopt(true,preview.json().data.preview_hash);expect(response.statusCode,response.body).toBe(503);
  expect((await db.pool.query("SELECT id FROM tasks WHERE metadata_json->>'source'='information_briefing'")).rows).toHaveLength(0);
  expect((await db.pool.query('SELECT id FROM operation_idempotency')).rows).toHaveLength(0);
 }finally{await db.pool.query('DROP TRIGGER refuse_highlight_audit ON policy_decision_records');await db.pool.query('DROP FUNCTION refuse_highlight_audit()');}
});
it('requires a confirmation key and rejects stale preview hashes',async()=>{
 const response=await app.inject({method:'POST',url:url(false,'adoption'),payload:{preview_hash:'0'.repeat(64)}});expect(response.statusCode).toBe(422);
 expect((await adopt(false,'0'.repeat(64))).statusCode).toBe(409);
 expect((await db.pool.query("SELECT id FROM tasks WHERE metadata_json->>'source'='information_briefing'")).rows).toHaveLength(0);
});

it('serializes competing Project confirmations without duplicate Tasks or lock upgrades',async()=>{
 const preview=await read(true,'adoption/preview');const hash=preview.json().data.preview_hash;
 const results=await Promise.all([adopt(true,hash),adopt(true,hash)]);
 expect(results.map(r=>r.statusCode).sort()).toEqual([200,201]);
 expect(results[0]!.json().data.task.id).toBe(results[1]!.json().data.task.id);
});
it('fails closed before releasing content when the B11 audit cannot commit',async()=>{
 __setAuthIdentityForTests({spaceId:SPACE,userId:MEMBER});
 await db.pool.query("CREATE FUNCTION refuse_highlight_read() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$");
 await db.pool.query('CREATE CONSTRAINT TRIGGER refuse_highlight_read AFTER INSERT ON content_access_logs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_highlight_read()');
 try{
  const response=await read(true,'follow-up');expect(response.statusCode,response.body).toBe(503);
  expect(response.body).not.toContain('Gripper launch');
  expect((await db.pool.query('SELECT id FROM content_access_logs')).rows).toHaveLength(0);
 }finally{await db.pool.query('DROP TRIGGER refuse_highlight_read ON content_access_logs');await db.pool.query('DROP FUNCTION refuse_highlight_read()');}
});

it('ignores unrelated revoked opt-ins for personal confirmation and replay without weakening evidence gates',async()=>{
 const stale=randomUUID();
 await db.pool.query(`INSERT INTO projects(id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES($1,$2,$3,'Private stale opt-in','active',now(),now())`,[stale,SPACE,OWNER]);
 await new ReadingPreferences(db.pool).set({spaceId:SPACE,userId:OWNER},stale,true);
 await db.pool.query('UPDATE projects SET owner_user_id=NULL WHERE id=$1',[stale]);
 const preview=await read(false,'adoption/preview');expect(preview.statusCode,preview.body).toBe(200);
 const hash=preview.json().data.preview_hash,key=randomUUID();
 const first=await adopt(false,hash,key);expect(first.statusCode,first.body).toBe(201);
 expect(first.body).not.toContain('Private stale opt-in');
 const replay=await adopt(false,hash,key);expect(replay.statusCode,replay.body).toBe(201);
 expect(replay.json().data).toEqual(first.json().data);
 await db.pool.query("UPDATE source_connections SET status='archived' WHERE space_id=$1",[SPACE]);
 expect((await adopt(false,hash)).statusCode).toBe(404);
 expect((await adopt(false,hash,key)).statusCode).toBe(404);
});

it('refuses personal confirmation and follow-up when the cited Project opt-in loses read access',async()=>{
 const preview=await read(false,'adoption/preview');expect(preview.statusCode,preview.body).toBe(200);
 await db.pool.query('UPDATE projects SET owner_user_id=NULL WHERE id=$1',[PROJECT]);
 for(const response of [await adopt(false,preview.json().data.preview_hash),await read(false,'follow-up')]){
  expect(response.statusCode,response.body).toBe(404);
  expect(response.body).not.toContain('Gripper launch');
 }
 expect((await db.pool.query("SELECT id FROM tasks WHERE metadata_json->>'source'='information_briefing'")).rows).toHaveLength(0);
});
