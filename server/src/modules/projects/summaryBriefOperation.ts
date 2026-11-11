import type {OperationActor,RegisteredSystemActionDefinition,RetrievalBriefRequest,RetrievalBriefResponse} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import {getDbPool} from '../../db/pool.js';
import type {SpaceUserIdentity} from '../routeUtils/common.js';
import type {JobHandlerRegistry} from '../jobs/handlerRegistry.js';
import {PgJobQueueRepository} from '../jobs/repository.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {hidden} from '../systemActions/operations/errors.js';
import {RetrievalSearchService,persistRetrievalBriefArtifact} from '../retrieval/index.js';
import {readSpaceRetrievalSettings,resolveRetrievalSearchControls} from '../retrieval/settings.js';
import {ProviderReranker} from '../retrieval/rerankProvider/providerReranker.js';
import {ProviderQueryEmbedder} from '../retrieval/embedding/queryEmbedder.js';
import {ProviderSynthesizer} from '../retrieval/synthesisProvider/providerSynthesizer.js';
import {resolveProviderCommandStore} from '../providers/commands/store.js';
import {projectRetrievalRegistry} from './retrievalAdapter.js';

const OPERATION='project.summary.brief.request';
/** One requested public-summary Context Brief; the result is readable only by its requester. */
export const PROJECT_SUMMARY_BRIEF_JOB='project_summary_brief';

/** Admission only: provider embedding/rerank/synthesis never run inside the core transaction. */
export function projectSummaryBriefRegistration(definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration{return {
 definition:definitions.get(OPERATION)!,successStatus:202,
 async resolve(_db,raw,a){return {authority:`space:${a.space_id}`,targets:{query:(raw as RetrievalBriefRequest).query},resourceType:'project_public_summary',resourceId:null};},
 // Space membership is checked by the core actor gate; every source is revalidated for the viewer when the brief is built.
 async authorize(){},
 async authorizeResult(db,raw,a){const out=raw as {space_id:string;job_id:string};if(out.space_id!==a.space_id)throw hidden();
  if(!(await db.query('SELECT id FROM jobs WHERE id=$1 AND space_id=$2 AND job_type=$3 AND user_id=$4',[out.job_id,a.space_id,PROJECT_SUMMARY_BRIEF_JOB,a.on_behalf_of_user_id])).rows.length)throw hidden();
 },
 async execute(db,raw,a:OperationActor){
  const job=await new PgJobQueueRepository(db).enqueue({job_type:PROJECT_SUMMARY_BRIEF_JOB,space_id:a.space_id,user_id:a.on_behalf_of_user_id!,payload:{request:raw},max_attempts:1});
  return {id:job.id,space_id:a.space_id,job_id:job.id};
 },
};}

export function registerProjectSummaryBriefJob(registry:JobHandlerRegistry,config:ServerConfig):void{
 if(!config.databaseUrl)return;
 registry.register(PROJECT_SUMMARY_BRIEF_JOB,async job=>{
  if(!job.user_id)throw new Error('project_summary_brief requires its requesting person');
  return buildProjectSummaryBrief(config,{spaceId:job.space_id,userId:job.user_id},job.payload.request as RetrievalBriefRequest) as unknown as Record<string,unknown>;
 });
}

/** The public-summary Context Brief, restricted to `project_public_summary`, with optional private artifact. */
async function buildProjectSummaryBrief(config:ServerConfig,identity:SpaceUserIdentity,body:RetrievalBriefRequest):Promise<RetrievalBriefResponse>{
 const pool=getDbPool(config.databaseUrl!);
 const retrievalSettings=await readSpaceRetrievalSettings(pool,identity.spaceId);
 const store=resolveProviderCommandStore(config);
 const egressPolicy={externalEgressEnabled:retrievalSettings.externalEgressEnabled};
 const search=new RetrievalSearchService(pool,projectRetrievalRegistry,{
  egressPolicy,
  queryEmbedder:new ProviderQueryEmbedder(store,{kind:'person',user_id:identity.userId},null,undefined,retrievalSettings.embeddingDimensions,egressPolicy),
  reranker:retrievalSettings.rerankEnabled?new ProviderReranker(store,{spend:{kind:'person',user_id:identity.userId},databaseUrl:config.databaseUrl,surface:'project_public_summary_brief',egressPolicy}):undefined,
  synthesizer:new ProviderSynthesizer(store,{spend:{kind:'person',user_id:identity.userId},databaseUrl:config.databaseUrl,surface:'project_public_summary_brief',egressPolicy}),
 });
 const maxResults=body.max_results??retrievalSettings.maxResultsDefault;
 const includeTrace=body.include_trace??retrievalSettings.includeTrace;
 const mode=body.mode??retrievalSettings.defaultSearchMode;
 const adaptiveReturn=body.adaptive_return??resolveRetrievalSearchControls(body,retrievalSettings).adaptiveReturn;
 const response=await search.buildBrief({spaceId:identity.spaceId,viewerUserId:identity.userId,query:body.query,objectTypes:['project_public_summary'],objectProfiles:body.object_profiles,maxResults,includeTrace,mode,useCache:retrievalSettings.useQueryCache,adaptiveReturn,rankingConfig:retrievalSettings.rankingConfig});
 if(!body.persist_artifact)return response;
 try{
  const artifactId=await persistRetrievalBriefArtifact(pool,{spaceId:identity.spaceId,ownerUserId:identity.userId,runId:null,projectId:null,query:body.query,objectTypes:['project_public_summary'],objectProfiles:body.object_profiles,maxResults,includeTrace,mode,surface:'project_public_summary_brief',response,persistTrace:false,
   egressPolicySnapshot:{external_egress_enabled:retrievalSettings.externalEgressEnabled},
   settingsSnapshot:{default_search_mode:retrievalSettings.defaultSearchMode,rerank_enabled:retrievalSettings.rerankEnabled,query_rewrite_enabled:retrievalSettings.queryRewriteEnabled,use_query_cache:retrievalSettings.useQueryCache,embedding_dimensions:retrievalSettings.embeddingDimensions,max_results_default:retrievalSettings.maxResultsDefault}});
  return {...response,artifact_id:artifactId};
 }catch(error){
  process.stderr.write(`[projects.summaryBrief] artifact persistence failed: ${String((error as Error)?.message??error)}\n`);
  return {...response,artifact_error:'retrieval_brief_persist_failed'};
 }
}
