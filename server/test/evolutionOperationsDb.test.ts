import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,expect,it} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedSpaceMember} from './support/domainSeeds.js';
import {waitForBlockedBy} from './support/lockWait.js';
import {buildModuleServer} from './support/moduleServer.js';
import {evolutionModule} from '../src/modules/evolution/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {loadConfig} from '../src/config.js';

const db=useTestDatabase(import.meta.filename);
let team:string,other:string,owner:string,member:string,outsider:string,app:ReturnType<typeof buildModuleServer>;
const as=(spaceId:string,userId:string)=>__setAuthIdentityForTests({spaceId,userId});
const call=(id:string,payload:object,key=randomUUID())=>app.inject({method:'POST',url:'/api/v1/actions/'+id,payload,headers:{'idempotency-key':key}});
const rest=(method:'POST'|'PATCH',url:string,payload:object,key:string|null=randomUUID())=>app.inject({method,url,payload,headers:key?{'idempotency-key':key}:{}});
const target=async(id:string)=>(await db.pool.query('SELECT space_id,target_type,risk_level,status,enabled,target_ref_id,metadata_json,engine_policy_json FROM evolution_targets WHERE id=$1',[id])).rows[0];
const insertTarget=async(space:string|null,type='workflow',status='active')=>{const id=randomUUID();await db.pool.query(`INSERT INTO evolution_targets(id,space_id,target_type,risk_level,status,enabled,engine_policy_json,metadata_json,created_at,updated_at) VALUES($1,$2,$3,'low',$4,true,'{}','{}',now(),now())`,[id,space,type,status]);return id;};
beforeEach(async()=>{
 await resetTables(db.pool,['evolution_signals','evolution_targets','spaces','users'],{cascade:true});
 team=randomUUID();other=randomUUID();owner=randomUUID();member=randomUUID();outsider=randomUUID();
 for(const s of [team,other])await db.pool.query("INSERT INTO spaces(id,name,type,created_at,updated_at) VALUES($1,'S','team',now(),now())",[s]);
 await seedSpaceMember(db.pool,{space:team,user:owner,role:'owner'});
 await seedSpaceMember(db.pool,{space:team,user:member,role:'member'});
 await seedSpaceMember(db.pool,{space:other,user:outsider,role:'owner'});
 app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri,RAINVER_HOME:`/tmp/rainver-evolution-ops-${process.pid}`}),[evolutionModule,systemActionsModule]);
 as(team,member);
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});

it('creates and edits a Space target across the retained URL and generic entry with strict input and identity receipts',async()=>{
 const key=randomUUID(),input={target_type:'workflow',target_name:'Review flow',risk_level:'high',engine_policy_json:{max_strategy_risk:'low'},metadata_json:{constraints:['a']}};
 const created=await rest('POST','/api/v1/evolution/targets',input,key);expect(created.statusCode,created.body).toBe(201);
 expect(Object.keys(created.json().data).sort()).toEqual(['space_id','target_id']);
 const id=created.json().data.target_id;
 const replay=await call('evolution.target.create',input,key);expect(replay.statusCode).toBe(201);expect(replay.json().data).toEqual(created.json().data);
 expect(await target(id)).toMatchObject({space_id:team,target_type:'workflow',risk_level:'high',status:'active',enabled:true,engine_policy_json:{max_strategy_risk:'low'},metadata_json:{constraints:['a'],target_name:'Review flow',purpose:null}});
 expect((await call('evolution.target.create',{...input,risk_level:'low'},key)).statusCode).toBe(422);
 for(const bad of [{target_type:'capability'},{target_type:'workflow',risk_level:'extreme'},{target_type:'workflow',status:'deleted'},{target_type:'workflow',space_id:other}])expect((await call('evolution.target.create',bad)).statusCode).toBe(422);
 expect((await rest('POST','/api/v1/evolution/targets',{target_type:'memory'},null)).statusCode).toBe(422);
 // A partial edit keeps omitted fields; null clears a nullable one; the body may not restate the URL's target.
 expect((await rest('PATCH',`/api/v1/evolution/targets/${id}`,{target_id:randomUUID(),status:'paused'})).statusCode).toBe(422);
 const edited=await rest('PATCH',`/api/v1/evolution/targets/${id}`,{status:'paused',target_ref_id:'ref-1',metadata_json:{constraints:[]}});expect(edited.statusCode,edited.body).toBe(200);
 expect(edited.json().data).toEqual({space_id:team,target_id:id});
 expect(await target(id)).toMatchObject({status:'paused',risk_level:'high',target_ref_id:'ref-1',metadata_json:{constraints:[],target_name:'Review flow'}});
 expect((await rest('PATCH',`/api/v1/evolution/targets/${id}`,{target_ref_id:null})).statusCode).toBe(200);
 expect((await target(id)).target_ref_id).toBeNull();
 // The authorized reader still serves the full row.
 expect((await app.inject({method:'GET',url:`/api/v1/evolution/targets/${id}`})).json()).toMatchObject({id,status:'paused',target_name:'Review flow'});
});

it('keeps system and other-Space targets out of reach and retired types archived, and re-checks replay authority',async()=>{
 const system=await insertTarget(null),foreign=await insertTarget(other);
 const sys=await call('evolution.target.update',{target_id:system,status:'paused'});expect(sys.statusCode).toBe(409);expect(sys.json().error.message).toBe('System evolution targets are read-only');
 expect((await call('evolution.target.update',{target_id:foreign,status:'paused'})).statusCode).toBe(404);
 expect((await call('evolution.target.update',{target_id:system,target_type:'capability'})).statusCode).toBe(422);
 const retired=await insertTarget(team,'runtime_skill_binding','archived');
 const reopen=await call('evolution.target.update',{target_id:retired,status:'active'});expect(reopen.statusCode).toBe(422);expect(reopen.json().error.message).toBe('A retired target type can only stay archived');
 expect((await call('evolution.target.update',{target_id:retired,target_name:'Historical'})).statusCode).toBe(200);
 expect(await target(retired)).toMatchObject({target_type:'runtime_skill_binding',status:'archived',metadata_json:{target_name:'Historical'}});
 // Membership is the authority: a former member's replay is hidden, and a non-member cannot act at all.
 const key=randomUUID();expect((await call('evolution.target.create',{target_type:'knowledge'},key)).statusCode).toBe(201);
 await db.pool.query("UPDATE space_memberships SET status='revoked' WHERE space_id=$1 AND user_id=$2",[team,member]);
 expect((await call('evolution.target.create',{target_type:'knowledge'},key)).statusCode).toBe(404);
 as(team,outsider);expect((await call('evolution.target.create',{target_type:'knowledge'})).statusCode).toBe(404);
 expect((await db.pool.query('SELECT count(*)::int AS n FROM evolution_targets WHERE space_id=$1',[team])).rows[0].n).toBe(2);
});

it('records and triages signals with a pinned dismiss URL, never touching another Space or system-wide signals',async()=>{
 const own=await insertTarget(team),system=await insertTarget(null);
 const key=randomUUID(),input={signal_type:'review_requested',source_type:'manual',severity:'medium',summary:'Look again',payload_json:{n:1}};
 const created=await rest('POST',`/api/v1/evolution/targets/${system}/signals`,input,key);expect(created.statusCode,created.body).toBe(201);
 const signal=created.json().data.signal_id;expect(created.json().data).toEqual({space_id:team,target_id:system,signal_id:signal});
 expect((await call('evolution.signal.create',{...input,target_id:system},key)).json().data).toEqual(created.json().data);
 expect((await call('evolution.signal.create',{...input,target_id:own,severity:'loud'})).statusCode).toBe(422);
 expect((await call('evolution.signal.create',{...input,target_id:await insertTarget(other)})).statusCode).toBe(404);
 const ack=await rest('PATCH',`/api/v1/evolution/signals/${signal}`,{triage_status:'acknowledged',triage_note:'Next review'});expect(ack.statusCode,ack.body).toBe(200);
 const dismissed=await rest('POST',`/api/v1/evolution/signals/${signal}/dismiss`,{});expect(dismissed.statusCode,dismissed.body).toBe(200);
 expect((await rest('POST',`/api/v1/evolution/signals/${signal}/dismiss`,{triage_status:'new'})).statusCode).toBe(422);
 const read=await app.inject({method:'GET',url:`/api/v1/evolution/signals/${signal}`});
 expect(read.json()).toMatchObject({id:signal,triage_status:'dismissed',triage_note:'Next review'});
 expect((await db.pool.query('SELECT triaged_by_user_id FROM evolution_signals WHERE id=$1',[signal])).rows[0].triaged_by_user_id).toBe(member);
 expect((await rest('PATCH',`/api/v1/evolution/signals/${signal}`,{triage_status:'new'})).statusCode).toBe(200);
 expect((await db.pool.query('SELECT triage_status,triaged_at,triaged_by_user_id FROM evolution_signals WHERE id=$1',[signal])).rows[0]).toEqual({triage_status:'new',triaged_at:null,triaged_by_user_id:null});
 // System-wide (space-less) signals and another Space's signals are not this Space's to triage.
 const global=randomUUID();await db.pool.query(`INSERT INTO evolution_signals(id,space_id,target_id,signal_type,source_type,severity,payload_json,created_at) VALUES($1,NULL,$2,'x','run','info','{}',now())`,[global,system]);
 expect((await call('evolution.signal.triage',{signal_id:global,triage_status:'dismissed'})).statusCode).toBe(404);
 as(other,outsider);
 expect((await call('evolution.signal.triage',{signal_id:signal,triage_status:'dismissed'})).statusCode).toBe(404);
 expect((await app.inject({method:'GET',url:`/api/v1/evolution/signals/${signal}`})).statusCode).toBe(404);
});

it('serializes a signal on the target row, so a concurrent edit finishes first and the signal still lands',async()=>{
 const id=await insertTarget(team);
 const holder=await db.pool.connect();
 try{
  await holder.query('BEGIN');await holder.query('SELECT id FROM evolution_targets WHERE id=$1 FOR UPDATE',[id]);
  const pid=(await holder.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  const pending=call('evolution.signal.create',{target_id:id,signal_type:'review_requested',source_type:'manual'});
  await waitForBlockedBy(db.pool,pid);
  await holder.query("UPDATE evolution_targets SET status='paused' WHERE id=$1",[id]);await holder.query('COMMIT');
  expect((await pending).statusCode).toBe(201);
 }finally{holder.release();}
 expect((await db.pool.query('SELECT count(*)::int AS n FROM evolution_signals WHERE target_id=$1',[id])).rows[0].n).toBe(1);
});
