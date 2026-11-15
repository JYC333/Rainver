import type {AgentWorkIdentity} from '@rainver/protocol';
import {lockActivePerson} from '../access/activePerson.js';
import {lockDemotionReleaseClosure} from '../contentAccess/demotionReleaseClosure.js';
import {HttpError,type Queryable} from '../routeUtils/common.js';
import {canonical} from '../systemActions/operations/repository.js';
import {AgentAttentionRepository,type WorkTarget} from './repository.js';

/** Discover the complete connected spectrum before taking any domain lock.
 * The canonical projector still decides visibility; discovery grants no reach. */
export async function admitAttention(db:Queryable,userId:string,spaceId:string,identity:AgentWorkIdentity):Promise<void>{
 const target:WorkTarget={space_id:spaceId,identity};
 const discover=async()=>{
  const runs=await new AgentAttentionRepository(db).targetRunIds(userId,target);
  const scopeRows=runs.length?(await db.query<{project_id:string|null}>(`SELECT s.project_id FROM runs r JOIN sessions s ON s.space_id=r.space_id AND s.id=r.session_id WHERE r.space_id=$1 AND r.id=ANY($2::varchar[])
   UNION SELECT g.project_id FROM runs r JOIN agent_run_groups g ON g.space_id=r.space_id AND g.id=r.run_group_id WHERE r.space_id=$1 AND r.id=ANY($2::varchar[])
   UNION SELECT s.project_id FROM runs r JOIN agent_run_groups g ON g.space_id=r.space_id AND g.id=r.run_group_id JOIN sessions s ON s.space_id=g.space_id AND s.id=g.session_id WHERE r.space_id=$1 AND r.id=ANY($2::varchar[])`,[spaceId,runs])).rows:[];
  const projects=[...new Set(scopeRows.flatMap(r=>r.project_id?[r.project_id]:[]))].sort();
  const proposals=runs.length?(await db.query<{id:string}>('SELECT id FROM proposals WHERE space_id=$1 AND created_by_run_id=ANY($2::varchar[]) ORDER BY id',[spaceId,runs])).rows.map(r=>r.id):[];
  const facts=await new AgentAttentionRepository(db).facts(userId,target);
  const tasks=[...new Set([...(identity.kind==='task'?[identity.source_id]:[]),...facts.tasks.map(t=>t.id)])].sort();
  const messages=facts.runs.flatMap(r=>r.message_id?[r.message_id]:[]).sort();
  const authorizations=facts.runs.flatMap(r=>r.authorization_request_id?[r.authorization_request_id]:[]).sort();
  const merges=facts.extras.flatMap(e=>e.subject.kind==='task_merge'?[e.subject.merge_id]:[]).sort();
  const revisions={
   runs:facts.runs.map(r=>({id:r.id,attempt:r.attempt_id,message:r.message_id,revision:r.message_revision})),
   tasks:facts.tasks.map(t=>({id:t.id,updated_at:t.updated_at})),
   extras:facts.extras.map(e=>e.subject),
  };
  return {runs:[...runs].sort(),projects,proposals,tasks,messages,authorizations,merges,revisions};
 };
 const before=await discover();
 const root=before.runs[0]??before.tasks[0];
 if(root)await lockDemotionReleaseClosure(db,{spaceId,userId},{
  resource:{type:before.runs.length?'run':'task',id:root},runIds:before.runs,artifactIds:[],proposalIds:before.proposals,taskIds:before.tasks,additionalProjectIds:before.projects,
 });
 else await lockActivePerson(db,spaceId,userId);
 for(const [table,ids] of [['messages',before.messages],['authorization_requests',before.authorizations],['task_merges',before.merges]] as const){
  if(ids.length)await db.query(`SELECT id FROM ${table} WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id FOR SHARE`,[spaceId,ids]);
 }
 if(canonical(before)!==canonical(await discover()))throw new HttpError(409,'Attention scope changed');
}
