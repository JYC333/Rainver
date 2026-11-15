import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedSpaceOwnerProject,seedSpaceMember} from './support/domainSeeds.js';
import {buildModuleServer} from './support/moduleServer.js';
import {loadConfig} from '../src/config.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {proposalsModule} from '../src/modules/proposals/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {linkProposalOperation} from './support/linkedProposalOperation.js';
import {insertProposalRow} from '../src/modules/proposals/reviewPackets.js';
const db=useTestDatabase(import.meta.filename);
let app:ReturnType<typeof buildModuleServer>,space:string,owner:string,requester:string,proposal:string;
const send=(body:object|string={},key:string|null=randomUUID())=>app.inject({method:'POST',url:`/api/v1/proposals/${proposal}/reject`,payload:body,headers:key?{'idempotency-key':key}:{}});
beforeEach(async()=>{
 await resetTables(db.pool,['spaces','users'],{cascade:true});
 space=randomUUID();owner=randomUUID();requester=randomUUID();
 await seedSpaceOwnerProject(db.pool,{space,owner,project:randomUUID()});
 await seedSpaceMember(db.pool,{space,user:requester});
 proposal=(await insertProposalRow(db.pool,{spaceId:space,proposalType:'memory_create',title:'Decline',rationale:'test',requiredApproverRole:'owner',createdByUserId:requester,visibility:'space_shared',payload:{proposed_content:'must not become active'}})).id;
 app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),[proposalsModule,systemActionsModule]);
 __setAuthIdentityForTests({spaceId:space,userId:owner});
});
afterEach(async()=>{
 __setAuthIdentityForTests(null);await app?.close();
 if(!db.available)return;
 await db.pool.query('DROP TRIGGER IF EXISTS refuse_rejection_receipt ON operation_idempotency');
 await db.pool.query('DROP FUNCTION IF EXISTS refuse_rejection_receipt()');
});
describe('formal canonical Proposal rejection',()=>{
 it('atomically rejects with audit and receipt and replays the result without Memory effects',async()=>{
  const key=randomUUID(),first=await send({},key);expect(first.statusCode,first.body).toBe(200);
  expect(first.json().data).toMatchObject({id:proposal,status:'rejected'});
  const replay=await send({},key);expect(replay.statusCode,replay.body).toBe(200);expect(replay.json().data).toEqual(first.json().data);
  expect((await db.pool.query('SELECT id FROM memory_entries')).rows).toHaveLength(0);
  expect((await db.pool.query("SELECT id FROM operation_idempotency WHERE operation_id='proposal.reject'")).rows).toHaveLength(1);
  expect((await db.pool.query("SELECT id FROM policy_decision_records WHERE action='proposal.reject'")).rows.length).toBeGreaterThan(0);
 });
 it('allows the original creator to decline their own draft',async()=>{
  __setAuthIdentityForTests({spaceId:space,userId:requester});const res=await send();expect(res.statusCode,res.body).toBe(200);
 });
 it('requires a key and rejects injected authority',async()=>{
  expect((await send({},null)).statusCode).toBe(422);
  expect((await send({user_id:owner})).statusCode).toBe(422);
 });
 it('refuses a new key for an already terminal decision',async()=>{
  expect((await send()).statusCode).toBe(200);expect((await send()).statusCode).toBe(404);
 });
 it('rechecks current authority on replay',async()=>{
  const key=randomUUID();expect((await send({},key)).statusCode).toBe(200);
  await db.pool.query("UPDATE space_memberships SET role='member' WHERE space_id=$1 AND user_id=$2",[space,owner]);
  expect((await send({},key)).statusCode).toBe(404);
 });
 it.each([false,true])('closes recursive linked dependents atomically (receipt fault=%s)',async fault=>{
  await db.pool.query("UPDATE proposals SET proposal_type='source_channel_activation',payload_json=$2::jsonb WHERE id=$1",[proposal,JSON.stringify({source_channel_id:randomUUID()})]);
  const child=(await insertProposalRow(db.pool,{spaceId:space,proposalType:'project_source_bind',title:'Dependent',rationale:'test',createdByUserId:requester,visibility:'space_shared',payload:{depends_on_proposal_id:proposal}})).id;
  const linked=[await linkProposalOperation(db.pool,{spaceId:space,userId:requester},proposal),await linkProposalOperation(db.pool,{spaceId:space,userId:requester},child)];
  if(fault){
   await db.pool.query(`CREATE FUNCTION refuse_rejection_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.operation_id='proposal.reject' THEN RAISE EXCEPTION 'receipt fault'; END IF; RETURN NEW; END $$`);
   await db.pool.query(`CREATE TRIGGER refuse_rejection_receipt BEFORE INSERT ON operation_idempotency FOR EACH ROW EXECUTE FUNCTION refuse_rejection_receipt()`);
  }
  const res=await send();expect(res.statusCode,res.body).toBe(fault?500:200);
  expect((await db.pool.query('SELECT status FROM proposals WHERE id=$1',[proposal])).rows[0].status).toBe(fault?'pending':'rejected');
  expect((await db.pool.query('SELECT status FROM proposals WHERE id=$1',[child])).rows[0].status).toBe(fault?'pending':'superseded');
  const states=(await db.pool.query('SELECT state FROM operation_idempotency WHERE id=ANY($1::varchar[]) ORDER BY state',[linked])).rows.map(r=>r.state);
  expect(states).toEqual(fault?['pending_approval','pending_approval']:['rejected','superseded']);
 });
 it('preserves the canonical gate for a pending Bundle member',async()=>{
  const bundle=randomUUID();
  await db.pool.query("INSERT INTO evolution_bundles(id,space_id,title,status,risk_level,created_by_user_id,created_at,updated_at) VALUES($1,$2,'Review','pending_review','low',$3,now(),now())",[bundle,space,owner]);
  await db.pool.query("INSERT INTO evolution_bundle_members(id,bundle_id,proposal_id,position,status,created_at) VALUES($1,$2,$3,1,'pending',now())",[randomUUID(),bundle,proposal]);
  expect((await send()).statusCode).toBe(409);
  expect((await db.pool.query('SELECT status FROM proposals WHERE id=$1',[proposal])).rows[0].status).toBe('pending');
 });
 it('rolls the decision back if its receipt cannot persist',async()=>{
  await db.pool.query(`CREATE FUNCTION refuse_rejection_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'receipt fault'; END $$`);
  await db.pool.query(`CREATE TRIGGER refuse_rejection_receipt BEFORE INSERT ON operation_idempotency FOR EACH ROW EXECUTE FUNCTION refuse_rejection_receipt()`);
  expect((await send()).statusCode).toBe(500);
  expect((await db.pool.query('SELECT status FROM proposals WHERE id=$1',[proposal])).rows[0].status).toBe('pending');
 });
});
