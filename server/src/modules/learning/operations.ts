import type {OperationInput,RegisteredSystemActionDefinition} from '@rainver/protocol';
import {LEARNING_OPERATION_SCHEMAS} from '@rainver/protocol';
import {hidden,markedRefusal} from '../systemActions/operations/errors.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {HttpError} from '../routeUtils/common.js';
import {authorizeLearning} from './admission.js';
import {LearningService} from './service.js';
type Id=keyof typeof LEARNING_OPERATION_SCHEMAS;
export function learningRegistrations(definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration[]{
 return (Object.keys(LEARNING_OPERATION_SCHEMAS) as Id[]).map(id=>({
  definition:definitions.get(id)!,domainAuthorizationFirst:true as const,
  successStatus:id==='learning.item.review'?200:201,
  async resolve(_db,raw,actor){return {authority:`learning:${actor.space_id}`,targets:raw,resourceType:'space',resourceId:actor.space_id};},
  async authorize(db,raw,actor){if(actor.principal.kind!=='user')throw hidden();await authorizeLearning(db,{spaceId:actor.space_id,userId:actor.on_behalf_of_user_id!},id==='learning.objective.create'?'objective':id==='learning.item.create'?'item':'review',raw as Record<string,unknown>);},
  async authorizeResult(db,raw,actor){
   const out=raw as {space_id:string;objective?:Record<string,unknown>;item?:Record<string,unknown>;mastery?:Record<string,unknown>};
   if(out.space_id!==actor.space_id)throw hidden();
   const person={spaceId:actor.space_id,userId:actor.on_behalf_of_user_id!};
   if(out.objective)await authorizeLearning(db,person,'objective',out.objective);
   else if(out.item)await authorizeLearning(db,person,'item',out.item);
   else {if(out.mastery?.user_id!==person.userId)throw hidden();await authorizeLearning(db,person,'review',{item_id:out.mastery.learning_item_id});}
  },
  classifyError(error){return error instanceof HttpError?markedRefusal(error,'learning'):undefined;},
  async execute(db,raw,actor){
   const service=new LearningService(db),person={spaceId:actor.space_id,userId:actor.on_behalf_of_user_id!};
   if(id==='learning.objective.create')return {space_id:actor.space_id,objective:await service.createObjective(person,raw as OperationInput<'learning.objective.create'>)};
   if(id==='learning.item.create')return {space_id:actor.space_id,item:await service.createItem(person,raw as OperationInput<'learning.item.create'>)};
   const i=raw as OperationInput<'learning.item.review'>;return {space_id:actor.space_id,mastery:await service.recordReview(person,i.item_id,i)};
  },
 }));
}
