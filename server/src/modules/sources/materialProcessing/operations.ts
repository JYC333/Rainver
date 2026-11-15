import type {OperationActor,OperationInput,RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {ServerConfig} from '../../../config.js';
import type {Queryable} from '../../routeUtils/common.js';
import type {OperationRegistration,ResolvedOperation} from '../../systemActions/operations/types.js';
import {OperationError,hidden,markedRefusal} from '../../systemActions/operations/errors.js';
import {assertProjectWriterForMutation} from '../../projects/access.js';
import {contentDecisionFromDb} from '../../access/contentAccessQuery.js';
import {SourceObjectRefusal} from '../sourceObjectErrors.js';
import {MaterialItemProcessingService} from './items.js';
import {proposeMaterialStorage} from './consent.js';
import {showAgentTextAsMarkdown} from './syntax.js';

const IDS=['source.material.start','source.material.cancel','source.material.request_storage','source.material.show_markdown'] as const;
const person=(a:OperationActor)=>({spaceId:a.space_id,userId:a.on_behalf_of_user_id!});
type Scope=ResolvedOperation&{project:string|null};

/** The item's stable placement, only for a caller with full content reach. */
async function itemProject(db:Queryable,a:OperationActor,itemId:string,lock:boolean):Promise<string|null>{
  if(await contentDecisionFromDb(db,person(a),'source_item',itemId,{includeOversight:false})!=='full')throw hidden();
  const row=(await db.query<{project_id:string|null}>(`SELECT project_id FROM source_items WHERE id=$1 AND space_id=$2 AND deleted_at IS NULL${lock?' FOR UPDATE':''}`,[itemId,a.space_id])).rows[0];
  if(!row)throw hidden();
  return row.project_id;
}

/**
 * Material processing as core commands over the existing Source-owned writers.
 * Start writes the queued Run, its material operation row and the agent_run
 * Job intent consumed by the unchanged worker; cancel writes the cancellation
 * intent (the process stop is after commit); storage submits the Source-wide
 * `source_material_retention` proposal decided by its canonical applier;
 * show-as-Markdown saves one version-fenced document. No Agent, provider,
 * network or file IO runs in the transaction.
 */
export function materialProcessingRegistrations(config:ServerConfig,definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration[]{
  return IDS.map(id=>({
    definition:definitions.get(id)!,
    async resolve(db,raw,a){
      const item=(raw as {source_item_id:string}).source_item_id;
      const project=await itemProject(db,a,item,false);
      return {authority:`source_item:${item}`,targets:{source_item_id:item,project_id:project},resourceType:'source_item',resourceId:item,project} as Scope;
    },
    async authorize(db,raw,a,scope){
      // Project writer authority before the item row lock, then the placement again.
      const project=(scope as Scope).project;
      if(project)await assertProjectWriterForMutation(db,a.space_id,project,a.on_behalf_of_user_id!);
      if(await itemProject(db,a,(raw as {source_item_id:string}).source_item_id,true)!==project)throw new OperationError('operation_conflict',409);
    },
    async authorizeResult(db,raw,a){
      const out=raw as {id:string;space_id:string};
      if(out.space_id!==a.space_id)throw hidden();
      await itemProject(db,a,out.id,false);
    },
    async execute(db,raw,a){
      const p=person(a);
      if(id==='source.material.start'){
        const {source_item_id,...input}=raw as OperationInput<'source.material.start'>;
        const state=await MaterialItemProcessingService.startIn(db,p,source_item_id,input);
        return {id:source_item_id,space_id:a.space_id,...state};
      }
      if(id==='source.material.cancel'){
        const {source_item_id}=raw as OperationInput<'source.material.cancel'>;
        return {id:source_item_id,space_id:a.space_id,...await MaterialItemProcessingService.cancelIn(db,p,source_item_id)};
      }
      if(id==='source.material.request_storage'){
        const {source_item_id}=raw as OperationInput<'source.material.request_storage'>;
        return {id:source_item_id,space_id:a.space_id,...await proposeMaterialStorage(db,p,source_item_id)};
      }
      const {source_item_id,artifact_id,source_snapshot_id}=raw as OperationInput<'source.material.show_markdown'>;
      const saved=await showAgentTextAsMarkdown(db,config,p,source_item_id,{artifact_id,source_snapshot_id});
      return {id:source_item_id,space_id:a.space_id,artifact_id:saved.artifact_id};
    },
    ...(id==='source.material.cancel'?{async afterCommit(raw:unknown,a:OperationActor){
      const out=raw as {run_id?:string;cancel_requested?:boolean};
      if(!out.cancel_requested||!out.run_id)return;
      const {buildRunOrchestration}=await import('../../runs/orchestrationFactory.js');
      await buildRunOrchestration(config).orchestration.cancelRun({run_id:out.run_id,space_id:a.space_id,requested_by_user_id:a.on_behalf_of_user_id,reason:'Material processing cancelled by owner'});
    }}:{}),
    classifyError(error){
      if(error instanceof SourceObjectRefusal)return markedRefusal(error as SourceObjectRefusal&{statusCode:number},'sources');
      return undefined;
    },
  }));
}
