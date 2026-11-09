import {assertSourceBindingDependency} from '../src/modules/projects/sourceBindingDependency.js';
import {PgProposalRepository} from '../src/modules/proposals/repository.js';
import {ProjectDefinitionProposalService} from '../src/modules/projects/projectDefinitionProposalService.js';
import {PgProposalApplyService} from '../src/modules/proposals/applyService.js';
import {linkProposalOperation} from './support/linkedProposalOperation.js';
import {lockRequestKey} from '../src/modules/systemActions/operations/repository.js';
import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {monitoringFixture} from './support/monitoringFixture.js';
import {seedSpaceMember,seedSpaceOwnerProject} from './support/domainSeeds.js';
import {insertProposalRow} from '../src/modules/proposals/reviewPackets.js';
import {ProjectSourceProposalService} from '../src/modules/projects/projectSourceProposalService.js';
import {operationTransaction} from '../src/db/operationTransaction.js';
const {db,space,owner,project,channel,identity,agent,config,propose,scope,service}=monitoringFixture(import.meta.filename);
async function activation(extra:Record<string,unknown>={}){
 return insertProposalRow(db.pool,{spaceId:space,proposalType:'source_channel_activation',title:'Activate',payload:{source_channel_id:channel},rationale:'test',createdByUserId:owner,visibility:'space_shared',projectId:project,...extra});
}
describe('Source binding dependency authority',()=>{
 it.each(['valid','foreignProject','foreignSpace','wrongType','private','wrongChannel','revokedProject'] as const)('validates activation dependency (%s)',async kind=>{
  if(!db.available)return;
  const other=randomUUID();await seedSpaceMember(db.pool,{space,user:other});
  const extra:Record<string,unknown>={};
  if(kind==='foreignProject'){const p=randomUUID();await db.pool.query("INSERT INTO projects(id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES($1,$2,$3,'Other','active',now(),now())",[p,space,owner]);extra.projectId=p;}
  if(kind==='foreignSpace'){const s=randomUUID(),p=randomUUID();await seedSpaceOwnerProject(db.pool,{space:s,owner:randomUUID(),project:p,spaceType:'team'});extra.spaceId=s;extra.projectId=p;}
  if(kind==='wrongType')extra.proposalType='memory_create';
  if(kind==='private'){extra.visibility='private';extra.createdByUserId=other;}
  if(kind==='wrongChannel')extra.payload={source_channel_id:randomUUID()};
  const parent=await activation(extra);
  if(kind==='revokedProject'){await db.pool.query('UPDATE projects SET owner_user_id=$2 WHERE id=$1',[project,other]);await db.pool.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2',[project,owner]);}
  const result=new ProjectSourceProposalService(db.pool).proposeBind(identity,project,{source_channel_id:channel,depends_on_proposal_id:parent.id});
  if(kind==='valid'){const created=await result;expect((await db.pool.query('SELECT payload_json FROM proposals WHERE id=$1',[created.proposal.id])).rows[0]!.payload_json).toMatchObject({depends_on_proposal_id:parent.id});}
  else await expect(result).rejects.toMatchObject({statusCode:404});
  expect((await db.pool.query("SELECT id FROM proposals WHERE proposal_type='project_source_bind'")).rows).toHaveLength(kind==='valid'?1:0);
 });
 it('requires a real existing BEGIN for raw clients, while Pool and branded ports retain their owner',async()=>{
  if(!db.available)return;
  const raw=await db.pool.connect();
  const input={spaceId:space,proposalType:'memory_create',title:'guard',payload:{},rationale:'test',createdByUserId:owner,visibility:'private'};
  try{
   await expect(insertProposalRow(raw,input)).rejects.toMatchObject({code:'operation_approval_state_inconsistent'});
   expect((await db.pool.query('SELECT id FROM proposals')).rows).toEqual([]);
   await raw.query('BEGIN');
   await insertProposalRow(raw,input);
   const port=operationTransaction(raw);
   try{await insertProposalRow(port.db,input);}finally{port.close();}
   await raw.query('ROLLBACK');
   expect((await db.pool.query('SELECT id FROM proposals')).rows).toEqual([]);
   await insertProposalRow(db.pool,input);
   expect((await db.pool.query('SELECT id FROM proposals')).rows).toHaveLength(1);
  }finally{await raw.query('ROLLBACK');raw.release();}
 });
});

describe('Project approval writer preflight',()=>{
 it.each(['definition','monitoring'] as const)('hides revoked Project authority before holding Proposal keys (%s)',async kind=>{
  if(!db.available)return;
  const definitions=new ProjectDefinitionProposalService(db.pool);
  const first=kind==='definition'?await definitions.proposeDefinition(identity,project,{goal:'Before'},{agentId:agent}):await propose();
  const id=String(first.proposal.id);const request=await linkProposalOperation(db.pool,identity,id);
  const row=(await db.pool.query('SELECT * FROM operation_idempotency WHERE id=$1',[request])).rows[0]!;
  const other=randomUUID();await seedSpaceMember(db.pool,{space,user:other});
  await db.pool.query('UPDATE projects SET owner_user_id=$2 WHERE id=$1',[project,other]);await db.pool.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2',[project,owner]);await db.pool.query("UPDATE space_memberships SET role='member' WHERE space_id=$1 AND user_id=$2",[space,owner]);
  const holder=await db.pool.connect();
  try{
   await holder.query('BEGIN');await lockRequestKey(holder,[row.space_id,row.principal_kind,row.principal_id,row.on_behalf,row.authority_scope_id,row.operation_id,row.idempotency_key]);
   const change=kind==='definition'?definitions.proposeDefinition(identity,project,{goal:'After'},{agentId:agent}):service().propose(identity,project,{config:scope(),expected_active_version_id:null,idempotency_key:'revoked-new'});
   await expect(change).rejects.toMatchObject({statusCode:403});
   expect((await db.pool.query('SELECT status FROM proposals WHERE id=$1',[id])).rows[0]!.status).toBe('pending');
  }finally{await holder.query('ROLLBACK');holder.release();}
 });
 it('rechecks forged legacy binding dependencies through the canonical applier',async()=>{
  if(!db.available)return;
  const parent=await activation({proposalType:'memory_create'});
  await db.pool.query("UPDATE proposals SET status='accepted' WHERE id=$1",[parent.id]);
  const child=await insertProposalRow(db.pool,{spaceId:space,proposalType:'project_source_bind',title:'Forged dependency',payload:{proposal_type:'project_source_bind',action_id:'project.source.propose_bind',source_channel_id:channel,project_id:project,depends_on_proposal_id:parent.id},rationale:'test',createdByUserId:owner,visibility:'space_shared',projectId:project});
  await expect(new PgProposalApplyService(config()).accept(child.id,identity)).rejects.toMatchObject({statusCode:404});
  expect((await db.pool.query('SELECT status FROM proposals WHERE id=$1',[child.id])).rows[0]!.status).toBe('pending');
 });
});

describe('activation dependency canonical review reach',()=>{
 it.each(['shared','ownPrivate','otherPrivate'] as const)('matches the existing review view (%s)',async kind=>{
  if(!db.available)return;
  const other=randomUUID();await seedSpaceMember(db.pool,{space,user:other});
  const parent=await activation({visibility:kind==='shared'?'space_shared':'private',createdByUserId:kind==='otherPrivate'?other:owner});
  const visible=await new PgProposalRepository(db.pool).getVisible(space,owner,parent.id);
  if(visible)await expect(assertSourceBindingDependency(db.pool,identity,project,channel,parent.id,true)).resolves.toBeUndefined();
  else await expect(assertSourceBindingDependency(db.pool,identity,project,channel,parent.id,true)).rejects.toMatchObject({statusCode:404});
  if(kind!=='otherPrivate')expect(visible).not.toBeNull();
 });
});
