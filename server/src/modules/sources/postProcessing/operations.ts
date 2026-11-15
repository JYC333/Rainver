import type {OperationActor,OperationInput,RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {ServerConfig} from '../../../config.js';
import {dbPool,type Queryable} from '../../routeUtils/common.js';
import {PgAgentRepository} from '../../agents/repository.js';
import {PgJobQueueRepository} from '../../jobs/repository.js';
import type {OperationRegistration} from '../../systemActions/operations/types.js';
import {hidden,markedRefusal} from '../../systemActions/operations/errors.js';
import {SourceObjectRefusal} from '../sourceObjectErrors.js';
import {SourceGovernanceInputError} from '../sourceConsent.js';
import {SourceProcessingInputError} from './commandErrors.js';
import {SourcePostProcessingService} from './service.js';
import {PgSourcePostProcessingRepository,SOURCE_POST_PROCESSING_EVENT_JOB_TYPE} from './repository.js';

const IDS=['source.processing.decision.queue','source.processing.decision.review','source.processing.run_once'] as const;
const person=(a:OperationActor)=>({spaceId:a.space_id,userId:a.on_behalf_of_user_id!});
async function visibleDecision(db:Queryable,a:OperationActor,id:string){
  const decision=await new PgSourcePostProcessingRepository(db).getDecision(a.space_id,a.on_behalf_of_user_id!,id);
  if(!decision)throw hidden();
  return decision;
}

/**
 * Post-processing review and one-off runs as core commands. Decision actions
 * reuse decisionAction in the core transaction (status, extraction Job
 * intents, Evidence, Proposal); rerun/deep analysis and one-off runs write a
 * single-attempt worker Job intent only, after pre-effect admission. No Agent,
 * provider or network IO runs in the transaction.
 */
export function sourcePostProcessingRegistrations(config:ServerConfig,definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration[]{
  // Only the audited transaction writers of the Agent repository reach command work (default Agent creation).
  const repository=new PgAgentRepository(dbPool(config));
  const agents={createInTransaction:repository.createInTransaction.bind(repository),publishSystemManagedPromptInTransaction:repository.publishSystemManagedPromptInTransaction.bind(repository)};
  return IDS.map(id=>({
    definition:definitions.get(id)!,
    successStatus:id==='source.processing.run_once'?202 as const:200 as const,
    async resolve(db,raw,a){
      if(id==='source.processing.run_once')return {authority:`source_processing_run_once:${a.space_id}`,targets:{},resourceType:'source_item',resourceId:null};
      const decision=(raw as {decision_id:string}).decision_id;await visibleDecision(db,a,decision);
      return {authority:`source_post_processing_decision:${decision}`,targets:{decision_id:decision},resourceType:'source_item',resourceId:null};
    },
    async authorize(db,raw,a){
      if(id==='source.processing.run_once')return;
      const decision=(raw as {decision_id:string}).decision_id;
      await db.query('SELECT id FROM source_post_processing_item_decisions WHERE id=$1 AND space_id=$2 FOR UPDATE',[decision,a.space_id]);
      await visibleDecision(db,a,decision);
    },
    async authorizeResult(db,raw,a){
      const out=raw as {id:string;space_id:string;job_id?:string};
      if(out.space_id!==a.space_id)throw hidden();
      if(id==='source.processing.run_once'){
        if(!(await db.query('SELECT id FROM jobs WHERE id=$1 AND space_id=$2 AND job_type=$3 AND user_id=$4',[out.job_id,a.space_id,SOURCE_POST_PROCESSING_EVENT_JOB_TYPE,a.on_behalf_of_user_id])).rows.length)throw hidden();
        return;
      }
      await visibleDecision(db,a,out.id);
    },
    async execute(db,raw,a){
      const service=new SourcePostProcessingService(db,config,agents),p=person(a);
      if(id==='source.processing.run_once'){
        const intent=await service.admitOneOff(p,raw as Record<string,unknown>);
        const job=await new PgJobQueueRepository(db).enqueue({space_id:a.space_id,user_id:p.userId,job_type:SOURCE_POST_PROCESSING_EVENT_JOB_TYPE,max_attempts:1,payload:{phase:'manual_run_once',user_id:p.userId,request:intent}});
        return {id:job.id,space_id:a.space_id,job_id:job.id,status:'pending' as const};
      }
      const input=raw as OperationInput<'source.processing.decision.review'>;
      const result=await service.decisionAction(p,input.decision_id,{action:input.action});
      return {id:input.decision_id,space_id:a.space_id,review_status:result.decision.review_status,...(result.proposal_id?{proposal_id:result.proposal_id}:{}),...(result.job_ids?{job_ids:result.job_ids}:{})};
    },
    classifyError(error){
      if(error instanceof SourceObjectRefusal||error instanceof SourceProcessingInputError||error instanceof SourceGovernanceInputError)return markedRefusal(error,'sources');
      return undefined;
    },
  }));
}
