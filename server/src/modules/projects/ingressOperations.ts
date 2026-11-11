import {PROJECT_INGRESS_SCHEMAS,type OperationActor,type RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import type {Queryable} from '../routeUtils/common.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {OperationBusinessError,OperationError,hidden} from '../systemActions/operations/errors.js';
import {SourceChannelMutationError} from '../sources/channels/sourceChannelService.js';
import {SourceBackfillMutationError} from '../sources/sourceBackfillErrors.js';
import {SourceMonitorScopeConflict,lockSourceChannelReference} from '../sources/sourceMonitorParent.js';
import {RetrievalFeedbackService} from '../retrieval/index.js';
import {projectRetrievalRegistry} from './retrievalAdapter.js';
import {assertProjectReadable,assertProjectReadableLocked,assertProjectWriter,assertProjectWriterForMutation,lockActiveProjectForMutation,ProjectArchivedMutationError} from './access.js';
import {ProjectMonitoringService} from './monitoring/service.js';
import {MonitoringControlError} from './monitoring/operationErrors.js';
import {ProjectSourceProposalService} from './projectSourceProposalService.js';
import {ProjectSourceMutationError} from './projectSourceMutationError.js';

const IDS=['project.monitoring.source.setup','project.monitoring.proposal.create','project.monitoring.reconcile','project.monitoring.run.start','project.monitoring.feedback','project.source.bind.propose','project.source.setup.propose','project.summary.feedback'] as const satisfies readonly (keyof typeof PROJECT_INGRESS_SCHEMAS)[];
type Id=typeof IDS[number];
type Input={project_id?:string;item_id?:string;source_channel_id?:string;object_id?:string};
type Receipt={id:string;space_id:string;project_id?:string;source_channel_id?:string;source_proposal_id?:string;binding_proposal_id?:string};
type SetupBundle={operation:{id:unknown};channel_draft:{id:unknown};source_proposal:{id:unknown};binding_proposal:{id:unknown}};
const person=(a:OperationActor)=>({spaceId:a.space_id,userId:a.on_behalf_of_user_id!});
const fields=(raw:unknown)=>{const value={...raw as Record<string,unknown>};delete value.project_id;delete value.item_id;return value;};
const setupReceipt=(a:OperationActor,projectId:string,b:SetupBundle)=>({id:String(b.operation.id),project_id:projectId,space_id:a.space_id,source_channel_id:String(b.channel_draft.id),source_proposal_id:String(b.source_proposal.id),binding_proposal_id:String(b.binding_proposal.id)});

async function lockWriter(db:Queryable,a:OperationActor,projectId:string){
 await assertProjectWriter(db,a.space_id,projectId,a.on_behalf_of_user_id!,{allowArchived:true});
 try{await lockActiveProjectForMutation(db,a.space_id,projectId);}catch(e){if(e instanceof ProjectArchivedMutationError)throw new OperationError('operation_conflict',409,false,'projects');throw e;}
 await assertProjectWriterForMutation(db,a.space_id,projectId,a.on_behalf_of_user_id!);
}

/** Human-only monitoring, Source-proposal and private feedback commands over the existing domain writers. */
export function projectIngressCommandRegistrations(definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>,config:ServerConfig):OperationRegistration[]{
 return IDS.map((id:Id)=>({
  definition:definitions.get(id)!,
  successStatus:id==='project.monitoring.run.start'?202:['project.monitoring.source.setup','project.monitoring.proposal.create','project.source.bind.propose','project.source.setup.propose','project.summary.feedback'].includes(id)?201:200,
  async resolve(_db,raw,a){const i=raw as Input;
   if(id==='project.summary.feedback')return {authority:`space:${a.space_id}`,targets:{object_id:i.object_id},resourceType:'project_public_summary',resourceId:i.object_id!};
   return {authority:`project:${i.project_id}`,targets:{project_id:i.project_id,item_id:i.item_id??null,source_channel_id:i.source_channel_id??null},resourceType:id==='project.source.bind.propose'?'project_source':id.endsWith('setup')||id==='project.source.setup.propose'?'source_connection':'project',resourceId:i.project_id!};
  },
  async authorize(db,raw,a){const i=raw as Input;
   switch(id){
    case 'project.summary.feedback':return; // The domain adapter revalidates current summary visibility before writing.
    case 'project.monitoring.feedback':await assertProjectReadableLocked(db,a.space_id,i.project_id!,a.on_behalf_of_user_id!);return;
    // The owning writer admits pending monitoring Proposal transitions before
    // the Project lock; authorize must not invert that order.
    case 'project.monitoring.proposal.create':await assertProjectWriter(db,a.space_id,i.project_id!,a.on_behalf_of_user_id!);return;
    case 'project.source.bind.propose':
     await lockWriter(db,a,i.project_id!);
     // Pin the Source parent then channel; an absent/archived channel is not proposable.
     if(!await lockSourceChannelReference(db,a.space_id,i.source_channel_id!))throw hidden();
     if(!(await db.query("SELECT ch.id FROM source_channels ch JOIN source_connections sc ON sc.id=ch.source_connection_id AND sc.space_id=ch.space_id WHERE ch.id=$1 AND ch.space_id=$2 AND ch.status<>'archived' AND sc.deleted_at IS NULL",[i.source_channel_id,a.space_id])).rows.length)throw hidden();
     return;
    default:await lockWriter(db,a,i.project_id!);
   }
  },
  async authorizeResult(db,raw,a){const out=raw as Receipt;if(out.space_id!==a.space_id)throw hidden();
   if(id==='project.summary.feedback')return;
   if(id==='project.monitoring.feedback'){await assertProjectReadable(db,a.space_id,out.project_id!,a.on_behalf_of_user_id!);return;}
   await assertProjectWriterForMutation(db,a.space_id,out.project_id!,a.on_behalf_of_user_id!);
   const proposals=id==='project.monitoring.proposal.create'||id==='project.source.bind.propose'?[out.id]:out.source_proposal_id?[out.source_proposal_id,out.binding_proposal_id!]:[];
   if(proposals.length&&(await db.query('SELECT id FROM proposals WHERE space_id=$1 AND project_id=$2 AND id=ANY($3::varchar[])',[a.space_id,out.project_id,proposals])).rows.length!==proposals.length)throw hidden();
  },
  async execute(db,raw,a){const i=raw as Input,p=person(a),monitoring=new ProjectMonitoringService(db,config),proposals=new ProjectSourceProposalService(db,config);
   const base={project_id:i.project_id!,space_id:a.space_id};
   switch(id){
    case 'project.monitoring.source.setup':return setupReceipt(a,i.project_id!,await monitoring.setup(p,i.project_id!,fields(raw)) as unknown as SetupBundle);
    case 'project.source.setup.propose':return setupReceipt(a,i.project_id!,await proposals.proposeSourceSetup(p,i.project_id!,fields(raw)) as unknown as SetupBundle);
    case 'project.monitoring.proposal.create':{const out=await monitoring.propose(p,i.project_id!,fields(raw)) as {proposal:{id:unknown};version?:{id:string}};return {...base,id:String(out.proposal.id),version_id:out.version?.id??null};}
    case 'project.monitoring.reconcile':{const out=await monitoring.reconcile(p,i.project_id!);return {...base,id:i.project_id!,coordinator_active:out.coordinatorActive};}
    case 'project.monitoring.run.start':return {...base,id:(await monitoring.start(p,i.project_id!,fields(raw))).id};
    case 'project.monitoring.feedback':{const feedback=(raw as {feedback:'read'|'relevant'|'not_relevant'}).feedback;await monitoring.feedback(p,i.project_id!,i.item_id!,feedback);return {...base,id:i.item_id!,feedback};}
    case 'project.source.bind.propose':return {...base,id:String((await proposals.proposeBind(p,i.project_id!,fields(raw))).proposal.id)};
    case 'project.summary.feedback':{
     const b=raw as {query:string;object_id:string;signal_type:string;dwell_ms?:number;metadata?:Record<string,unknown>};
     const recorded=await new RetrievalFeedbackService(db,projectRetrievalRegistry).record({spaceId:a.space_id,viewerUserId:p.userId,surface:'project_public_summary_search',query:b.query,objectType:'project_public_summary',objectId:b.object_id,signalType:b.signal_type as never,dwellMs:b.dwell_ms??null,metadata:b.metadata??null});
     if(!recorded)throw hidden();return {id:b.object_id,space_id:a.space_id};
    }
   }
  },
  classifyError(e){
   if(e instanceof MonitoringControlError||e instanceof ProjectSourceMutationError||e instanceof SourceChannelMutationError||e instanceof SourceBackfillMutationError){const status=(e as {statusCode:number}).statusCode;if(status===409||status===422)return new OperationBusinessError(status===409?'operation_conflict':'operation_invalid_input',status,'projects');}
   if(e instanceof SourceMonitorScopeConflict)return new OperationBusinessError('operation_conflict',409,'projects');
   return undefined;
  },
 }));
}
