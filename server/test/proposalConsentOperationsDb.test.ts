import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedSpaceOwnerProject,seedSpaceMember,seedRun} from './support/domainSeeds.js';
import {buildModuleServer} from './support/moduleServer.js';
import {loadConfig} from '../src/config.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {proposalsModule} from '../src/modules/proposals/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {insertProposalRow} from '../src/modules/proposals/reviewPackets.js';
const db=useTestDatabase(import.meta.filename);
let app:ReturnType<typeof buildModuleServer>,space:string,owner:string,requester:string,proposal:string;
const url=()=>`/api/v1/proposals/${proposal}/approvals/egress-granting-user`;
const send=(body:object|string={},key:string|null=randomUUID())=>app.inject({method:'POST',url:url(),payload:body,headers:key?{'idempotency-key':key}:{}});
beforeEach(async()=>{
 await resetTables(db.pool,['spaces','users'],{cascade:true});
 space=randomUUID();owner=randomUUID();requester=randomUUID();
 await seedSpaceOwnerProject(db.pool,{space,owner,project:randomUUID()});
 await seedSpaceMember(db.pool,{space,user:requester});
 proposal=(await insertProposalRow(db.pool,{spaceId:space,proposalType:'egress_review',title:'Consent',rationale:'test',createdByUserId:requester,visibility:'space_shared',payload:{requires_approval_type:'egress_content_owner',required_egress_approver_user_ids:[owner]}})).id;
 app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),[proposalsModule,systemActionsModule]);
 __setAuthIdentityForTests({spaceId:space,userId:owner});
});
afterEach(async()=>{
 __setAuthIdentityForTests(null);await app?.close();
 if(!db.available)return;
 await db.pool.query('DROP TRIGGER IF EXISTS refuse_consent_audit ON policy_decision_records');
 await db.pool.query('DROP FUNCTION IF EXISTS refuse_consent_audit()');
 await db.pool.query('DROP TRIGGER IF EXISTS refuse_consent_receipt ON operation_idempotency');
 await db.pool.query('DROP FUNCTION IF EXISTS refuse_consent_receipt()');
});
describe('formal Proposal consent entry',()=>{
 it('commits consent, policy audit and receipt together; replays without accepting the requester Proposal',async()=>{
  const key=randomUUID(),first=await send({},key);expect(first.statusCode,first.body).toBe(200);
  const out=first.json().data;expect(out).toMatchObject({proposal_id:proposal,approver_user_id:owner,status:'approved'});
  const replay=await send({},key);expect(replay.statusCode,replay.body).toBe(200);expect(replay.json().data).toEqual(out);
  expect((await db.pool.query('SELECT id FROM proposal_approvals')).rows).toHaveLength(1);
  const receipt=(await db.pool.query("SELECT * FROM operation_idempotency WHERE operation_id='proposal.egress.approve'")).rows;
  expect(receipt).toHaveLength(1);expect(JSON.stringify(receipt[0])).toContain(out.id);
  expect((await db.pool.query("SELECT id FROM policy_decision_records WHERE action='proposal.egress.approve'")).rows.length).toBeGreaterThan(0);
  expect((await db.pool.query('SELECT status,created_by_user_id FROM proposals WHERE id=$1',[proposal])).rows[0]).toEqual({status:'pending',created_by_user_id:requester});
 });
 it.each([{grant_id:12},{user_id:'other'},{space_id:'other'},{proposal_id:'other'},{extra:true}])('refuses strict-field injection %j',async body=>{
  const res=await send(body);expect(res.statusCode,res.body).toBe(422);
  expect((await db.pool.query('SELECT id FROM proposal_approvals')).rows).toHaveLength(0);
 });
 it('preserves the canonical 422 for an inapplicable grant on taint-owner consent',async()=>{
  const res=await send({grant_id:randomUUID()});expect(res.statusCode,res.body).toBe(422);
  expect((await db.pool.query('SELECT id FROM proposal_approvals')).rows).toHaveLength(0);
 });
 it('requires a key and refuses the readable requester as consenting person',async()=>{
  expect((await send({},null)).statusCode).toBe(422);
  __setAuthIdentityForTests({spaceId:space,userId:requester});expect((await send()).statusCode).toBe(404);
 });
 it.each(['approval','owner','membership','terminal'])('refuses replay after %s revocation',async kind=>{
  const key=randomUUID();expect((await send({},key)).statusCode).toBe(200);
  if(kind==='approval')await db.pool.query("UPDATE proposal_approvals SET status='revoked',revoked_at=now() WHERE proposal_id=$1",[proposal]);
  if(kind==='owner')await db.pool.query('UPDATE proposals SET payload_json=$2::jsonb WHERE id=$1',[proposal,JSON.stringify({requires_approval_type:'egress_content_owner',required_egress_approver_user_ids:[requester]})]);
  if(kind==='membership')await db.pool.query("UPDATE space_memberships SET status='removed' WHERE space_id=$1 AND user_id=$2",[space,owner]);
  if(kind==='terminal')await db.pool.query("UPDATE proposals SET status='rejected' WHERE id=$1",[proposal]);
  expect((await send({},key)).statusCode).toBe(404);
 });
 it('rechecks a personal-memory grant on keyed replay',async()=>{
  const grant=randomUUID(),run=randomUUID(),key=randomUUID();
  await seedRun(db.pool,{id:run,space,owner:requester,agent:randomUUID(),version:randomUUID()});
  await db.pool.query(`INSERT INTO personal_memory_grants
   (id,granting_user_id,personal_space_id,target_space_id,target_run_id,grant_scope,access_mode,status,read_expires_at,egress_review_expires_at,created_at,updated_at)
   VALUES($1,$2,$3,$3,$4,'run','summary_only','used',now()+interval '1 hour',now()+interval '1 hour',now(),now())`,[grant,owner,space,run]);
  await db.pool.query('UPDATE proposals SET payload_json=$2::jsonb WHERE id=$1',[proposal,JSON.stringify({grant_id:grant,source_run_id:run})]);
  expect((await send({grant_id:grant},key)).statusCode).toBe(200);
  await db.pool.query("UPDATE personal_memory_grants SET status='revoked' WHERE id=$1",[grant]);
  expect((await send({grant_id:grant},key)).statusCode).toBe(404);
 });
 it('refuses consent when the policy audit cannot persist',async()=>{
  await db.pool.query(`CREATE FUNCTION refuse_consent_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit fault'; END $$`);
  await db.pool.query(`CREATE TRIGGER refuse_consent_audit BEFORE INSERT ON policy_decision_records FOR EACH ROW EXECUTE FUNCTION refuse_consent_audit()`);
  expect((await send()).statusCode).toBe(503);
  expect((await db.pool.query('SELECT id FROM proposal_approvals')).rows).toHaveLength(0);
  expect((await db.pool.query('SELECT id FROM operation_idempotency')).rows).toHaveLength(0);
 });
 it('rolls consent and audit back if receipt persistence fails',async()=>{
  await db.pool.query(`CREATE FUNCTION refuse_consent_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'receipt fault'; END $$`);
  await db.pool.query(`CREATE TRIGGER refuse_consent_receipt BEFORE INSERT ON operation_idempotency FOR EACH ROW EXECUTE FUNCTION refuse_consent_receipt()`);
  expect((await send()).statusCode).toBe(500);
  expect((await db.pool.query('SELECT id FROM proposal_approvals')).rows).toHaveLength(0);
 });
});
