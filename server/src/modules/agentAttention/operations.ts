import {ATTENTION_OPERATION_SCHEMAS,type OperationInput,type RegisteredSystemActionDefinition} from '@rainver/protocol';
import {lockPersonalReceiptSpace} from '../access/personalSpace.js';
import {HttpError} from '../routeUtils/common.js';
import {hidden,markedRefusal} from '../systemActions/operations/errors.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {admitAttention} from './admission.js';
import {subjectId} from './repository.js';
import {changeReadState,recordViews,loadWorks,findWork} from './readStateService.js';

type Views=OperationInput<'attention.views.record'>;
type Read=OperationInput<'attention.read_state.change'>;
export function attentionRegistrations(definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration[]{
 return (Object.keys(ATTENTION_OPERATION_SCHEMAS) as (keyof typeof ATTENTION_OPERATION_SCHEMAS)[]).map(id=>({
  definition:definitions.get(id)!,admission:{kind:'person'},domainAuthorizationFirst:true,
  async resolve(_db,raw,a){return {authority:`attention:${a.principal.id}`,targets:raw,resourceType:'attention',resourceId:(raw as Views).session_id??(raw as Read).identity.source_id};},
  async authorize(db,raw,a){
   const i=raw as Views&Read,userId=a.on_behalf_of_user_id!;
   await admitAttention(db,userId,i.space_id,id==='attention.views.record'?{kind:'session',source_id:i.session_id}:i.identity);
   await lockPersonalReceiptSpace(db,userId);
  },
  async authorizeResult(db,raw,a){
   const out=raw as Views&Read,userId=a.on_behalf_of_user_id!;
   const identity=id==='attention.views.record'?{kind:'session' as const,source_id:out.session_id}:out.identity;
   await admitAttention(db,userId,out.space_id,identity);
   await lockPersonalReceiptSpace(db,userId);
   const items=await loadWorks(db,userId,undefined,{space_id:out.space_id,identity});
   if(id==='attention.read_state.change'){
    const item=findWork(items,out.space_id,identity),state=(raw as {state:{subject:Parameters<typeof subjectId>[0]}}).state;
    if(!item.read_states.some(s=>s.subject.kind===state.subject.kind&&subjectId(s.subject)===subjectId(state.subject)))throw hidden();
   }else{
    const states=(raw as {read_states:{subject:Parameters<typeof subjectId>[0]}[]}).read_states;
    const visible=new Set(items.flatMap(item=>item.read_states.map(s=>s.subject.kind+':'+subjectId(s.subject))));
    if(states.some(s=>!visible.has(s.subject.kind+':'+subjectId(s.subject))))throw hidden();
   }
  },
  async execute(db,raw,a){
   const userId=a.on_behalf_of_user_id!;
   if(id==='attention.views.record'){const i=raw as Views;return {...await recordViews(db,userId,i),space_id:i.space_id,session_id:i.session_id};}
   const i=raw as Read;return {space_id:i.space_id,identity:i.identity,state:await changeReadState(db,userId,i)};
  },
  classifyError:error=>error instanceof HttpError?markedRefusal(error,'agentAttention'):undefined,
 }));
}
