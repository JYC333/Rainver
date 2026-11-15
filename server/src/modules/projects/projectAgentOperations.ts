import {PROJECT_AGENT_OPERATION_SCHEMAS,type OperationActor,type RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {Queryable} from '../routeUtils/common.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {OperationError,hidden} from '../systemActions/operations/errors.js';
import {assertProjectReadable,assertProjectWriter,assertProjectWriterForMutation,lockActiveProjectForMutation,ProjectArchivedMutationError} from './access.js';
import {PgProjectAgentRepository} from './projectAgents.js';

type Id=keyof typeof PROJECT_AGENT_OPERATION_SCHEMAS;
type Input={project_id:string;agent_id:string};
const person=(a:OperationActor)=>({spaceId:a.space_id,userId:a.on_behalf_of_user_id!});

/**
 * Adding an existing Agent to a Project, or taking it off the Project's list.
 *
 * Project writer authority, rechecked under the archive fence. The add accepts
 * only an Agent the person may link (`linkableAgentSql`): same Space, readable
 * by them, and their own when it is not shared with the Space. Neither command
 * touches a Room roster: joining a Room is its own Room command, and leaving
 * the Project list does not remove the Agent from any Room.
 */
export function projectAgentRegistrations(definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration[]{
 return (Object.keys(PROJECT_AGENT_OPERATION_SCHEMAS) as Id[]).map(id=>({
  definition:definitions.get(id)!,
  successStatus:id==='project.agent.add'?201:200,
  async resolve(_db,raw){const i=raw as Input;
   return {authority:`project:${i.project_id}`,targets:{project_id:i.project_id,agent_id:i.agent_id},resourceType:'project',resourceId:i.project_id};
  },
  async authorize(db,raw,a){const i=raw as Input,p=person(a);
   await assertProjectWriter(db,p.spaceId,i.project_id,p.userId,{allowArchived:true});
   try{await lockActiveProjectForMutation(db,p.spaceId,i.project_id);}
   catch(e){if(e instanceof ProjectArchivedMutationError)throw new OperationError('operation_conflict',409,false,'projects');throw e;}
   await assertProjectWriterForMutation(db,p.spaceId,i.project_id,p.userId);
   const repository=new PgProjectAgentRepository(db);
   if(id==='project.agent.add'){
    if(!await repository.linkableAgent({...p,projectId:i.project_id,agentId:i.agent_id,lock:true}))throw hidden();
    return;
   }
   // Live authority only: an Agent the person cannot read is answered like a missing one, whether or
   // not it is linked. That the link is still active is the first execution's precondition (execute),
   // not authority — a replay of a removal that succeeded must return its receipt, not 404.
   if(!await repository.agentReadable({...p,agentId:i.agent_id}))throw hidden();
  },
  async authorizeResult(db:Queryable,raw:unknown,a:OperationActor){
   const out=raw as {space_id:string;project_id:string};
   if(out.space_id!==a.space_id)throw hidden();
   await assertProjectReadable(db,a.space_id,out.project_id,a.on_behalf_of_user_id!);
  },
  async execute(db,raw,a){const i=raw as Input,p=person(a),repository=new PgProjectAgentRepository(db);
   if(id==='project.agent.add'){
    const link=await repository.upsertActive({spaceId:p.spaceId,projectId:i.project_id,agentId:i.agent_id,userId:p.userId});
    return {id:link.id,space_id:p.spaceId,project_id:i.project_id,agent_id:i.agent_id};
   }
   // First execution only: nothing to remove is answered like a missing Agent.
   const link=await repository.activeLink({spaceId:p.spaceId,projectId:i.project_id,agentId:i.agent_id,lock:true});
   if(!link)throw hidden();
   await repository.markRemoved({spaceId:p.spaceId,linkId:link.id});
   return {id:link.id,space_id:p.spaceId,project_id:i.project_id,agent_id:i.agent_id};
  },
 }));
}
