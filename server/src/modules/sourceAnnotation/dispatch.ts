import {createHash} from 'node:crypto';
import type {Queryable} from '../routeUtils/common.js';
import {HttpError} from '../routeUtils/common.js';
import type {RunRecord} from '../runs/repository.js';
import type {AnnotationPromptItem} from './instruction.js';
import type {JobEnvelopeForHandler} from '../jobs/handlerRegistry.js';
import {lockCurrentJobClaim} from '../jobs/effectAuthority.js';
import {lockReadingMutations} from '../sources/readingMutationAccess.js';
import {sourceItemFullContentReadClause} from '../sources/sourceItemAccess.js';
import {assertReadingRunEgress} from '../sources/readingMethods/context.js';
import {PgSourceAnnotationRepository} from './repository.js';

type Input={id:string;hash:string;connection_id:string|null;responsible_user_id:string};
type Context={items:Input[];claim?:JobEnvelopeForHandler};
export const annotationPromptItem=(row:AnnotationPromptItem):AnnotationPromptItem=>({id:row.id,title:row.title,excerpt:row.excerpt,author:row.author,source_domain:row.source_domain,occurred_at:row.occurred_at});
const hash=(item:AnnotationPromptItem)=>createHash('sha256').update(JSON.stringify(annotationPromptItem(item))).digest('hex');
export function annotationRunContext(run:RunRecord):Context|null{return (run.contract_snapshot_json as {workflow_input_json?:{source_annotation?:Context}})?.workflow_input_json?.source_annotation??null;}
export async function freezeAnnotationInputs(db:Queryable,spaceId:string,items:readonly AnnotationPromptItem[]):Promise<Input[]>{
 const result:Input[]=[];
 for(const item of [...items].sort((a,b)=>a.id.localeCompare(b.id))){
  const row=(await db.query<{connection_id:string|null;responsible_user_id:string}>(`SELECT i.connection_id,COALESCE(c.owner_user_id,i.owner_user_id) AS responsible_user_id FROM source_items i LEFT JOIN source_connections c ON c.space_id=i.space_id AND c.id=i.connection_id WHERE i.space_id=$1 AND i.id=$2 AND i.deleted_at IS NULL AND (i.connection_id IS NULL OR (c.id IS NOT NULL AND c.deleted_at IS NULL AND c.status<>'archived'))`,[spaceId,item.id])).rows[0];
  if(!row?.responsible_user_id)throw new HttpError(403,'Annotation Source authority unavailable');
  result.push({id:item.id,hash:hash(item),...row});
 }
 return result;
}
export async function lockAnnotationRunAuthority(db:Queryable,run:RunRecord){
 const context=annotationRunContext(run);if(!context)return;
 await lockCurrentJobClaim(db,context.claim);
 await lockReadingMutations(db,{spaceId:run.space_id,userId:run.instructed_by_user_id!},context.items.map(i=>i.id),[],[],context.items.map(i=>i.responsible_user_id));
}
export async function assertAnnotationRunDispatch(db:Queryable,run:RunRecord){
 const context=annotationRunContext(run);if(!context)return;
 if(context.claim)await lockCurrentJobClaim(db,context.claim);
 const current=await new PgSourceAnnotationRepository(db).loadPendingBatch(run.space_id,context.items.length,context.items.map(i=>i.id));
 const frozen=await freezeAnnotationInputs(db,run.space_id,current);
 if(JSON.stringify(frozen)!==JSON.stringify(context.items))throw new HttpError(403,'Annotation inputs or ownership changed');
 for(const item of context.items){
  const readable=(await db.query(`SELECT i.id FROM source_items i WHERE i.space_id=$1 AND i.id=$2 AND ${sourceItemFullContentReadClause('i','$3')}`,[run.space_id,item.id,item.responsible_user_id])).rows[0];
  if(!readable)throw new HttpError(403,'Annotation Source access withdrawn');
  await assertReadingRunEgress(db,run,item.connection_id);
 }
}
