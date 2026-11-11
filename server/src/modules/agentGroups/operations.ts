import {AGENT_GROUP_OPERATION_SCHEMAS,type OperationActor,type RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {hidden,markedRefusal} from '../systemActions/operations/errors.js';
import {AgentGroupRunService,type CreateAgentGroupInput,type SendAgentGroupMessageInput} from './service.js';
import {AgentGroupRefusal,HostDispatchRefusal} from './hostDispatchErrors.js';
import {enqueueAgentGroupResumeWake} from './resumeWakeJob.js';

type Id=keyof typeof AGENT_GROUP_OPERATION_SCHEMAS;
type Input=Record<string,unknown>&{group_id?:string;space_id?:string;status?:'active'|'paused'|'cancelled'};
const person=(a:OperationActor)=>({spaceId:a.space_id,userId:a.on_behalf_of_user_id!});

/** Human Agent group run commands over the existing group service. */
export function agentGroupOperationRegistrations(definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>,config:ServerConfig):OperationRegistration[]{
 return (Object.keys(AGENT_GROUP_OPERATION_SCHEMAS) as Id[]).map(id=>({
  definition:definitions.get(id)!,
  successStatus:id==='agent_group.create'||id==='agent_group.message.send'?201:200,
  async resolve(_db,raw,a){const i=raw as Input;
   // A body Space id never selects authority; the service also refuses a mismatch.
   if(i.space_id&&i.space_id!==a.space_id)throw hidden();
   if(id==='agent_group.create')return {authority:`space:${a.space_id}`,targets:{space_id:a.space_id},resourceType:'agent_run_group',resourceId:null};
   return {authority:`agent_group:${i.group_id}`,targets:{group_id:i.group_id},resourceType:'agent_run_group',resourceId:i.group_id!};
  },
  async authorize(db,raw,a){
   if(id==='agent_group.create')return;
   await new AgentGroupRunService(config,db as never).assertManagedGroup(db,person(a),String((raw as Input).group_id));
  },
  async authorizeResult(db,raw,a){
   const out=raw as {space_id:string;group_id:string};
   if(out.space_id!==a.space_id)throw hidden();
   // A replay is released only while the person still manages the group.
   await new AgentGroupRunService(config,db as never).assertManagedGroup(db,person(a),out.group_id);
  },
  async execute(db,raw,a){
   const i=raw as Input,service=new AgentGroupRunService(config,db as never),p=person(a);
   switch(id){
    case 'agent_group.create':{const out=await service.createGroup(p,raw as CreateAgentGroupInput);return {id:out.group.id,space_id:a.space_id,group_id:out.group.id};}
    case 'agent_group.update':{const out=await service.updateGroup(p,raw as never);return {id:out.group.id,space_id:a.space_id,group_id:out.group.id};}
    case 'agent_group.message.send':{const out=await service.sendUserMessage(p,raw as SendAgentGroupMessageInput);return {id:out.message.id,space_id:a.space_id,group_id:i.group_id!,message_id:out.message.id};}
    case 'agent_group.status.set':{
     const out=await service.setStatus(p,i.group_id!,i.status!);
     // Resuming owes parked Runs a re-evaluation; the obligation commits with the status as a Job.
     if(out.status==='active')await enqueueAgentGroupResumeWake(db,{spaceId:a.space_id,userId:p.userId,groupId:out.id});
     return {id:out.id,space_id:a.space_id,group_id:out.id,status:out.status as 'active'|'paused'|'cancelled'};
    }
   }
  },
  classifyError(e){
   if(e instanceof AgentGroupRefusal||e instanceof HostDispatchRefusal)return markedRefusal(e,'agentGroups');
   return undefined;
  },
 }));
}
