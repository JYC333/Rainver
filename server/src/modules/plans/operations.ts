import type {OperationActor,OperationInput,RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import {type Queryable} from '../routeUtils/common.js';
import {contentReadSql} from '../access/contentAccessSql.js';
import {isSpaceOwnerOrAdmin} from '../access/roles.js';
import {assertProjectWriter,assertProjectWriterForMutation,lockActiveProjectForMutation,ProjectArchivedMutationError} from '../projects/access.js';
import {RunBudgetExceededError,RunBudgetSourceReferenceError} from '../runs/budgetEnforcement.js';
import {RunCreateValidationError} from '../runs/runRepositoryTypes.js';
import {OperationError,hidden,markedRefusal} from '../systemActions/operations/errors.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {PlanControlError} from './controlErrors.js';
import {PgPlanRepository} from './repository.js';

type Id='plan.execute'|'plan.reconcile';
const person=(a:OperationActor)=>({spaceId:a.space_id,userId:a.on_behalf_of_user_id!});
/** A Plan is reachable only through its readable source Task. */
async function readablePlan(db:Queryable,a:OperationActor,planId:string){
  const row=(await db.query<{id:string;project_id:string|null;root_run_id:string|null}>(`SELECT p.id,p.project_id,p.root_run_id FROM plans p
    JOIN tasks t ON t.id=p.source_task_id AND t.space_id=p.space_id AND t.deleted_at IS NULL
    WHERE p.space_id=$1 AND p.id=$2 AND ${contentReadSql('task','t','$3')}`,[a.space_id,planId,a.on_behalf_of_user_id])).rows[0];
  if(!row)throw hidden();
  return row;
}
async function projectGate(db:Queryable,a:OperationActor,projectId:string){
  const p=person(a);
  await assertProjectWriter(db,p.spaceId,projectId,p.userId,{allowArchived:true});
  try{await lockActiveProjectForMutation(db,p.spaceId,projectId);}
  catch(e){if(e instanceof ProjectArchivedMutationError)throw new OperationError('operation_conflict',409,false,'plans');throw e;}
  await assertProjectWriterForMutation(db,p.spaceId,projectId,p.userId);
}
function classify(e:unknown){
  if(e instanceof PlanControlError||e instanceof ProjectArchivedMutationError||e instanceof RunCreateValidationError||e instanceof RunBudgetExceededError||e instanceof RunBudgetSourceReferenceError)
    return markedRefusal(e as Error&{statusCode:number},'plans');
  return undefined;
}

/** Plan execution/reconciliation commands over the Plan owner's domain functions.
 * Neither decides a Proposal: plan_review/plan_checkpoint decisions stay with the
 * canonical applier, which calls the same reconcile function inside its own locks. */
export function planOperationRegistrations(config:ServerConfig,definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration[]{
  const scope=(id:string)=>({authority:`plan:${id}`,targets:{plan_id:id},resourceType:'plan',resourceId:id});
  return [{
    definition:definitions.get('plan.execute' satisfies Id)!,
    successStatus:202,
    async resolve(db,raw,a){const id=(raw as OperationInput<'plan.execute'>).plan_id;await readablePlan(db,a,id);return scope(id);},
    async authorize(db,raw,a){
      // Project → source Task → Plan are locked again by the domain in that order.
      const plan=await readablePlan(db,a,(raw as OperationInput<'plan.execute'>).plan_id);
      if(plan.project_id)await projectGate(db,a,plan.project_id);
    },
    async authorizeResult(db,raw,a){await readablePlan(db,a,(raw as {plan_id:string}).plan_id);},
    async execute(db,raw,a){
      const {plan_id,agent_id,runtime_profile_id,prompt,instruction,workflow_input_json}=raw as OperationInput<'plan.execute'>;
      const out=await new PgPlanRepository(db,config).executePlan(person(a),plan_id,{agentId:agent_id??null,runtimeProfileId:runtime_profile_id??null,prompt:prompt??null,instruction:instruction??null,workflowInputJson:workflow_input_json??null},db) as {plan_id:string;root_run_id:string;scheduled_node_ids:string[];idempotent?:boolean;root_status?:string};
      return {plan_id:out.plan_id,root_run_id:out.root_run_id,scheduled_node_ids:out.scheduled_node_ids,idempotent:out.idempotent===true,root_status:out.root_status??null};
    },
    classifyError:classify,
  },{
    definition:definitions.get('plan.reconcile' satisfies Id)!,
    // The root coordinator may end here: its terminal transition is admitted before domain locks.
    runTerminalOwner:{async discover(db,raw,a){
      const plan=await readablePlan(db,a,(raw as OperationInput<'plan.reconcile'>).plan_id);
      return plan.root_run_id?[{space_id:a.space_id,id:plan.root_run_id}]:[];
    }},
    async resolve(db,raw,a){const id=(raw as OperationInput<'plan.reconcile'>).plan_id;await readablePlan(db,a,id);return scope(id);},
    async authorize(db,raw,a){
      const role=(await db.query<{role:string}>("SELECT role FROM space_memberships WHERE space_id=$1 AND user_id=$2 AND status='active' FOR SHARE",[a.space_id,a.on_behalf_of_user_id])).rows[0]?.role;
      // The retained REST contract: a Space owner/admin who can read the source Task
      // (owner/admin already satisfies canWriteProject). Reconciling is the same
      // domain function recovery runs, so it adds no active-Project gate of its own.
      if(!isSpaceOwnerOrAdmin(role))throw hidden();
      await readablePlan(db,a,(raw as OperationInput<'plan.reconcile'>).plan_id);
    },
    async authorizeResult(db,raw,a){await readablePlan(db,a,(raw as {plan_id:string}).plan_id);},
    async execute(db,raw,a){
      const id=(raw as OperationInput<'plan.reconcile'>).plan_id;
      const out=await new PgPlanRepository(db,config).reconcilePlan(person(a),id) as {plan_id:string;status:string;scheduled_node_ids:string[]};
      return {plan_id:out.plan_id,status:out.status,scheduled_node_ids:out.scheduled_node_ids};
    },
    classifyError:classify,
  }];
}
