import {waitForBlockedBy} from './support/lockWait.js';
import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,expect,it} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedSpaceMember} from './support/domainSeeds.js';
import {buildModuleServer} from './support/moduleServer.js';
import {spacesModule} from '../src/modules/spaces/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {hashOpaqueToken} from '../src/modules/auth/securityPolicy.js';
import {RETRIEVAL_EMBEDDING_JOB} from '../src/modules/retrieval/embedding/config.js';
import {loadConfig} from '../src/config.js';
import {getOrCreateSpaceRetrievalSettings} from '../src/modules/retrieval/settings.js';

const db=useTestDatabase(import.meta.filename);
let team:string,owner:string,admin:string,member:string,app:ReturnType<typeof buildModuleServer>;
const secret=()=>Buffer.from(randomUUID()+randomUUID()).toString('base64url');
const as=(spaceId:string,userId:string)=>__setAuthIdentityForTests({spaceId,userId});
const call=(id:string,payload:object,key=randomUUID())=>app.inject({method:'POST',url:'/api/v1/actions/'+id,payload,headers:{'idempotency-key':key}});
const rest=(method:'POST'|'PATCH',url:string,payload:object,key:string|null=randomUUID())=>app.inject({method,url,payload,headers:key?{'idempotency-key':key}:{}});
const stored=async()=>JSON.stringify((await db.pool.query('SELECT fingerprint,result_json,frozen_json FROM operation_idempotency')).rows);
beforeEach(async()=>{
 await resetTables(db.pool,['spaces','users'],{cascade:true});
 team=randomUUID();owner=randomUUID();admin=randomUUID();member=randomUUID();
 await db.pool.query("INSERT INTO spaces(id,name,type,created_at,updated_at) VALUES($1,'Team','team',now(),now())",[team]);
 await seedSpaceMember(db.pool,{space:team,user:owner,role:'owner'});
 await seedSpaceMember(db.pool,{space:team,user:admin,role:'admin'});
 await seedSpaceMember(db.pool,{space:team,user:member,role:'member'});
 app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri,RAINVER_HOME:`/tmp/rainver-space-ops-${process.pid}`}),[spacesModule,systemActionsModule]);
 as(team,owner);
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});

it('creates one owned Space across the retained URL and generic entry, with strict input and an identity receipt',async()=>{
 const key=randomUUID(),input={name:'Lab',type:'household',oversight_mode:'content'};
 const first=await rest('POST','/api/v1/spaces',input,key);expect(first.statusCode,first.body).toBe(201);
 expect(Object.keys(first.json().data)).toEqual(['space_id']);
 const replay=await call('space.create',input,key);expect(replay.statusCode,replay.body).toBe(201);expect(replay.json().data).toEqual(first.json().data);
 const created=first.json().data.space_id;
 expect((await db.pool.query('SELECT s.type,s.oversight_mode,s.egress_notifications_enabled,m.user_id,m.role FROM spaces s JOIN space_memberships m ON m.space_id=s.id WHERE s.id=$1',[created])).rows)
  .toEqual([{type:'household',oversight_mode:'content',egress_notifications_enabled:false,user_id:owner,role:'owner'}]);
 expect((await call('space.create',{name:'Other'},key)).statusCode).toBe(422);
 for(const bad of [{name:'Mine',type:'personal'},{name:'X',oversight_mode:'godmode'},{name:''}])expect((await call('space.create',bad)).statusCode).toBe(422);
 expect((await rest('POST','/api/v1/spaces',{name:'Unkeyed'},null)).statusCode).toBe(422);
 expect((await db.pool.query("SELECT count(*)::int AS n FROM spaces WHERE type<>'personal'")).rows[0].n).toBe(2);
 // A replay is released only while the creator is still a member of what it created.
 await db.pool.query("UPDATE space_memberships SET status='revoked' WHERE space_id=$1",[created]);
 expect((await call('space.create',input,key)).statusCode).toBe(404);
});

it('binds a Space URL to that Space, keeps the invitation secret out of every stored row and admits the invitee once',async()=>{
 const invitee=randomUUID();await db.pool.query("INSERT INTO users(id,display_name,status,created_at,updated_at,email,registration_source) VALUES($1,'Invitee','active',now(),now(),'invitee@example.test','system')",[invitee]);
 const personal=randomUUID();await db.pool.query("INSERT INTO spaces(id,name,type,created_at,updated_at) VALUES($1,'P','personal',now(),now())",[personal]);
 await db.pool.query("INSERT INTO space_memberships(id,space_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,'owner','active',now(),now())",[randomUUID(),personal,invitee]);
 const token=secret(),key=randomUUID(),input={email:'Invitee@Example.test',role:'member',token};
 // The URL's Space must be the actor's Space.
 as(personal,invitee);
 expect((await rest('POST',`/api/v1/spaces/${team}/invitations`,input,key)).statusCode).toBe(404);
 as(team,admin);
 expect((await rest('POST',`/api/v1/spaces/${team}/invitations`,{...input,space_id:randomUUID()})).statusCode).toBe(422);
 const created=await rest('POST',`/api/v1/spaces/${team}/invitations`,input,key);expect(created.statusCode,created.body).toBe(201);
 expect(created.json().data).toMatchObject({space_id:team,invited_email:'invitee@example.test',role:'member',status:'available'});
 expect(created.body).not.toContain(token);
 const replay=await call('space.invitation.create',{...input,space_id:team},key);expect(replay.statusCode,replay.body).toBe(201);expect(replay.json().data).toEqual(created.json().data);
 expect((await call('space.invitation.create',{...input,space_id:team,token:secret()},key)).statusCode).toBe(422);
 expect((await db.pool.query('SELECT token_hash FROM user_invitations')).rows).toEqual([{token_hash:hashOpaqueToken(token)}]);
 // The inviter's own role bounds the grant; the refusal says why.
 const refused=await call('space.invitation.create',{space_id:team,email:'b@example.test',role:'owner',token:secret()});
 expect(refused.statusCode).toBe(422);expect(refused.json().error.message).toBe('A admin cannot grant the owner role');
 as(team,member);
 expect((await call('space.invitation.create',{space_id:team,email:'c@example.test',token:secret()})).statusCode).toBe(404);
 // The invited account claims it from its own Space.
 as(personal,invitee);
 const claimKey=randomUUID();
 const accepted=await rest('POST','/api/v1/invitations/accept',{token},claimKey);expect(accepted.statusCode,accepted.body).toBe(200);expect(accepted.json().data).toEqual({space_id:team});
 expect((await call('space.invitation.accept',{token},claimKey)).json().data).toEqual({space_id:team});
 expect((await db.pool.query('SELECT role FROM space_memberships WHERE space_id=$1 AND user_id=$2',[team,invitee])).rows).toEqual([{role:'member'}]);
 const again=await call('space.invitation.accept',{token});expect(again.statusCode).toBe(422);expect(again.json().error.message).toBe('Invalid invitation');
 expect(await stored()).not.toContain(token);
 // An inviter who lost manager standing no longer receives the receipt.
 await db.pool.query("UPDATE space_memberships SET role='member' WHERE space_id=$1 AND user_id=$2",[team,admin]);
 as(team,admin);
 expect((await call('space.invitation.create',{...input,space_id:team},key)).statusCode).toBe(404);
});

it('changes Space settings only for a live manager, held against a concurrent demotion',async()=>{
 as(team,member);
 expect((await rest('PATCH',`/api/v1/spaces/${team}/content-egress`,{member_copy_out_enabled:true})).statusCode).toBe(404);
 as(team,admin);
 expect((await rest('PATCH',`/api/v1/spaces/${team}/snapshot-defaults`,{snapshot_retention_days_default:0})).statusCode).toBe(422);
 expect((await rest('PATCH',`/api/v1/spaces/${team}/retrieval-settings`,{oversight_mode:'full'})).statusCode).toBe(422);
 const key=randomUUID();
 const saved=await rest('PATCH',`/api/v1/spaces/${team}/snapshot-defaults`,{snapshot_retention_days_default:30},key);expect(saved.statusCode,saved.body).toBe(200);expect(saved.json().data).toEqual({space_id:team});
 expect((await db.pool.query('SELECT snapshot_retention_days_default,snapshot_max_count_default FROM spaces WHERE id=$1',[team])).rows).toEqual([{snapshot_retention_days_default:30,snapshot_max_count_default:null}]);
 // A demotion holding the membership row blocks the write; once committed, the manager has no authority.
 const demotion=await db.pool.connect();
 try{
  await demotion.query('BEGIN');const {rows:[{pid}]}=await demotion.query<{pid:number}>('SELECT pg_backend_pid() AS pid');
  await demotion.query("UPDATE space_memberships SET role='member' WHERE space_id=$1 AND user_id=$2",[team,admin]);
  const pending=rest('PATCH',`/api/v1/spaces/${team}/content-egress`,{member_copy_out_enabled:true});
  await waitForBlockedBy(db.pool,pid);
  await demotion.query('COMMIT');
  expect((await pending).statusCode).toBe(404);
 }finally{demotion.release();}
 expect((await db.pool.query('SELECT member_copy_out_enabled FROM spaces WHERE id=$1',[team])).rows[0].member_copy_out_enabled).toBe(false);
 expect((await rest('PATCH',`/api/v1/spaces/${team}/snapshot-defaults`,{snapshot_retention_days_default:30},key)).statusCode).toBe(404);
 as(team,owner);
 expect((await rest('PATCH',`/api/v1/spaces/${team}/content-egress`,{member_copy_out_enabled:true})).statusCode).toBe(200);
 expect((await db.pool.query('SELECT member_copy_out_enabled FROM spaces WHERE id=$1',[team])).rows[0].member_copy_out_enabled).toBe(true);
});

it('queues the embedding backfill in the settings transaction and leaves neither behind when audit fails',async()=>{
 const jobs=async()=>(await db.pool.query('SELECT count(*)::int AS n FROM jobs WHERE job_type=$1 AND space_id=$2',[RETRIEVAL_EMBEDDING_JOB,team])).rows[0].n;
 await db.pool.query("CREATE FUNCTION refuse_space_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE'; END $$");
 await db.pool.query('CREATE TRIGGER refuse_space_audit BEFORE INSERT ON policy_decision_records FOR EACH ROW EXECUTE FUNCTION refuse_space_audit()');
 try{
  const r=await rest('PATCH',`/api/v1/spaces/${team}/retrieval-settings`,{embedding_dimensions:768});expect(r.statusCode).toBe(503);expect(r.body).not.toContain('PRIVATE');
 }finally{await db.pool.query('DROP TRIGGER refuse_space_audit ON policy_decision_records');await db.pool.query('DROP FUNCTION refuse_space_audit()');}
 expect(await jobs()).toBe(0);
 const key=randomUUID();
 const first=await rest('PATCH',`/api/v1/spaces/${team}/retrieval-settings`,{embedding_dimensions:768,rerank_enabled:true},key);expect(first.statusCode,first.body).toBe(200);
 expect(await jobs()).toBe(1);
 expect((await rest('PATCH',`/api/v1/spaces/${team}/retrieval-settings`,{embedding_dimensions:768,rerank_enabled:true},key)).statusCode).toBe(200);
 expect((await rest('PATCH',`/api/v1/spaces/${team}/retrieval-settings`,{rerank_enabled:false})).statusCode).toBe(200);
 expect(await jobs()).toBe(1);
 expect(await getOrCreateSpaceRetrievalSettings(db.pool,team)).toMatchObject({embedding_dimensions:768,rerank_enabled:false});
});
