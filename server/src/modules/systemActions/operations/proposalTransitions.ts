import {assertProjectWriter} from '../../projects/access.js';
import {withPolicyAuditRecovery} from '../../policy/auditWriter.js';
import {withQueryableTransaction} from '../../routeUtils/common.js';
import {operationTransaction,isOperationTransaction,operationTransactionHost} from '../../../db/operationTransaction.js';
import type {Queryable} from '../../routeUtils/common.js';
import {canonical,lockRequestKey,type RequestRow} from './repository.js';
import {OperationError} from './errors.js';

interface Linked extends RequestRow {
  principal_kind:string;principal_id:string;on_behalf:string;authority_scope_id:string;idempotency_key:string;
}
const scope=(row:Linked)=>[row.space_id,row.principal_kind,row.principal_id,row.on_behalf,row.authority_scope_id,row.operation_id,row.idempotency_key];
const conflict=()=>new OperationError('operation_conflict',409);
const inconsistent=()=>new OperationError('operation_approval_state_inconsistent',503);
/** Reuse the core brand, or verify that a legacy checked-out client really owns BEGIN.
 * Two real transaction ids distinguish an explicit transaction from auto-commit.
 * This is a guard, never a new BEGIN/COMMIT owner or a cached lifetime assumption.
 */
export async function assertProposalTransaction(db:Queryable):Promise<void>{
 if(isOperationTransaction(db))return;
 const first=(await db.query<{id:string}>('SELECT txid_current()::text AS id')).rows[0]?.id;
 const second=(await db.query<{id:string}>('SELECT txid_current()::text AS id')).rows[0]?.id;
 if(!first || first!==second)throw inconsistent();
}
/** Dependency creation joins the cascade gate. Never waits while holding another writer's locks. */
export async function lockProposalDependencies(db:Queryable,spaceId:string,ids:readonly string[]):Promise<void>{
  await assertProposalTransaction(db);
  for(const id of [...new Set(ids)].sort()){
    const result=await db.query<{locked:boolean}>('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked',[`proposal-dependents:${spaceId}:${id}`]);
    if(!result.rows[0]?.locked)throw new OperationError('idempotency_in_progress',409,true);
  }
}
/** Skill reviews are a whole-package decision, including reviews inserted concurrently. */
export async function lockSkillReviewProposals(db:Queryable,spaceId:string,packageIds:readonly string[],inserting=false):Promise<void>{
  await assertProposalTransaction(db);
  for(const id of [...new Set(packageIds)].sort()){
    const lock=await db.query<{locked:boolean}>(`SELECT ${inserting?'pg_try_advisory_xact_lock_shared':'pg_try_advisory_xact_lock'}(hashtextextended($1,0)) AS locked`,[`proposal-skill-review:${spaceId}:${id}`]);
    if(!lock.rows[0]?.locked)throw new OperationError('idempotency_in_progress',409,true);
  }
}
interface ProposalRef {id:string;space_id:string}
interface RunRef {id:string;space_id:string}
const identities=(rows:ProposalRef[])=>rows.map(row=>[row.space_id,row.id]);
/** Complete key admission, then closure gates, then Proposal/request rows. */
async function admitTransitions(db:Queryable,discover:()=>Promise<ProposalRef[]>,gate?:()=>Promise<void>,requireUnlinked=false,nowaitRows=false){
  await assertProposalTransaction(db);
  const refs=await discover(),ids=refs.map(row=>row.id);
  const links=async()=> (await db.query<Linked>(`SELECT r.* FROM operation_idempotency r JOIN proposals p ON p.id=r.proposal_id AND p.space_id=r.space_id
    WHERE p.id=ANY($1::varchar[]) ORDER BY r.id`,[ids])).rows;
  const candidates=await links();
  if(requireUnlinked && candidates.length)throw new OperationError('operation_approval_mapping_unavailable',503);
  const ordered=[...candidates].sort((a,b)=>canonical(scope(a))<canonical(scope(b))?-1:canonical(scope(a))>canonical(scope(b))?1:0);
  for(const candidate of ordered)await lockRequestKey(db,scope(candidate));
  // No domain/Proposal row lock may precede the complete sorted key set.
  await gate?.();
  const packages=(await db.query<{space_id:string;id:string}>("SELECT DISTINCT space_id,payload_json->>'skill_package_id' AS id FROM proposals WHERE id=ANY($1::varchar[]) AND proposal_type='skill_import_approve' AND payload_json->>'skill_package_id' IS NOT NULL ORDER BY space_id,id",[ids])).rows;
  for(const pkg of packages)await lockSkillReviewProposals(db,pkg.space_id,[pkg.id]);
  for(const spaceId of [...new Set(refs.map(row=>row.space_id))].sort())await lockProposalDependencies(db,spaceId,refs.filter(row=>row.space_id===spaceId).map(row=>row.id));
  const verifyClosure=async()=>{if(canonical(identities(await discover()))!==canonical(identities(refs)))throw conflict();};
  await verifyClosure();
  if(ids.length)await db.query(`SELECT id FROM proposals WHERE id=ANY($1::varchar[]) ORDER BY id FOR UPDATE${nowaitRows?' NOWAIT':''}`,[ids]);
  if(candidates.length)await db.query(`SELECT id FROM operation_idempotency WHERE id=ANY($1::varchar[]) ORDER BY id FOR UPDATE${nowaitRows?' NOWAIT':''}`,[candidates.map(row=>row.id)]);
  const verifyLinks=async()=>{
    const current=await links();
    if(canonical(current.map(row=>[row.id,scope(row),row.proposal_id]))!==canonical(candidates.map(row=>[row.id,scope(row),row.proposal_id])))throw conflict();
    return current;
  };
  await verifyClosure();await verifyLinks();
  return {
    hasAnyLinked:candidates.length>0,
    hasLinked:(id:string)=>candidates.some(row=>row.proposal_id===id),
    assertCovered(idsToWrite:readonly string[]){if(idsToWrite.some(id=>!ids.includes(id)))throw conflict();},
    async finish(){
      // Owners may create fresh unlinked drafts; only the pre-resolved links may change.
      const current=await verifyLinks();
      for(const row of current){
        const proposal=(await db.query<{status:string;expired:boolean;live_staged:boolean}>(`SELECT status,(expires_at IS NOT NULL AND expires_at<=now()) AS expired,
          (status='staged' AND EXISTS(SELECT 1 FROM runs creator WHERE creator.id=proposals.created_by_run_id AND creator.space_id=proposals.space_id AND creator.status NOT IN ('succeeded','degraded','failed','cancelled','orphaned'))) AS live_staged
          FROM proposals WHERE id=$1 AND space_id=$2`,[row.proposal_id,row.space_id])).rows[0];
        if(!proposal)throw inconsistent();
        if(proposal.status==='accepted'){
          if(row.state!=='succeeded'||!row.result_json||!('data' in row.result_json)||row.http_status===null||row.http_status<200||row.http_status>=300)throw inconsistent();
        }else if(row.state==='pending_approval'){
          const state=proposal.status==='rejected'?'rejected':proposal.status==='superseded'?'superseded':proposal.status==='pending'&&proposal.expired?'expired':null;
          if(state)await db.query("UPDATE operation_idempotency SET state=$2,terminal_at=now() WHERE id=$1 AND state='pending_approval'",[row.id,state]);
          // Another admitted Research Run may still be active: its staged
          // output remains unpublished and its request remains pending. A
          // terminal Run retaining staged output is still inconsistent.
          else if(proposal.status!=='pending'&&!proposal.live_staged)throw inconsistent();
        }
      }
    },
  };
}
/** Purpose-bound transition port. Caller owns BEGIN/COMMIT; no pool escape. */
export async function lockProposalTransitions(db:Queryable,spaceId:string,roots:readonly string[],includeDependents=false,requireUnlinked=false){
  const prepared=proposalOwner(db);
  if(prepared){
    prepared.assertCovered(roots);
    const fresh=roots.filter(id=>prepared.freshProposals?.has(id));
    if(fresh.length && (await db.query('SELECT id FROM operation_idempotency WHERE space_id=$1 AND proposal_id=ANY($2::varchar[])',[spaceId,fresh])).rows.length)throw conflict();
    return {hasAnyLinked:prepared.hasAnyLinked,hasLinked:prepared.hasLinked,assertCovered:prepared.assertCovered,finish:async()=>{}};
  }
  const rootIds=[...new Set(roots)].sort();
  const discover=async()=> (await db.query<ProposalRef>(includeDependents
    ? `WITH RECURSIVE affected AS (
        SELECT id FROM proposals WHERE space_id=$1 AND id=ANY($2::varchar[])
        UNION
        SELECT p.id FROM affected a JOIN proposals parent ON parent.id=a.id AND parent.space_id=$1
          JOIN proposals p ON p.space_id=$1 AND (
            p.payload_json->>'depends_on_proposal_id'=a.id OR
            (parent.proposal_type='skill_import_approve' AND p.proposal_type='skill_import_approve'
              AND p.status='pending' AND p.payload_json->>'skill_package_id'=parent.payload_json->>'skill_package_id'))
      ) SELECT id,$1::varchar AS space_id FROM affected ORDER BY id`
    : 'SELECT id,space_id FROM proposals WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id',[spaceId,rootIds])).rows;
  return admitTransitions(db,discover,undefined,requireUnlinked);
}
/** Attachment excludes all lifecycle admissions. Never waits behind a domain owner. */
export async function lockRunProposalAttachment(db:Queryable,spaceId:string,runId:string):Promise<void>{
  await assertProposalTransaction(db);
  const result=await db.query<{locked:boolean}>('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked',[`proposal-run:${spaceId}:${runId}`]);
  if(!result.rows[0]?.locked)throw new OperationError('idempotency_in_progress',409,true);
}
/** Recovery can span Spaces: admit every request key globally before any Run/Proposal row. */
export async function lockRunProposalTransitions(db:Queryable,runs:readonly RunRef[],requireUnlinked=false,nowaitRows=false){
  const ordered=[...runs].sort((a,b)=>a.space_id.localeCompare(b.space_id)||a.id.localeCompare(b.id));
  const discover=async()=>{
    if(!ordered.length)return [];
    return (await db.query<ProposalRef>(`SELECT p.id,p.space_id FROM proposals p
      JOIN unnest($1::varchar[],$2::varchar[]) AS r(space_id,id) ON r.space_id=p.space_id AND r.id=p.created_by_run_id
      ORDER BY p.id`,[ordered.map(row=>row.space_id),ordered.map(row=>row.id)])).rows;
  };
  await assertProposalTransaction(db);
  const refs=await discover();
  const linked=refs.length?(await db.query('SELECT id FROM operation_idempotency WHERE proposal_id=ANY($1::varchar[])',[refs.map(row=>row.id)])).rows:[];
  if(!linked.length){
    // Unlinked terminals do not mutate request state: they may share admission
    // and serialize on the existing Run row. Attachment's exclusive try fence
    // excludes new links until every admitted terminal has committed/rolled back.
    for(const run of ordered){
      const gate=await db.query<{locked:boolean}>('SELECT pg_try_advisory_xact_lock_shared(hashtextextended($1,0)) AS locked',[`proposal-run:${run.space_id}:${run.id}`]);
      if(!gate.rows[0]?.locked)throw new OperationError('idempotency_in_progress',409,true);
    }
    const current=await discover();
    if(current.length && (await db.query('SELECT id FROM operation_idempotency WHERE proposal_id=ANY($1::varchar[])',[current.map(row=>row.id)])).rows.length)throw conflict();
    return {hasAnyLinked:false,hasLinked:(_id:string)=>false,assertCovered:(_ids:readonly string[])=>{},finish:async()=>{}};
  }
  return admitTransitions(db,discover,async()=>{
    for(const run of ordered){
      const gate=await db.query<{locked:boolean}>('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked',[`proposal-run:${run.space_id}:${run.id}`]);
      if(!gate.rows[0]?.locked)throw new OperationError('idempotency_in_progress',409,true);
    }
  },requireUnlinked,nowaitRows);
}

/** A prepared owner port is bound to this transaction object and exact Run set.
 * It cannot be asserted by a caller-supplied readiness flag or reused after close.
 */
interface RunTerminalOwnerScope {
 assertRun(spaceId:string,runId:string):void;
}
interface InternalRunOwnerScope extends RunTerminalOwnerScope {
 createdRun?(spaceId:string,runId:string):void;
 fresh?:Set<string>;
}
type ProposalTransitions=Awaited<ReturnType<typeof admitTransitions>>;
const proposalDecisionOwners=new WeakMap<Queryable,ProposalTransitions&{freshProposals?:Set<string>;bundle?:boolean}>();
export function hasPreparedProposalDecisionOwner(db:Queryable){return !!proposalOwner(db);}
export function recordPreparedProposalCreation(db:Queryable,id:string){proposalOwner(db)?.freshProposals?.add(id);}
export function recordPreparedRunCreation(db:Queryable,spaceId:string,runId:string){runOwner(db)?.createdRun?.(spaceId,runId);}
export async function assertPreparedFreshRunUnlinked(db:Queryable,spaceId:string,runId:string){
 if(!runOwner(db)?.fresh?.has(canonical([spaceId,runId])))return;
 if((await db.query('SELECT r.id FROM operation_idempotency r JOIN proposals p ON p.id=r.proposal_id AND p.space_id=r.space_id WHERE p.space_id=$1 AND p.created_by_run_id=$2',[spaceId,runId])).rows.length)throw conflict();
}
const runTerminalOwners=new WeakMap<Queryable,InternalRunOwnerScope>();
function runOwner(db:Queryable):InternalRunOwnerScope|undefined{
 const own=runTerminalOwners.get(db);return own??(isOperationTransaction(db)?runOwner(operationTransactionHost(db)):undefined);
}
function proposalOwner(db:Queryable):ReturnType<typeof proposalDecisionOwners.get>{
 const own=proposalDecisionOwners.get(db);return own??(isOperationTransaction(db)?proposalOwner(operationTransactionHost(db)):undefined);
}
export function preparedRunTerminalOwner(db:Queryable,spaceId:string,runId:string):RunTerminalOwnerScope|null{
 const owner=runOwner(db);
 if(!owner)return null;
 owner.assertRun(spaceId,runId);
 return {assertRun:(space,id)=>owner.assertRun(space,id)};
}
/** Root owner admits its whole set before work. Unprepared composed clients retain
 * the existing linked refusal; only their real outer owner may prepare keys.
 */
export async function withRunTerminalOwner<T>(
 db:Queryable,
 discover:(db:Queryable)=>Promise<readonly RunRef[]>,
 work:(db:Queryable)=>Promise<T>,
 options:{nonWaiting?:boolean}={},
):Promise<T>{
 const existing=runOwner(db);
 if(existing){for(const run of await discover(db))existing.assertRun(run.space_id,run.id);return work(db);}
 const host=db as Queryable&{connect?:unknown;release?:unknown};
 if(isOperationTransaction(db)||typeof host.connect!=='function'||typeof host.release==='function'){await assertProposalTransaction(db);return work(db);}
 const databaseUrl=(db as Queryable&{options?:{connectionString?:string}}).options?.connectionString;
 if(!databaseUrl)throw inconsistent();
 return withPolicyAuditRecovery(databaseUrl,()=>withQueryableTransaction(db,async tx=>{
  const runs=await discover(tx);
  const admitted=new Set(runs.map(run=>canonical([run.space_id,run.id])));
  const transitions=await lockRunProposalTransitions(tx,runs,false,options.nonWaiting);
  if(options.nonWaiting && runs.length)await tx.query('SELECT id FROM runs WHERE id=ANY($1::varchar[]) ORDER BY id FOR UPDATE NOWAIT',[runs.map(run=>run.id)]);
  const port=operationTransaction(tx);
  let active=true;const fresh=new Set<string>();
  runTerminalOwners.set(port.db,{fresh,createdRun(spaceId,runId){const key=canonical([spaceId,runId]);fresh.add(key);admitted.add(key);},assertRun(spaceId,runId){
   if(!active)throw inconsistent();
   if(!admitted.has(canonical([spaceId,runId])))throw conflict();
  }});
  try{
   for(const run of await discover(port.db))runTerminalOwners.get(port.db)!.assertRun(run.space_id,run.id);
   const result=await work(port.db);
   await transitions.finish();
   return result;
  }finally{active=false;runTerminalOwners.delete(port.db);port.close();}
 }));
}

/** Canonical decision owner: combined checkpoint/cascade and Run request closure.
 * Called immediately after BEGIN, never by an applier already holding rows. */
export function withCheckpointDecisionOwner<T>(db:Queryable,spaceId:string,roots:readonly string[],work:()=>Promise<T>,userId:string){return withProposalSetOwner(db,spaceId,roots,work,userId,'checkpoint');}
/** Evolution's complete decision set is admitted before its bundle gate/rows. */
export function withBundleDecisionOwner<T>(db:Queryable,spaceId:string,roots:readonly string[],work:()=>Promise<T>,userId:string){return withProposalSetOwner(db,spaceId,roots,work,userId,'bundle');}
async function withProposalSetOwner<T>(db:Queryable,spaceId:string,roots:readonly string[],work:()=>Promise<T>,userId:string,purpose:'checkpoint'|'bundle'):Promise<T>{
 await assertProposalTransaction(db);
 const existing=proposalOwner(db);
 if(existing){existing.assertCovered(roots);return work();}
 const history=(await db.query<{project_id:string|null}>(`SELECT COALESCE(project_id,payload_json->>'project_id') AS project_id FROM proposals WHERE space_id=$1 AND id=ANY($2::varchar[]) AND proposal_type='research_history_extend'`,[spaceId,[...roots]])).rows;
 for(const proposal of history)if(proposal.project_id)await assertProjectWriter(db,spaceId,proposal.project_id,userId);
 const runRefs=async()=> (await db.query<RunRef>(`SELECT DISTINCT r.id,r.space_id FROM proposals p
 JOIN runs r ON r.space_id=p.space_id AND r.id IN (
   SELECT root_run_id FROM plans WHERE space_id=p.space_id AND id=p.payload_json->>'plan_id' AND p.proposal_type='plan_checkpoint' AND EXISTS(SELECT 1 FROM plan_nodes n WHERE n.id=p.payload_json->>'node_id' AND n.plan_version_id=p.payload_json->>'plan_version_id' AND n.space_id=p.space_id AND n.approval_proposal_id=p.id)
   UNION SELECT root_run_id FROM workflow_executions WHERE space_id=p.space_id AND id=p.payload_json->>'workflow_execution_id' AND p.proposal_type='workflow_execution_checkpoint' AND EXISTS(SELECT 1 FROM workflow_execution_nodes n WHERE n.id=p.payload_json->>'node_id' AND n.execution_id=p.payload_json->>'workflow_execution_id' AND n.space_id=p.space_id AND n.approval_proposal_id=p.id)
   UNION SELECT e.root_run_id FROM workflow_executions e JOIN project_operations o ON o.id=e.research_operation_id AND o.space_id=e.space_id WHERE e.space_id=p.space_id AND o.project_id=COALESCE(p.project_id,p.payload_json->>'project_id') AND p.proposal_type='research_history_extend' AND EXISTS(SELECT 1 FROM runs candidate WHERE candidate.id=e.root_run_id AND candidate.space_id=e.space_id AND (candidate.status NOT IN ('succeeded','degraded','failed','cancelled','orphaned') OR EXISTS(SELECT 1 FROM proposals output WHERE output.created_by_run_id=candidate.id AND output.space_id=candidate.space_id AND output.status='staged')))
   UNION SELECT related.root_run_id FROM workflow_executions anchor
    JOIN project_operations owner ON owner.id=anchor.research_operation_id AND owner.space_id=anchor.space_id
    JOIN project_operations other ON other.space_id=owner.space_id AND other.project_id=owner.project_id
    JOIN workflow_executions related ON related.research_operation_id=other.id AND related.space_id=other.space_id
    WHERE EXISTS(SELECT 1 FROM runs candidate WHERE candidate.id=related.root_run_id AND candidate.space_id=related.space_id AND (candidate.status NOT IN ('succeeded','degraded','failed','cancelled','orphaned') OR EXISTS(SELECT 1 FROM proposals output WHERE output.created_by_run_id=candidate.id AND output.space_id=candidate.space_id AND output.status='staged'))) AND anchor.space_id=p.space_id AND anchor.id=p.payload_json->>'workflow_execution_id' AND p.proposal_type='workflow_execution_checkpoint' AND EXISTS(SELECT 1 FROM workflow_execution_nodes n WHERE n.id=p.payload_json->>'node_id' AND n.execution_id=anchor.id AND n.space_id=p.space_id AND n.approval_proposal_id=p.id))
 WHERE p.space_id=$1 AND p.id=ANY($2::varchar[]) ORDER BY r.id`,[spaceId,[...roots]])).rows;
 const runs=await runRefs();
 if(!runs.length && purpose==='checkpoint' && !(await db.query("SELECT id FROM proposals WHERE space_id=$1 AND id=ANY($2::varchar[]) AND proposal_type IN ('plan_checkpoint','workflow_execution_checkpoint','research_history_extend')",[spaceId,[...roots]])).rows.length)return work();
 const discover=async()=> (await db.query<ProposalRef>(`WITH RECURSIVE affected AS (
   SELECT id FROM proposals WHERE space_id=$1 AND (id=ANY($2::varchar[]) OR (created_by_run_id=ANY($3::varchar[]) AND status IN ('pending','staged')))
   UNION SELECT p.id FROM affected a JOIN proposals parent ON parent.id=a.id AND parent.space_id=$1
   JOIN proposals p ON p.space_id=$1 AND (p.payload_json->>'depends_on_proposal_id'=a.id OR
    (parent.proposal_type='skill_import_approve' AND p.proposal_type='skill_import_approve' AND p.status='pending'
      AND p.payload_json->>'skill_package_id'=parent.payload_json->>'skill_package_id'))
 ) SELECT id,$1::varchar AS space_id FROM affected ORDER BY id`,[spaceId,[...roots],runs.map(r=>r.id)])).rows;
 const transitions=await admitTransitions(db,discover,async()=>{
  for(const run of runs){
   const gate=await db.query<{locked:boolean}>('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked',[`proposal-run:${run.space_id}:${run.id}`]);
   if(!gate.rows[0]?.locked)throw new OperationError('idempotency_in_progress',409,true);
  }
  if(canonical(await runRefs())!==canonical(runs))throw conflict();
 });
 const admitted=new Set(runs.map(r=>canonical([r.space_id,r.id]))),fresh=new Set<string>();
 const previousRuns=runOwner(db),previousProposals=proposalOwner(db);
 runTerminalOwners.set(db,{fresh,createdRun(space,id){const key=canonical([space,id]);admitted.add(key);fresh.add(key);},assertRun(space,id){if(!admitted.has(canonical([space,id])))throw conflict();}});
 const freshProposals=new Set<string>();
 proposalDecisionOwners.set(db,{...transitions,bundle:purpose==='bundle',freshProposals,assertCovered(ids){transitions.assertCovered(ids.filter(id=>!freshProposals.has(id)));}});
 try{const result=await work();await transitions.finish();return result;}
 finally{if(previousRuns)runTerminalOwners.set(db,previousRuns);else runTerminalOwners.delete(db);
  if(previousProposals)proposalDecisionOwners.set(db,previousProposals);else proposalDecisionOwners.delete(db);}
}

/** Research aggregate snapshot before its Project/operation/graph locks. */
export async function researchGraphRunRefs(db:Queryable,spaceId:string,projectId:string){
 return (await db.query<RunRef>(`SELECT DISTINCT e.root_run_id AS id,e.space_id FROM workflow_executions e
 JOIN project_operations o ON o.id=e.research_operation_id AND o.space_id=e.space_id
 JOIN runs r ON r.id=e.root_run_id AND r.space_id=e.space_id
 WHERE (r.status NOT IN ('succeeded','degraded','failed','cancelled','orphaned') OR EXISTS(SELECT 1 FROM proposals staged WHERE staged.space_id=r.space_id AND staged.created_by_run_id=r.id AND staged.status='staged')) AND e.space_id=$1 AND o.project_id=$2 AND e.root_run_id IS NOT NULL ORDER BY e.root_run_id`,[spaceId,projectId])).rows;
}
