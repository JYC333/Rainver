import {SOURCE_RETRIEVAL_JOB,type OperationActor,type OperationInput,type RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import {getDbPool} from '../../db/pool.js';
import type {Queryable,SpaceUserIdentity} from '../routeUtils/common.js';
import {PgJobQueueRepository} from '../jobs/repository.js';
import {assertProjectWriterForMutation} from '../projects/access.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {hidden,markedRefusal} from '../systemActions/operations/errors.js';
import {assertSourceConnectionManageable} from './sourceConnectionAccess.js';
import {SourceObjectRefusal} from './sourceObjectErrors.js';
import {SourceRecipeCreateService,SourceRecipeCreateError} from './sourceRecipes/recipeCreateService.js';
import {SourceRecipeDryRunService} from './sourceRecipes/recipeDryRunService.js';

const person=(a:OperationActor)=>({spaceId:a.space_id,userId:a.on_behalf_of_user_id!});
/** A recipe Source the caller manages (and, for a Project Source, writes), locked for the command. */
async function managedRecipeSource(db:Queryable,p:SpaceUserIdentity,connectionId:string,lock:boolean){
  const row=(await db.query<{project_id:string|null}>(`SELECT project_id FROM source_connections WHERE id=$1 AND space_id=$2 AND deleted_at IS NULL${lock?' FOR UPDATE':''}`,[connectionId,p.spaceId])).rows[0];
  if(!row)throw hidden();
  await assertSourceConnectionManageable(db,p,connectionId);
  return row.project_id;
}
const queue=async(db:Queryable,a:OperationActor,kind:'recipe_plan'|'recipe_dry_run',request:Record<string,unknown>)=>{
  const job=await new PgJobQueueRepository(db).enqueue({job_type:SOURCE_RETRIEVAL_JOB,space_id:a.space_id,user_id:a.on_behalf_of_user_id!,max_attempts:1,payload:{kind,user_id:a.on_behalf_of_user_id,request}});
  return {id:job.id,space_id:a.space_id,job_id:job.id,status:'pending' as const};
};
const jobReceipt=async(db:Queryable,raw:unknown,a:OperationActor)=>{const out=raw as {space_id:string;job_id:string};if(out.space_id!==a.space_id||!(await db.query('SELECT id FROM jobs WHERE id=$1 AND space_id=$2 AND job_type=$3 AND user_id=$4',[out.job_id,a.space_id,SOURCE_RETRIEVAL_JOB,a.on_behalf_of_user_id])).rows.length)throw hidden();};
const classify=(error:unknown)=>error instanceof SourceObjectRefusal||error instanceof SourceRecipeCreateError?markedRefusal(error,'sources'):undefined;

/**
 * Source recipe planning, dry-run and activation as core commands. Planning
 * (endpoint fetch + sandbox preview) and dry-run (endpoint fetch + recipe
 * execution) are admitted in the transaction and run as single-attempt Jobs;
 * the dry-run outcome is recorded by its existing status-fenced writer.
 * Activation is DB-only: an in-envelope activation, or the canonical
 * `source_recipe_activation` proposal decided by its applier. Dry-run and
 * activation require current management of the recipe Source, which the
 * retained handlers did not check (they only required the Source to exist).
 */
export function sourceRecipeRegistrations(config:ServerConfig,definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration[]{
  return [
    {
      definition:definitions.get('source.recipe.plan.request')!,successStatus:202,
      async resolve(_db,_raw,a){return {authority:`source_recipe_plan:${a.space_id}`,targets:{},resourceType:'source_connection',resourceId:null};},
      // Creator role, domain and credential ownership are checked where their refusals are classified (execute).
      async authorize(){},
      authorizeResult:jobReceipt,
      async execute(db,raw,a){await new SourceRecipeCreateService(db,config).authorizeCreation(person(a),raw as Record<string,unknown>);return queue(db,a,'recipe_plan',raw as Record<string,unknown>);},
      classifyError:classify,
    },
    {
      definition:definitions.get('source.recipe.dry_run.request')!,successStatus:202,
      async resolve(db,raw,a){const id=(raw as {source_connection_id:string}).source_connection_id;await managedRecipeSource(db,person(a),id,false);return {authority:`source_connection:${id}`,targets:{source_connection_id:id,recipe_version_id:(raw as {recipe_version_id:string}).recipe_version_id},resourceType:'source_connection',resourceId:id};},
      async authorize(db,raw,a){const p=person(a),id=(raw as {source_connection_id:string}).source_connection_id,project=await managedRecipeSource(db,p,id,false);if(project)await assertProjectWriterForMutation(db,a.space_id,project,p.userId);await managedRecipeSource(db,p,id,true);},
      authorizeResult:jobReceipt,
      async execute(db,raw,a){const input=raw as OperationInput<'source.recipe.dry_run.request'>;await new SourceRecipeDryRunService(db,config).admitDryRun(person(a),input.source_connection_id,input);return queue(db,a,'recipe_dry_run',input);},
      classifyError:classify,
    },
    {
      definition:definitions.get('source.recipe.activate')!,
      async resolve(db,raw,a){const id=(raw as {source_connection_id:string}).source_connection_id;await managedRecipeSource(db,person(a),id,false);return {authority:`source_connection:${id}`,targets:{source_connection_id:id,recipe_version_id:(raw as {recipe_version_id:string}).recipe_version_id},resourceType:'source_connection',resourceId:id};},
      async authorize(db,raw,a){const p=person(a),id=(raw as {source_connection_id:string}).source_connection_id,project=await managedRecipeSource(db,p,id,false);if(project)await assertProjectWriterForMutation(db,a.space_id,project,p.userId);if(await managedRecipeSource(db,p,id,true)!==project)throw hidden();},
      async authorizeResult(db,raw,a){const out=raw as {id:string;space_id:string};if(out.space_id!==a.space_id)throw hidden();await managedRecipeSource(db,person(a),out.id,false);},
      async execute(db,raw,a){
        const {source_connection_id:id,...body}=raw as OperationInput<'source.recipe.activate'>;
        const out=await new SourceRecipeCreateService(db,config).activateRecipe(person(a),id,body);
        return {id,space_id:a.space_id,status:out.status,recipe_version_id:out.recipe_version.id,proposal_id:out.proposal_id??null,deltas:out.deltas};
      },
      classifyError:classify,
    },
  ];
}

/** Worker execution for queued recipe requests, under current authority; results carry identity/status for dry-runs. */
export async function runSourceRecipeRequest(config:ServerConfig,identity:SpaceUserIdentity,kind:'recipe_plan'|'recipe_dry_run',body:Record<string,unknown>):Promise<Record<string,unknown>>{
  const pool=getDbPool(config.databaseUrl!);
  if(kind==='recipe_plan')return await new SourceRecipeCreateService(pool,config).planSource(identity,body) as unknown as Record<string,unknown>;
  const connection=String(body.source_connection_id);
  await assertSourceConnectionManageable(pool,identity,connection);
  const out=await new SourceRecipeDryRunService(pool,config).dryRunRecipeVersion(identity,connection,body);
  // The dry-run result itself is recorded on the version and read through the recipe-version reader.
  return {recipe_version_id:out.recipe_version.id,source_connection_id:connection,dry_run_status:out.dry_run.status,item_count:out.dry_run.item_count};
}
