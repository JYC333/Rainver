import type {OperationActor,OperationInput,RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import {HttpError} from '../routeUtils/common.js';
import {hidden,markedRefusal} from '../systemActions/operations/errors.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {admitStrategy,discoverStrategyAdmission,strategyPerson} from './discovery/strategyAdmission.js';
import {ResearchContextRepository} from '../projectResearch/question/researchContextRepository.js';
import {ResearchQueryRepository} from './queryPlanning/repository.js';
import {assertContextAssessmentPassed} from './queryPlanning/adaptiveQueryOrchestrator.js';
import {RESEARCH_QUERY_POLICY_VERSION,researchQueryPolicySnapshot} from './queryPlanning/queryPolicy.js';
import {requestRunJob,existingEvaluation} from './evaluationJob.js';
type Evaluate=OperationInput<'research.strategy.evaluate'>;
type Retry=OperationInput<'research.strategy.retry'>;
const target=(i:Evaluate)=>({project_id:i.project_id,research_context_version_id:i.research_context_version_id,providers:i.providers});
export function researchEvaluationRegistrations(config:ServerConfig,defs:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration[]{
 return (['research.strategy.evaluate','research.strategy.retry'] as const).map(id=>({
  definition:defs.get(id)!,domainAuthorizationFirst:true,successStatus:202,
  async resolve(db,raw,a){
   const i=raw as Evaluate|Retry;
   const c=await discoverStrategyAdmission(db,a.space_id,'strategy_id' in i?i.strategy_id:target(i),strategyPerson(a).userId);
   if(c.strategy.project_id!==i.project_id)throw hidden();
   return {authority:`project:${c.strategy.project_id}`,targets:i,resourceType:'source_channel',resourceId:c.strategy.project_id};
  },
  async authorize(db,raw,a){
   const i=raw as Evaluate|Retry;
   await admitStrategy(db,config,a,'strategy_id' in i?i.strategy_id:target(i),[],Object.values(i.credentials??{}));
   if(!('strategy_id' in i)){
    const c=await new ResearchContextRepository(db).get(a.space_id,i.project_id,i.research_context_version_id);
    if(!c)throw hidden();assertContextAssessmentPassed(c.assessment);
   }
  },
  async authorizeResult(db,raw,a:OperationActor){await admitStrategy(db,config,a,(raw as {strategy_id:string}).strategy_id);},
  async execute(db,raw,a){
   if(id==='research.strategy.retry'){
    const {strategy_id,provider_key,...request}=raw as Retry;
    return requestRunJob(db,config,a,strategy_id,{kind:'retry',provider_key,request});
   }
   const i=raw as Evaluate,providers=[...new Set(i.providers)],budget=Math.max(1,Math.ceil(i.candidate_budget/providers.length));
   const existing=await existingEvaluation(db,config,a,i);if(existing)return existing;
   const strategy=await new ResearchQueryRepository(db).createStrategy(strategyPerson(a),{projectId:i.project_id,researchContextVersionId:i.research_context_version_id,providers,policyVersion:RESEARCH_QUERY_POLICY_VERSION,policy:researchQueryPolicySnapshot(providers,budget),executionBudget:{candidate_budget:i.candidate_budget,provider_candidate_budget:budget}});
   return requestRunJob(db,config,a,strategy.id,{kind:'evaluate',request:i});
  },
  classifyError:error=>error instanceof HttpError?markedRefusal(error,'research'):undefined,
 }));
}
