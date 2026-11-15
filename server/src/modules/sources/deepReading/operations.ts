import {lockReadingMutation} from '../readingMutationAccess.js';
import {readingProjectContext} from '../readingMethods/context.js';
import {requireProcessingItem,assertItemProcessingDispatch,materialItemContext} from '../materialProcessing/items.js';
import {PgRunRepository} from '../../runs/repository.js';
import {assertDeepReadingAccess,deepReadOf} from './contract.js';
import {SourceObjectRefusal} from '../sourceObjectErrors.js';
import type {OperationActor,OperationInput,RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {ServerConfig} from '../../../config.js';
import {dbPool,HttpError,type Queryable} from '../../routeUtils/common.js';
import {lockSpaceRole} from '../../spaces/writers.js';
import {hidden,markedRefusal} from '../../systemActions/operations/errors.js';
import type {OperationRegistration} from '../../systemActions/operations/types.js';
import {ownedDeepReading,requestDeepReadingCancel,finishDeepReadingCancel,startDeepReadingIn} from './service.js';

type Input=OperationInput<'reading.deep_read.cancel'>;
const person=(a:OperationActor)=>({spaceId:a.space_id,userId:a.on_behalf_of_user_id!});
async function check(db:Queryable,input:Input,a:OperationActor){
 if(input.space_id!==a.space_id)throw hidden();
 await lockSpaceRole(db,a.space_id,a.on_behalf_of_user_id!);
 return ownedDeepReading(db,person(a),input.project_id,input.operation_id);
}
/** The canonical Run terminal owner admits this exact Run before domain locks.
 * A receipt records the stop intent, never a fabricated Host acknowledgement. */
export function deepReadingCancelRegistration(config:ServerConfig,defs:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration{
 return {
  definition:defs.get('reading.deep_read.cancel')!,
  runTerminalOwner:{async discover(db,raw,a){const {run}=await check(db,raw as Input,a);return [{space_id:a.space_id,id:run.id}];}},
  async resolve(db,raw,a){const input=raw as Input,{run}=await ownedDeepReading(db,person(a),input.project_id,input.operation_id);return {authority:`run:${run.id}`,targets:{space_id:input.space_id,project_id:input.project_id,operation_id:input.operation_id,run_id:run.id,user_id:a.on_behalf_of_user_id},resourceType:'run',resourceId:run.id};},
  async authorize(db,raw,a){await check(db,raw as Input,a);},
  async authorizeResult(db,raw,a){const output=raw as Input&{user_id:string;run_id:string};if(output.user_id!==a.on_behalf_of_user_id)throw hidden();const {run}=await check(db,output,a);if(run.id!==output.run_id)throw hidden();},
  async execute(db,raw,a){const input=raw as Input;return {...input,user_id:a.on_behalf_of_user_id!,...await requestDeepReadingCancel(db,person(a),input.project_id,input.operation_id)};},
  async afterCommit(raw,a){const output=raw as Input;await finishDeepReadingCancel(dbPool(config),config,person(a),output.project_id,output.operation_id);},
  classifyError:error=>error instanceof HttpError?markedRefusal(error,'reading'):undefined,
 };
}

/** Start joins the existing material owner: queued Run, closed context and
 * agent_run intent commit with the core audit and receipt. */
export function deepReadingStartRegistration(config:ServerConfig,defs:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration{
 type Start=OperationInput<'reading.deep_read.start'>;
 const checkStart=async(db:Queryable,input:Start,a:OperationActor)=>{
  if(input.space_id!==a.space_id)throw hidden();
  await lockReadingMutation(db,person(a),input.item_id,input.project_id,true);
  const {item}=await requireProcessingItem(db,person(a),input.item_id,false);
  if(item.project_id&&item.project_id!==input.project_id)throw hidden();
  await readingProjectContext(db,person(a),input.project_id);
 };
 return {
  definition:defs.get('reading.deep_read.start')!,
  async resolve(_db,raw,a){const input=raw as Start;return {authority:`space:${a.space_id}`,targets:{space_id:input.space_id,project_id:input.project_id,item_id:input.item_id,user_id:a.on_behalf_of_user_id},resourceType:'source_item',resourceId:input.item_id};},
  async authorize(db,raw,a){await checkStart(db,raw as Start,a);},
  async authorizeResult(db,raw,a){
   const output=raw as Start&{user_id:string;run_id?:string};
   if(output.user_id!==a.on_behalf_of_user_id)throw hidden();
   await checkStart(db,output,a);
   if(output.run_id){
    const run=await new PgRunRepository(db).getRun(a.space_id,output.run_id);
    if(!run||run.instructed_by_user_id!==a.on_behalf_of_user_id||deepReadOf(run)?.project_id!==output.project_id||materialItemContext(run)?.item_id!==output.item_id)throw hidden();
    await assertDeepReadingAccess(db,run);
    if(!['succeeded','degraded','failed','cancelled','orphaned'].includes(run.status))await assertItemProcessingDispatch(db,config,run);
   }
  },
  async execute(db,raw,a){const {space_id,project_id,item_id,...input}=raw as Start;return {space_id,project_id,item_id,user_id:a.on_behalf_of_user_id!,...await startDeepReadingIn(db,person(a),project_id,item_id,input)};},
  classifyError:error=>error instanceof HttpError?markedRefusal(error,'reading'):error instanceof SourceObjectRefusal?markedRefusal(error,'sources'):undefined,
 };
}
