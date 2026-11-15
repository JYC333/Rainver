import type {OperationInput,RegisteredSystemActionDefinition} from '@rainver/protocol';
import {FOCUS_OPERATION_SCHEMAS} from '@rainver/protocol';
import {hidden,markedRefusal} from '../systemActions/operations/errors.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {HttpError} from '../routeUtils/common.js';
import {FocusAreaService} from './service.js';
type Id=keyof typeof FOCUS_OPERATION_SCHEMAS;
export function focusAreaRegistrations(definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration[]{
 return (Object.keys(FOCUS_OPERATION_SCHEMAS) as Id[]).map(id=>({
  definition:definitions.get(id)!,
  ...(id==='focus_area.object.set'?{domainAuthorizationFirst:true as const}:{}),
  successStatus:id==='focus_area.create'?201:200,
  async resolve(_db,raw,actor){const i=raw as OperationInput<Id>;return {authority:`focus:${actor.space_id}`,targets:i,resourceType:'space',resourceId:actor.space_id};},
  async authorize(db,raw,actor){
   if(actor.principal.kind!=='user')throw hidden();
   if(id==='focus_area.object.set'){const i=raw as OperationInput<'focus_area.object.set'>;await new FocusAreaService(db).authorizeObjectClassification({spaceId:actor.space_id,userId:actor.on_behalf_of_user_id!},i.object_id,i.focus_area_id);}
  },
  async authorizeResult(db,raw,actor){
   const out=raw as {space_id:string;object_id?:string;focus_area_id?:string|null;id?:string};if(out.space_id!==actor.space_id)throw hidden();
   const service=new FocusAreaService(db),person={spaceId:actor.space_id,userId:actor.on_behalf_of_user_id!};
   if(out.object_id)await service.authorizeObjectClassification(person,out.object_id,out.focus_area_id??null);
   else {const current=await service.get(person,out.id!);if(id==='focus_area.update'&&current.owner_user_id!==null&&current.owner_user_id!==person.userId)throw hidden();}
  },
  classifyError(error){return error instanceof HttpError?markedRefusal(error,'focusAreas'):undefined;},
  async execute(db,raw,actor){
   const service=new FocusAreaService(db),person={spaceId:actor.space_id,userId:actor.on_behalf_of_user_id!};
   if(id==='focus_area.create')return service.create(person,raw as OperationInput<'focus_area.create'>);
   if(id==='focus_area.update'){const i=raw as OperationInput<'focus_area.update'>;return service.update(person,i.focus_area_id,i);}
   const i=raw as OperationInput<'focus_area.object.set'>;await service.setObjectFocusArea(person,i.object_id,i.focus_area_id);return {space_id:actor.space_id,...i};
  },
 }));
}
