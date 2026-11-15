import {randomUUID} from 'node:crypto';
import type {Queryable} from '../../routeUtils/common.js';
import {HttpError} from '../../routeUtils/common.js';
import type {ResearchQueryStore} from './adaptiveQueryOrchestrator.js';
import {ResearchQueryRepository,type StoredResearchQueryStrategy} from './repository.js';

/** A request-local write journal, not another evaluator. The existing
 * orchestrator computes everything; the canonical repository applies its
 * ordered writes only inside the Job's final authority/claim transaction.
 * No partially selected strategy escapes when audit or settlement fails. */
export function evaluationWrites(seed:StoredResearchQueryStrategy,nextRound:number){
 const writes:Array<(repo:ResearchQueryRepository)=>Promise<unknown>>=[];
 const store:ResearchQueryStore={
  async createStrategy(identity,input){
   if(input.projectId!==seed.project_id||input.researchContextVersionId!==seed.research_context_version_id||identity.spaceId.length===0||seed.status!=='planning'||JSON.stringify([...input.providers].sort())!==JSON.stringify(seed.provider_plans.map(p=>p.provider_key).sort()))throw new HttpError(409,'Research evaluation intent changed');
   return seed;
  },
  async markStrategyEvaluating(...args){writes.push(repo=>repo.markStrategyEvaluating(...args));},
  async recordSemanticIntent(...args){writes.push(repo=>repo.recordSemanticIntent(...args));},
  async createAttempt(space,input){
   const id=randomUUID(),createdAt=new Date().toISOString();
   writes.push(repo=>repo.createAttempt(space,input,id));
   return {id,provider_plan_id:input.providerPlanId,round:input.round,sequence:input.sequence,direction:input.direction,semantic_query:input.semanticQuery,compiled_query:input.compiledQuery,observation:null,score:null,decision:null,decision_reason:null,error_class:null,created_at:createdAt,completed_at:null};
  },
  async completeAttempt(...args){writes.push(repo=>repo.completeAttempt(...args));},
  async selectAttempt(...args){writes.push(repo=>repo.selectAttempt(...args));},
  async markProviderUnavailable(...args){writes.push(repo=>repo.markProviderUnavailable(...args));},
  async resetProviderPlan(...args){
   writes.push(async repo=>{const actual=await repo.resetProviderPlan(...args);if(actual.nextRound!==nextRound)throw new HttpError(409,'Research retry round changed');});
   return {nextRound};
  },
  async finalizeStrategy(...args){
   writes.push(repo=>repo.finalizeStrategy(...args));
   // The orchestrator never branches on this return value. Only the persisted
   // strategy read AFTER flush is released as a result.
   return 'selected';
  },
  async getStrategy(){return seed;},
 };
 let flushed=false;
 return {store,async flush(tx:Queryable){
  if(flushed)throw new HttpError(409,'Research evaluation writes already settled');
  flushed=true;
  const repo=new ResearchQueryRepository(tx);
  for(const write of writes)await write(repo);
 }};
}
