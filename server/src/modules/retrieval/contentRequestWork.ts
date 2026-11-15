import type {ServerConfig} from '../../config.js';
import type {SpaceUserIdentity} from '../routeUtils/common.js';
import {dbPool} from '../routeUtils/common.js';
import {RetrievalSearchService,RetrievalFeedbackService,persistRetrievalBriefArtifact,persistRetrievalExplainReportArtifact} from './index.js';
import {knowledgeRetrievalRegistry} from '../knowledge/retrievalAdapter.js';
import {memoryRetrievalRegistry} from '../memory/retrievalAdapter.js';
import {PgMemoryReadRepository} from '../memory/repository.js';
import {RetrievalArtifactWithheld} from './artifactRelease.js';
import {AskSpaceRequestSchema} from '@rainver/protocol';
import {AskSpaceService} from '../askSpace/service.js';
import {readSpaceRetrievalSettings,resolveRetrievalSearchControls} from './settings.js';
import {resolveProviderCommandStore} from '../providers/commands/store.js';
import {ProviderQueryEmbedder} from './embedding/queryEmbedder.js';
import {ProviderReranker} from './rerankProvider/providerReranker.js';
import {ProviderQueryRewriter} from './queryRewriteProvider/providerQueryRewriter.js';
import {ProviderSynthesizer} from './synthesisProvider/providerSynthesizer.js';
import type {RetrievalSearchRequest,RetrievalBriefRequest,RetrievalCreateSafetyRequest,RetrievalExplainRequest,MemorySearchRequestSchema} from '@rainver/protocol';
/** Owning services perform external I/O only in the existing single-attempt
 * worker, outside the admission/result-reader transactions. A persisted Brief
 * or Explain Artifact settles afterwards in its own short transaction under the
 * current Job claim and current release authority (`settleRetrievalArtifact`). */
export async function runContentRequest(config:ServerConfig,identity:SpaceUserIdentity,operation:string,raw:unknown):Promise<unknown>{
 const pool=dbPool(config),memory=operation.startsWith('memory.'),registry=memory?memoryRetrievalRegistry:knowledgeRetrievalRegistry;
 if(operation==='ask_space.think'){
  const b=AskSpaceRequestSchema.parse(raw);
  return new AskSpaceService(pool,config).think({spaceId:identity.spaceId,userId:identity.userId,query:b.query,domains:b.domains,maxResultsPerDomain:b.max_results_per_domain,mode:b.mode,includeTrace:b.include_trace,adaptiveReturn:b.adaptive_return,persist:b.persist,combine:b.combine,combineIncludeMemory:b.combine_include_memory,includeClaimTrajectory:b.include_claim_trajectory});
 }
 if(operation==='memory.search.request'){
  const b=raw as import('zod').z.infer<typeof MemorySearchRequestSchema>;
  return new PgMemoryReadRepository(pool).search(identity.spaceId,identity.userId,{query:b.query,scope:b.scope??null,namespace:b.namespace??null,memoryType:b.type??null,limit:b.limit});
 }
 if(operation.includes('create_safety')){
  const b=raw as RetrievalCreateSafetyRequest;
  return new RetrievalSearchService(pool,registry).assessCreateSafety({spaceId:identity.spaceId,viewerUserId:identity.userId,objectType:b.object_type,title:b.title??null,slug:b.slug??null,aliases:b.aliases??[],uri:b.uri??null,excludeObjectId:b.exclude_object_id??null,maxResults:b.max_results});
 }
 const b=raw as RetrievalSearchRequest&RetrievalBriefRequest&RetrievalExplainRequest;
 const settings=await readSpaceRetrievalSettings(pool,identity.spaceId),controls=resolveRetrievalSearchControls(b,settings),store=resolveProviderCommandStore(config);
 const brief=operation.includes('.brief.'),explain=operation.includes('.explain.'),surface=memory?(brief?'memory_retrieval_brief':'memory_retrieval_search'):brief?'knowledge_brief':explain?'knowledge_explain':'knowledge_search';
 const egressPolicy={externalEgressEnabled:settings.externalEgressEnabled},spend={kind:'person' as const,user_id:identity.userId};
 const search=new RetrievalSearchService(pool,registry,{
  egressPolicy,feedbackService:!brief&&!explain?new RetrievalFeedbackService(pool,registry):undefined,queryEmbedder:new ProviderQueryEmbedder(store,spend,null,undefined,settings.embeddingDimensions,egressPolicy),
  reranker:settings.rerankEnabled?new ProviderReranker(store,{spend,databaseUrl:config.databaseUrl,surface,egressPolicy}):undefined,
  ...(brief?{synthesizer:new ProviderSynthesizer(store,{spend,databaseUrl:config.databaseUrl,surface,egressPolicy})}:{queryRewriter:settings.queryRewriteEnabled?new ProviderQueryRewriter(store,{spend,databaseUrl:config.databaseUrl,surface,egressPolicy}):undefined}),
 });
 const input={spaceId:identity.spaceId,viewerUserId:identity.userId,query:b.query,objectTypes:memory?['memory_entry' as const]:b.object_types,objectProfiles:b.object_profiles,maxResults:controls.maxResults,includeTrace:controls.includeTrace,mode:controls.mode,rewrite:controls.rewrite,useCache:brief?settings.useQueryCache:controls.useCache,adaptiveReturn:controls.adaptiveReturn,rankingConfig:controls.rankingConfig};
 if(!brief&&!explain)return search.search({...input,feedbackSurface:memory?'memory_retrieval_search':'knowledge_search'});
 if(explain){
  const response=await search.explainTarget({...input,targetObjectType:b.object_type,targetObjectId:b.object_id});
  if(!response||!b.persist_artifact)return response;
  // Settlement relocks the current Job claim, the target's release closure
  // and the maintenance role; withdrawn authority writes no Artifact.
  try{
   const artifact=await persistRetrievalExplainReportArtifact(pool,{spaceId:identity.spaceId,ownerUserId:identity.userId,query:b.query,mode:controls.mode,maxResults:controls.maxResults,response,settingsSnapshot:settingsSnapshot(settings)});
   return {...response,artifact_id:artifact};
  }catch(error){if(error instanceof RetrievalArtifactWithheld)return {...response,artifact_error:'retrieval_explain_persist_withheld'};throw error;}
 }
 const response=await search.buildBrief(input);
 if(!b.persist_artifact)return response;
 try{
  const artifact=await persistRetrievalBriefArtifact(pool,{spaceId:identity.spaceId,ownerUserId:identity.userId,runId:null,projectId:null,query:b.query,objectTypes:input.objectTypes,objectProfiles:b.object_profiles,maxResults:controls.maxResults,includeTrace:controls.includeTrace,mode:controls.mode,surface:memory?'memory_retrieval_brief':'knowledge_brief',response,...(memory?{persistTrace:false}:{}),egressPolicySnapshot:{external_egress_enabled:settings.externalEgressEnabled},settingsSnapshot:settingsSnapshot(settings)});
  return {...response,artifact_id:artifact};
 }catch{return {...response,artifact_error:'retrieval_brief_persist_failed'};}
}
function settingsSnapshot(s:Awaited<ReturnType<typeof readSpaceRetrievalSettings>>){return {default_search_mode:s.defaultSearchMode,rerank_enabled:s.rerankEnabled,query_rewrite_enabled:s.queryRewriteEnabled,use_query_cache:s.useQueryCache,include_trace:s.includeTrace,external_egress_enabled:s.externalEgressEnabled,retrieval_tool_mode:s.retrievalToolMode,embedding_dimensions:s.embeddingDimensions,max_results_default:s.maxResultsDefault,ranking_config:s.rankingConfig};}
