import {ZodError} from 'zod';
import {SOURCE_GOAL_OPERATION_IDS,SOURCE_RETRIEVAL_JOB,type OperationActor,type OperationInput,type RegisteredSystemActionDefinition,type SourceGoalOperationId} from '@rainver/protocol';
import type {ServerConfig} from '../../../config.js';
import {getDbPool} from '../../../db/pool.js';
import {HttpError,type Pool,type Queryable,type SpaceUserIdentity} from '../../routeUtils/common.js';
import type {OperationRegistration,ResolvedOperation} from '../../systemActions/operations/types.js';
import {OperationRefusal,hidden} from '../../systemActions/operations/errors.js';
import {assertProjectWriterForMutation,canWriteProject} from '../../projects/access.js';
import {contentDecisionFromDb} from '../../access/contentAccessQuery.js';
import {PgJobQueueRepository} from '../../jobs/repository.js';
import {RunBudgetExceededError} from '../../runs/budgetEnforcement.js';
import {assertGoalAnalysisManagement,requireGoal} from './access.js';
import {SourceGoalService,type GoalExecutionPort} from './service.js';
import {SourceGoalExecutor} from './execution.js';
import {SourceGoalConversation} from './conversation.js';
import {SourceGoalRepairService} from './repair.js';
import {editSourceGoal} from './edit.js';
import {requestGoalCheck} from './collectionQueue.js';
import {queueSourceGoalAgent} from './agent.js';
import {confirmBindingSource} from './reconfirm.js';
import {mapLegacyGoal,rollbackGoalCompatibility} from './compatibility.js';
import {stopCancellingGoalRuns} from './activation.js';
import {lockGoal} from './transaction.js';

const person=(a:OperationActor):SpaceUserIdentity=>({spaceId:a.space_id,userId:a.on_behalf_of_user_id!});
const CREATION=new Set<SourceGoalOperationId>(['source.goal.setup.begin','source.goal.create']);
const THEME=new Set<SourceGoalOperationId>(['source.goal.theme.configure','source.goal.theme.retry','source.goal.theme.cancel']);
/** Fields the URL (or a domain-specific key) names; the owning service never receives them as body. */
const TARGETS=['goal_id','binding_id','repair_id','round_id'] as const;
type Raw=Record<string,unknown>;
const body=(raw:unknown)=>Object.fromEntries(Object.entries(raw as Raw).filter(([k])=>!(TARGETS as readonly string[]).includes(k)));
const targets=(raw:unknown)=>Object.fromEntries(Object.entries(raw as Raw).filter(([k])=>(TARGETS as readonly string[]).includes(k)));

/**
 * Goal lock order shared with the domain writers, the collection commit and
 * briefing/reading Deliveries (`lockGoal`): the Goal's Project row, then the
 * goal row, then the Project writer's membership (FOR SHARE). Legacy,
 * compatibility and activation paths take the Project row FOR UPDATE inside the
 * domain, so it is taken that way here first.
 */
async function lockManagedGoal(db:Queryable,a:OperationActor,goalId:string,deletion=false){
  await lockGoal(db,goalId,'update',a.space_id);
  const row=(await db.query<{project_id:string|null;status:string}>('SELECT project_id,status FROM source_goals WHERE id=$1 AND space_id=$2',[goalId,a.space_id])).rows[0];
  if(!row)throw hidden();
  // A deleted goal admits only the replay of its own deletion (a new key is then refused by the owner).
  if(deletion&&row.status==='deleted')return assertGoalManager(db,a,goalId);
  if(row.project_id)await assertProjectWriterForMutation(db,a.space_id,row.project_id,a.on_behalf_of_user_id!);
  return requireGoal(db,person(a),goalId,true);
}

/** A receipt is released only to the goal's current manager (a deleted goal's receipt included). */
async function assertGoalManager(db:Queryable,a:OperationActor,goalId:string){
  const g=(await db.query<{owner_user_id:string;project_id:string|null}>('SELECT owner_user_id,project_id FROM source_goals WHERE id=$1 AND space_id=$2',[goalId,a.space_id])).rows[0];
  if(!g||g.owner_user_id!==a.on_behalf_of_user_id||g.project_id&&!await canWriteProject(db,a.space_id,g.project_id,a.on_behalf_of_user_id!))throw hidden();
}

/** The Monitor a legacy mapping names: owned, managed and fully readable by the caller. */
async function assertLegacySource(db:Queryable,a:OperationActor,channelId:string){
  const c=(await db.query<{id:string;owner_user_id:string}>('SELECT sc.id,sc.owner_user_id FROM source_connections sc JOIN source_channels ch ON ch.source_connection_id=sc.id AND ch.space_id=sc.space_id WHERE ch.id=$1 AND sc.space_id=$2 AND sc.deleted_at IS NULL',[channelId,a.space_id])).rows[0];
  if(!c||c.owner_user_id!==a.on_behalf_of_user_id||await contentDecisionFromDb(db,person(a),'source_connection',c.id,{includeOversight:false})!=='full')throw hidden();
}

/** Commands never execute a Source: provider and Agent work is a Job or a queued Run. */
const NO_EXECUTION:GoalExecutionPort={async execute(){throw new Error('Source execution is never part of a goal command transaction');}};
const SOURCE_CODE=/^(?:source|theme)_[a-z_]{1,80}$/;
/**
 * Only explicit, deterministic Goal refusals are cached: the domain's 400/409/422
 * conflicts, its exhausted attempt budgets (429, reported as a conflict with the
 * original status), its named `source_*` refusals and the owned Agent/Profile
 * requirement. Access refusals without a code stay hidden; other errors internal.
 */
export function classifySourceGoalError(error:unknown):OperationRefusal|undefined{
  if(error instanceof RunBudgetExceededError)return new OperationRefusal(409,'sources','source_goal_exploration_budget_exhausted',{code:'source_goal_exploration_budget_exhausted'});
  if(error instanceof ZodError)return new OperationRefusal(422,'sources','Invalid goal request');
  if(error instanceof HttpError){
    const response=error.responseBody as {error?:unknown;code?:unknown}|undefined;
    const code=[response?.error,response?.code,error.message].find((v):v is string=>typeof v==='string'&&SOURCE_CODE.test(v));
    const metadata=code?{code}:{};
    if(error.statusCode===409)return new OperationRefusal(409,'sources',error.message,metadata);
    if(error.statusCode===400||error.statusCode===422)return new OperationRefusal(422,'sources',error.message,metadata);
    if(error.statusCode===429)return new OperationRefusal(409,'sources',error.message,{code:code??'source_goal_budget_exhausted',status:429});
    if(error.statusCode===403&&code)return new OperationRefusal(409,'sources',code,{code,status:403});
    if(error.statusCode===403&&error.message==='Owned enabled Agent/Profile required')return new OperationRefusal(409,'sources',error.message,{code:'source_goal_execution_setup_required',status:403});
    return undefined;
  }
  if(error instanceof Error&&SOURCE_CODE.test(error.message)&&(error as {code?:unknown}).code===undefined)return new OperationRefusal(409,'sources',error.message,{code:error.message});
  return undefined;
}

/**
 * The 21 retained Goal URLs as core commands over the existing owners
 * (SourceGoalService, SourceGoalConversation, compatibility, edit, check,
 * repair, reconfirmation and theme analysis). Each runs in the core
 * transaction: Agent planning is the existing queued Run + `agent_run` Job
 * intent, the preview is a single-attempt Job, collection keeps its worker,
 * and cancellations are intents whose process stop follows the commit.
 */
export function sourceGoalRegistrations(config:ServerConfig,definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration[]{
  const service=(db:Queryable)=>new SourceGoalService(db as unknown as Pool,config,NO_EXECUTION);
  return SOURCE_GOAL_OPERATION_IDS.map(id=>{
    const registration:OperationRegistration={
      definition:definitions.get(id)!,
      ...(CREATION.has(id)?{userContentCreation:true as const,successStatus:201 as const}:{}),
      ...(id==='source.goal.preview.request'?{successStatus:202 as const}:{}),
      async resolve(db,raw,a):Promise<ResolvedOperation>{
        const input=raw as Raw;
        if(CREATION.has(id)){const project=typeof input.project_id==='string'?input.project_id:null;return {authority:`source_goal_creation:${a.space_id}:${project??'personal'}`,targets:{project_id:project},resourceType:'source_goal',resourceId:null};}
        if(id==='source.goal.setup.legacy'){const channel=String(input.channel_id);await assertLegacySource(db,a,channel);return {authority:`source_channel:${channel}`,targets:{channel_id:channel},resourceType:'source_channel',resourceId:channel};}
        const goal=String(input.goal_id);
        if(!(await db.query('SELECT 1 FROM source_goals WHERE id=$1 AND space_id=$2',[goal,a.space_id])).rows.length)throw hidden();
        return {authority:`source_goal:${goal}`,targets:targets(raw),resourceType:'source_goal',resourceId:goal};
      },
      async authorize(db,raw,a){
        const input=raw as Raw;
        if(CREATION.has(id)){if(typeof input.project_id==='string'){
          // The new goal's Goal-writer lock (Project FOR UPDATE) is taken before the writer check share-locks it.
          await db.query('SELECT id FROM projects WHERE id=$1 AND space_id=$2 FOR UPDATE',[input.project_id,a.space_id]);
          await assertProjectWriterForMutation(db,a.space_id,input.project_id,a.on_behalf_of_user_id!);
        }return;}
        if(id==='source.goal.setup.legacy'){await assertLegacySource(db,a,String(input.channel_id));return;}
        await lockManagedGoal(db,a,String(input.goal_id),id==='source.goal.delete');
        if(THEME.has(id))await assertGoalAnalysisManagement(db,config,person(a),String(input.goal_id));
      },
      async authorizeResult(db,raw,a){
        const out=raw as {id:string;space_id:string;goal_id?:string|null};
        if(out.space_id!==a.space_id)throw hidden();
        if(id==='source.goal.setup.legacy'){await assertLegacySource(db,a,out.id);if(out.goal_id)await assertGoalManager(db,a,out.goal_id);return;}
        await assertGoalManager(db,a,out.id);
      },
      async execute(db,raw,a){
        const p=person(a),input=raw as Raw,goal=String(input.goal_id),rest=body(raw);
        const base={id:goal,space_id:a.space_id};
        switch(id){
          case 'source.goal.setup.begin':{
            const out=await new SourceGoalConversation(db as unknown as Pool,config).beginIn(db,p,raw as OperationInput<'source.goal.setup.begin'>);
            return {id:out.goalId,space_id:out.spaceId,follow_activated:!!out.followed?.activated};
          }
          case 'source.goal.create':{const row=await service(db).create(p,raw) as {id:string;space_id:string};return {id:row.id,space_id:row.space_id};}
          case 'source.goal.setup.message':{
            const sent=await new SourceGoalConversation(db as unknown as Pool,config).sendIn(db,p,goal,rest as OperationInput<'source.goal.setup.message'>);
            return {...base,session_id:sent.session_id,run_id:sent.run_id};
          }
          case 'source.goal.setup.legacy':{
            const {channel_id,dry_run}=raw as OperationInput<'source.goal.setup.legacy'>;
            const out=await mapLegacyGoal(db,p,channel_id,dry_run===true) as {goal?:{id:string};created:boolean;dry_run:boolean;source_connection_id?:string;intent?:string};
            return {id:channel_id,space_id:a.space_id,goal_id:out.goal?.id??null,created:out.created,dry_run:out.dry_run,...(out.goal?{}:{source_connection_id:out.source_connection_id,intent:out.intent})};
          }
          case 'source.goal.setup.compatibility_rollback':{const out=await rollbackGoalCompatibility(db,p,goal);return {...base,status:'legacy',changed:out.changed};}
          case 'source.goal.edit':{const out=await editSourceGoal(db,config,p,goal,rest);return {...base,version_id:out.id,revision:out.revision};}
          case 'source.goal.explore':{const out=await queueSourceGoalAgent(db,config,p,goal,'explore') as {run_id:string;job_id?:string};return {...base,run_id:out.run_id,...(out.job_id?{job_id:out.job_id}:{}),status:'queued'};}
          case 'source.goal.preview.request':{
            const previewId=await service(db).admitPreview(db,p,goal,String(input.version_id));
            const job=await new PgJobQueueRepository(db).enqueue({job_type:SOURCE_RETRIEVAL_JOB,space_id:a.space_id,user_id:p.userId,max_attempts:1,payload:{kind:'goal_preview',user_id:p.userId,request:{goal_id:goal,preview_id:previewId}}});
            return {...base,preview_id:previewId,job_id:job.id,status:'pending'};
          }
          case 'source.goal.save':{const out=await service(db).saveSampleIn(db,p,goal,rest);return {...base,version_id:out.version_id,status:out.status};}
          case 'source.goal.follow':{const out=await service(db).followIn(db,p,goal,rest);return {...base,status:out.status,activated:out.activated,prepare:out.prepare};}
          case 'source.goal.feedback':{const out=await service(db).feedbackIn(db,p,goal,rest);return {...base,...out};}
          case 'source.goal.check':{const out=await requestGoalCheck(db,config,p,goal,rest);return {...base,status:out.status,...(out.job_id?{job_id:out.job_id}:{})};}
          case 'source.goal.resume':{const v=(raw as OperationInput<'source.goal.resume'>).version_id;const out=await service(db).resumeIn(db,p,goal,v??'');return {...base,...out};}
          case 'source.goal.pause':case 'source.goal.delete':{const out=await service(db).stopIn(db,p,goal,id==='source.goal.delete');return {...base,status:out.status};}
          case 'source.goal.binding.rollback':{
            const {binding_id,expected_revision}=raw as OperationInput<'source.goal.binding.rollback'>;
            const out=await new SourceGoalRepairService(db as unknown as Pool,config,NO_EXECUTION).rollback(p,goal,binding_id,expected_revision);
            return {...base,binding_id,status:out.status,revision:out.revision};
          }
          case 'source.goal.binding.confirm_source':{
            const {binding_id,binding_revision,authority,restore_channel}=raw as OperationInput<'source.goal.binding.confirm_source'>;
            const out=await confirmBindingSource(db,config,p,goal,binding_id,{binding_revision,authority,...(restore_channel!==undefined?{restore_channel}:{})});
            return {...base,binding_id:out.binding_id,status:out.status,revision:out.binding_revision};
          }
          case 'source.goal.repair.publish':{
            const out=await new SourceGoalRepairService(db as unknown as Pool,config,NO_EXECUTION).publish(p,goal,String(input.repair_id),false);
            return {...base,repair_id:out.repair_id,status:'published',revision:out.revision};
          }
          case 'source.goal.theme.configure':{
            const {configureThemeAnalysis}=await import('../../informationDigest/index.js');
            const out=await configureThemeAnalysis(db,config,p,goal,rest) as {analysis:{enabled:boolean;version_id:string}};
            return {...base,enabled:out.analysis.enabled,version_id:out.analysis.version_id};
          }
          case 'source.goal.theme.retry':{
            const round=String(input.round_id);
            const {readThemeRounds,settleThemeRound}=await import('../../informationDigest/index.js');
            await readThemeRounds(db,p,goal);
            const row=(await db.query('SELECT r.id FROM project_reading_rounds r JOIN source_goals g ON g.id=r.goal_id AND g.space_id=r.space_id WHERE r.space_id=$1 AND r.goal_id=$2 AND r.id=$3 AND g.owner_user_id=$4',[a.space_id,goal,round,p.userId])).rows[0];
            if(!row)throw new HttpError(404,'Theme round not found');
            await settleThemeRound(db,config,round,true);
            return {...base,round_id:round};
          }
          case 'source.goal.theme.cancel':{
            const {cancelThemeRoundIn}=await import('../../informationDigest/index.js');
            const out=await cancelThemeRoundIn(db,config,p,goal,String(input.round_id));
            return {...base,round_id:out.round_id,cancel_requested:out.cancel_requested};
          }
        }
      },
      classifyError:classifySourceGoalError,
    };
    // Post-commit, rebuildable: native-search settlement and the process stop
    // of Runs whose cancellation intent the command committed.
    const after=afterCommitFor(id,config);
    if(after)registration.afterCommit=after;
    return registration;
  });
}

function afterCommitFor(id:SourceGoalOperationId,config:ServerConfig):OperationRegistration['afterCommit']{
  const pool=()=>getDbPool(config.databaseUrl!);
  const activation=async(raw:unknown,a:OperationActor)=>{const out=raw as {id:string};await new SourceGoalService(pool(),config,new SourceGoalExecutor(pool(),config)).afterActivation(person(a),out.id,true);};
  if(id==='source.goal.setup.begin')return async(raw,a)=>{if((raw as {follow_activated:boolean}).follow_activated)await activation(raw,a);};
  if(id==='source.goal.save'||id==='source.goal.follow')return activation;
  if(id==='source.goal.resume')return async(raw,a)=>{if((raw as {activated?:boolean}).activated)await activation(raw,a);};
  if(id==='source.goal.pause'||id==='source.goal.delete')return async(raw,a)=>stopCancellingGoalRuns(pool(),config,person(a),(raw as {id:string}).id,'Source goal stopped');
  if(id==='source.goal.theme.cancel')return async(raw,a)=>{const out=raw as {round_id:string;cancel_requested?:boolean};if(!out.cancel_requested)return;const {stopThemeRoundRun}=await import('../../informationDigest/index.js');await stopThemeRoundRun(pool(),config,person(a),out.round_id);};
  return undefined;
}

/** The single-attempt `goal_preview` Job body (Source dispatch fence held by the caller). */
export async function runGoalPreviewRequest(config:ServerConfig,identity:SpaceUserIdentity,request:Record<string,unknown>){
  const db=getDbPool(config.databaseUrl!),goal=String(request.goal_id),preview=String(request.preview_id);
  try{
    return await new SourceGoalService(db,config,new SourceGoalExecutor(db,config)).runPreview(identity,goal,preview,AbortSignal.timeout(120_000));
  }catch(error){
    // Nothing stored for an unknown outcome: the reservation stops counting as in flight, and nothing is retried.
    await db.query(`UPDATE source_goal_previews SET status='stale' WHERE id=$1 AND space_id=$2 AND goal_id=$3 AND status='running'`,[preview,identity.spaceId,goal]);
    throw error;
  }
}
