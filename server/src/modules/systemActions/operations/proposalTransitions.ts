import {planCheckpointRootRunIds} from '../../plans/checkpointRuns.js';
import {workflowCheckpointRootRunIds} from '../../automations/checkpointRuns.js';
import {researchDecisionRunIds,researchHistoryProjectIds} from '../../projectResearch/graphRuns.js';
import {pendingSkillImportSiblings,skillImportPackages} from '../../skills/importReviewProposals.js';
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
async function admitTransitions(db:Queryable,discover:()=>Promise<ProposalRef[]>,gate?:()=>Promise<void>,requireUnlinked=false,nowaitRows=false,requestKeys:readonly string[][]=[]){
  await assertProposalTransaction(db);
  const refs=await discover(),ids=refs.map(row=>row.id);
  const links=async()=> (await db.query<Linked>(`SELECT r.* FROM operation_idempotency r JOIN proposals p ON p.id=r.proposal_id AND p.space_id=r.space_id
    WHERE p.id=ANY($1::varchar[]) ORDER BY r.id`,[ids])).rows;
  const candidates=await links();
  if(requireUnlinked && candidates.length)throw new OperationError('operation_approval_mapping_unavailable',503);
  const ordered=[...candidates.map(scope),...requestKeys].sort((a,b)=>canonical(a)<canonical(b)?-1:canonical(a)>canonical(b)?1:0);
  for(const key of ordered)await lockRequestKey(db,key);
  // No domain/Proposal row lock may precede the complete sorted key set.
  await gate?.();
  for(const pkg of await skillImportPackages(db,ids))await lockSkillReviewProposals(db,pkg.space_id,[pkg.id]);
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
/**
 * A decision's Proposal closure, sorted: the roots, the open output of the
 * admitted Runs, and transitively every Proposal that depends on one, plus the
 * pending reviews of the same Skill package (the Skills owner's rule).
 */
async function proposalClosure(db:Queryable,spaceId:string,roots:readonly string[],runIds:readonly string[]):Promise<ProposalRef[]>{
 const seen=new Set((await db.query<{id:string}>(`SELECT id FROM proposals WHERE space_id=$1 AND (id=ANY($2::varchar[]) OR (created_by_run_id=ANY($3::varchar[]) AND status IN ('pending','staged')))`,[spaceId,[...roots],[...runIds]])).rows.map(r=>r.id));
 let frontier=[...seen];
 while(frontier.length){
  const dependents=(await db.query<{id:string}>(`SELECT id FROM proposals WHERE space_id=$1 AND payload_json->>'depends_on_proposal_id'=ANY($2::varchar[])`,[spaceId,frontier])).rows.map(r=>r.id);
  frontier=[...new Set([...dependents,...await pendingSkillImportSiblings(db,spaceId,frontier)])].filter(id=>!seen.has(id));
  for(const id of frontier)seen.add(id);
 }
 return [...seen].sort().map(id=>({id,space_id:spaceId}));
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
  const discover=async()=>includeDependents
    ? proposalClosure(db,spaceId,rootIds,[])
    : (await db.query<ProposalRef>('SELECT id,space_id FROM proposals WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id',[spaceId,rootIds])).rows;
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
/** Core-host lifecycle for a new command. The raw owner client must match the
 * branded domain port; passing a child port in its place cannot prepare an owner.
 * Reuses the canonical Run transition admission and exact-set membership. */
export async function prepareOperationRunTerminalOwner(
 host:Queryable,db:Queryable,spaceId:string,
 discover:(db:Queryable)=>Promise<readonly RunRef[]>,
):Promise<{finish():Promise<void>;close():void}>{
 if(!isOperationTransaction(db)||operationTransactionHost(db)!==host||runOwner(db))throw inconsistent();
 const runs=await discover(db);
 if(runs.some(run=>run.space_id!==spaceId||!run.id))throw inconsistent();
 const admitted=new Set(runs.map(run=>canonical([run.space_id,run.id]))),fresh=new Set<string>();
 const transitions=await lockRunProposalTransitions(db,runs);
 let active=true;
 const scope:InternalRunOwnerScope={fresh,createdRun(space,id){
  if(!active||space!==spaceId)throw inconsistent();
  const key=canonical([space,id]);fresh.add(key);admitted.add(key);
 },assertRun(space,id){
  if(!active)throw inconsistent();
  if(!admitted.has(canonical([space,id])))throw conflict();
 }};
 runTerminalOwners.set(db,scope);
 const close=()=>{active=false;runTerminalOwners.delete(db);};
 try{for(const run of await discover(db))scope.assertRun(run.space_id,run.id);}
 catch(error){close();throw error;}
 return {async finish(){
  if(!active)throw inconsistent();
  for(const run of await discover(db))scope.assertRun(run.space_id,run.id);
  await transitions.finish();
 },close};
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
/** The formal core owner admits its own key together with every dependent
 * request before membership, Proposal or domain row locks. */
export function withOperationProposalDecisionOwner<T>(db:Queryable,spaceId:string,roots:readonly string[],requestKey:string[],work:()=>Promise<T>,userId:string,bundle=false,prepare?:(roots:readonly string[])=>Promise<void>){
 return withProposalSetOwner(db,spaceId,roots,work,userId,bundle?'bundle':'checkpoint',[requestKey],prepare);
}
async function withProposalSetOwner<T>(db:Queryable,spaceId:string,roots:readonly string[],work:()=>Promise<T>,userId:string,purpose:'checkpoint'|'bundle',requestKeys:readonly string[][]=[],prepare?:(roots:readonly string[])=>Promise<void>):Promise<T>{
 await assertProposalTransaction(db);
 const existing=proposalOwner(db);
 if(existing){existing.assertCovered(roots);return work();}
 for(const projectId of await researchHistoryProjectIds(db,spaceId,roots))await assertProjectWriter(db,spaceId,projectId,userId);
 // Domain owners name the Runs a decision touches; this owner sorts, try-locks and rechecks the exact set.
 const runRefs=async()=>{
  const ids=[...new Set([...await planCheckpointRootRunIds(db,spaceId,roots),...await workflowCheckpointRootRunIds(db,spaceId,roots),...await researchDecisionRunIds(db,spaceId,roots)])];
  return ids.length?(await db.query<RunRef>('SELECT id,space_id FROM runs WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id',[spaceId,ids])).rows:[];
 };
 const runs=await runRefs();
 if(!requestKeys.length && !runs.length && purpose==='checkpoint' && !(await db.query("SELECT id FROM proposals WHERE space_id=$1 AND id=ANY($2::varchar[]) AND proposal_type IN ('plan_checkpoint','workflow_execution_checkpoint','research_history_extend')",[spaceId,[...roots]])).rows.length)return work();
 const discover=()=>proposalClosure(db,spaceId,[...roots],runs.map(r=>r.id));
 const transitions=await admitTransitions(db,discover,async()=>{
  for(const run of runs){
   const gate=await db.query<{locked:boolean}>('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked',[`proposal-run:${run.space_id}:${run.id}`]);
   if(!gate.rows[0]?.locked)throw new OperationError('idempotency_in_progress',409,true);
  }
  if(canonical(await runRefs())!==canonical(runs))throw conflict();
  await prepare?.(roots);
 },false,false,requestKeys);
 const admitted=new Set(runs.map(r=>canonical([r.space_id,r.id]))),fresh=new Set<string>();
 const previousRuns=runOwner(db),previousProposals=proposalOwner(db);
 runTerminalOwners.set(db,{fresh,createdRun(space,id){const key=canonical([space,id]);admitted.add(key);fresh.add(key);},assertRun(space,id){if(!admitted.has(canonical([space,id])))throw conflict();}});
 const freshProposals=new Set<string>();
 proposalDecisionOwners.set(db,{...transitions,bundle:purpose==='bundle',freshProposals,assertCovered(ids){transitions.assertCovered(ids.filter(id=>!freshProposals.has(id)));}});
 try{
  const result=await work();
  // Typed writers may add freshly registered drafts/Runs, but a concurrent or
  // mutated dependency may not extend the pre-admitted key/Run closure.
  transitions.assertCovered((await discover()).map(row=>row.id).filter(id=>!freshProposals.has(id)));
  for(const run of await runRefs())if(!admitted.has(canonical([run.space_id,run.id])))throw conflict();
  await transitions.finish();return result;
 }
 finally{if(previousRuns)runTerminalOwners.set(db,previousRuns);else runTerminalOwners.delete(db);
  if(previousProposals)proposalDecisionOwners.set(db,previousProposals);else proposalDecisionOwners.delete(db);}
}
