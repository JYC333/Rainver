import {withQueryableTransaction} from '../routeUtils/common.js';
import {lockSourceRetrievalRelease} from './retrievalReleaseLocks.js';
import type {FastifyInstance} from 'fastify';
import {SOURCE_RETRIEVAL_JOB,type OperationActor,type RegisteredSystemActionDefinition,type RetrievalBriefRequest,type RetrievalObjectType,type RetrievalSearchRequest,type SourceRetrievalRequestView} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import type {ModuleContext} from '../../gateway/routeRegistry.js';
import {getDbPool} from '../../db/pool.js';
import {dbPool,params,resolveIdentity,sendRouteError,HttpError,type Queryable,type SpaceUserIdentity} from '../routeUtils/common.js';
import {isSpaceOwnerOrAdminIn} from '../routeUtils/access.js';
import type {JobHandlerRegistry} from '../jobs/handlerRegistry.js';
import {PgJobQueueRepository} from '../jobs/repository.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {hidden,markedRefusal} from '../systemActions/operations/errors.js';
import {registerOperationAdapters} from '../systemActions/operations/routeAdapter.js';
import {RetrievalProjectionService,RetrievalSearchService,persistRetrievalBriefArtifact} from '../retrieval/index.js';
import {readSpaceRetrievalSettings,resolveRetrievalSearchControls} from '../retrieval/settings.js';
import {ProviderQueryEmbedder} from '../retrieval/embedding/queryEmbedder.js';
import {ProviderQueryRewriter} from '../retrieval/queryRewriteProvider/providerQueryRewriter.js';
import {ProviderReranker} from '../retrieval/rerankProvider/providerReranker.js';
import {ProviderSynthesizer} from '../retrieval/synthesisProvider/providerSynthesizer.js';
import {enqueueRetrievalEmbeddingBackfillWithQueue} from '../retrieval/embedding/job.js';
import {resolveProviderCommandStore} from '../providers/commands/store.js';
import {executeSourceDispatch} from './sourceDispatchExecution.js';
import {sourceRetrievalRegistry} from './retrievalAdapter.js';
import {SourceQueryPreviewService} from './sourceQueryPreviewService.js';
import {SourceObjectRefusal} from './sourceObjectErrors.js';
import {runSourceRecipeRequest} from './sourceRecipeOperations.js';
import {runCustomSourceRequest} from './customSources/operations.js';

type Kind='search'|'brief'|'query_preview'|'recipe_plan'|'recipe_dry_run'|'custom_test'|'custom_repair'|'goal_preview';
const KIND:Record<string,Kind>={'source.retrieval.search.request':'search','source.retrieval.brief.request':'brief','source.query.preview':'query_preview'};
const person=(a:OperationActor)=>({spaceId:a.space_id,userId:a.on_behalf_of_user_id!});
const SOURCE_RETRIEVAL_OBJECT_TYPES=['source_item','extracted_evidence'] as const;

function sourceObjectTypes(values:RetrievalObjectType[]|undefined):RetrievalObjectType[]{
  if(!values||values.length===0)return [...SOURCE_RETRIEVAL_OBJECT_TYPES];
  if(values.some(v=>!(SOURCE_RETRIEVAL_OBJECT_TYPES as readonly string[]).includes(v)))throw new SourceObjectRefusal(422,'source retrieval only supports source_item and extracted_evidence');
  return [...new Set(values)];
}

/**
 * Source retrieval as core commands. Search, Context Brief and provider query
 * preview are request commands: admission (types, provider, credential
 * ownership, preview quota) and a single-attempt Job intent share one short
 * transaction; embedding, rewrite, rerank, synthesis and provider fetches run
 * in the Job outside any transaction, behind the Source dispatch start fence,
 * so an unknown outcome is never repeated. Reindex is DB-only: the projection
 * rebuild and its embedding backfill Job intent commit together.
 */
export function sourceRetrievalRegistrations(config:ServerConfig,definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration[]{
  const request=(id:string):OperationRegistration=>({
    definition:definitions.get(id)!,successStatus:202,
    async resolve(_db,_raw,a){return {authority:`source_retrieval:${a.space_id}`,targets:{},resourceType:id==='source.query.preview'?'source_channel':'source_item',resourceId:null};},
    // Membership is the core actor gate; every hit is revalidated for the viewer when the Job runs and again when read.
    async authorize(){},
    async authorizeResult(db,raw,a){const out=raw as {space_id:string;job_id:string};if(out.space_id!==a.space_id||!(await db.query('SELECT id FROM jobs WHERE id=$1 AND space_id=$2 AND job_type=$3 AND user_id=$4',[out.job_id,a.space_id,SOURCE_RETRIEVAL_JOB,a.on_behalf_of_user_id])).rows.length)throw hidden();},
    async execute(db,raw,a){
      const kind=KIND[id]!,input=raw as Record<string,unknown>;
      let frozen:Record<string,unknown>=input;
      if(kind==='query_preview')frozen=await new SourceQueryPreviewService(db,config).admit(person(a),input);
      else sourceObjectTypes(input.object_types as RetrievalObjectType[]|undefined);
      const job=await new PgJobQueueRepository(db).enqueue({job_type:SOURCE_RETRIEVAL_JOB,space_id:a.space_id,user_id:a.on_behalf_of_user_id!,max_attempts:1,payload:{kind,user_id:a.on_behalf_of_user_id,request:frozen}});
      return {id:job.id,space_id:a.space_id,job_id:job.id,status:'pending' as const};
    },
    classifyError(error){return error instanceof SourceObjectRefusal?markedRefusal(error,'sources'):undefined;},
  });
  return [
    request('source.retrieval.search.request'),
    request('source.retrieval.brief.request'),
    request('source.query.preview'),
    {
      definition:definitions.get('source.retrieval.reindex')!,
      async resolve(_db,_raw,a){return {authority:`source_retrieval_reindex:${a.space_id}`,targets:{},resourceType:'space',resourceId:a.space_id};},
      async authorize(db,_raw,a){if(!await isSpaceOwnerOrAdminIn(db,a.space_id,a.on_behalf_of_user_id!))throw hidden();},
      async authorizeResult(db,raw,a){if((raw as {space_id:string}).space_id!==a.space_id||!await isSpaceOwnerOrAdminIn(db,a.space_id,a.on_behalf_of_user_id!))throw hidden();},
      async execute(db,_raw,a){
        const reindexed=await new RetrievalProjectionService(db,sourceRetrievalRegistry).reindexAll(a.space_id);
        const backfill=await enqueueRetrievalEmbeddingBackfillWithQueue(new PgJobQueueRepository(db),{spaceId:a.space_id,userId:a.on_behalf_of_user_id!,trigger:'source_retrieval_reindex'});
        return {id:a.space_id,space_id:a.space_id,reindexed,embedding_backfill_job_id:backfill.jobId};
      },
    },
  ];
}

function searchService(config:ServerConfig,identity:SpaceUserIdentity,settings:Awaited<ReturnType<typeof readSpaceRetrievalSettings>>,surface:'source_search'|'source_brief'){
  const store=resolveProviderCommandStore(config),spend={kind:'person' as const,user_id:identity.userId},egressPolicy={externalEgressEnabled:settings.externalEgressEnabled};
  return new RetrievalSearchService(getDbPool(config.databaseUrl!),sourceRetrievalRegistry,{
    egressPolicy,
    queryEmbedder:new ProviderQueryEmbedder(store,spend,null,undefined,settings.embeddingDimensions,egressPolicy),
    reranker:settings.rerankEnabled?new ProviderReranker(store,{spend,databaseUrl:config.databaseUrl,surface,egressPolicy}):undefined,
    ...(surface==='source_search'
      ?{queryRewriter:settings.queryRewriteEnabled?new ProviderQueryRewriter(store,{spend,databaseUrl:config.databaseUrl,surface,egressPolicy}):undefined}
      :{synthesizer:new ProviderSynthesizer(store,{spend,databaseUrl:config.databaseUrl,surface,egressPolicy})}),
  });
}

async function runSearch(config:ServerConfig,identity:SpaceUserIdentity,body:RetrievalSearchRequest){
  const settings=await readSpaceRetrievalSettings(getDbPool(config.databaseUrl!),identity.spaceId),controls=resolveRetrievalSearchControls(body,settings);
  return searchService(config,identity,settings,'source_search').search({spaceId:identity.spaceId,viewerUserId:identity.userId,query:body.query,objectTypes:sourceObjectTypes(body.object_types),objectProfiles:body.object_profiles,maxResults:controls.maxResults,includeTrace:controls.includeTrace,feedbackSurface:'source_search',mode:controls.mode,rewrite:controls.rewrite,useCache:controls.useCache,adaptiveReturn:controls.adaptiveReturn,rankingConfig:controls.rankingConfig});
}

async function runBrief(config:ServerConfig,identity:SpaceUserIdentity,body:RetrievalBriefRequest){
  const pool=getDbPool(config.databaseUrl!),settings=await readSpaceRetrievalSettings(pool,identity.spaceId),objectTypes=sourceObjectTypes(body.object_types);
  const maxResults=body.max_results??settings.maxResultsDefault,includeTrace=body.include_trace??settings.includeTrace,mode=body.mode??settings.defaultSearchMode;
  const adaptiveReturn=body.adaptive_return??resolveRetrievalSearchControls(body,settings).adaptiveReturn;
  const response=await searchService(config,identity,settings,'source_brief').buildBrief({spaceId:identity.spaceId,viewerUserId:identity.userId,query:body.query,objectTypes,objectProfiles:body.object_profiles,maxResults,includeTrace,mode,useCache:settings.useQueryCache,adaptiveReturn,rankingConfig:settings.rankingConfig});
  if(!body.persist_artifact)return response;
  try{
    const artifactId=await persistRetrievalBriefArtifact(pool,{spaceId:identity.spaceId,ownerUserId:identity.userId,runId:null,projectId:null,query:body.query,objectTypes,objectProfiles:body.object_profiles,maxResults,includeTrace,mode,surface:'source_brief',response,
      egressPolicySnapshot:{external_egress_enabled:settings.externalEgressEnabled},
      settingsSnapshot:{default_search_mode:settings.defaultSearchMode,rerank_enabled:settings.rerankEnabled,query_rewrite_enabled:settings.queryRewriteEnabled,use_query_cache:settings.useQueryCache,embedding_dimensions:settings.embeddingDimensions,max_results_default:settings.maxResultsDefault,ranking_config:settings.rankingConfig}});
    return {...response,artifact_id:artifactId};
  }catch{return {...response,artifact_error:'retrieval_brief_persist_failed'};}
}

/** The single-attempt worker for queued Source retrieval / preview requests. */
export function registerSourceRetrievalJob(registry:JobHandlerRegistry,config:ServerConfig):void{
  if(!config.databaseUrl)return;
  registry.register(SOURCE_RETRIEVAL_JOB,async job=>{
    const user=typeof job.payload.user_id==='string'?job.payload.user_id:null;
    if(!user||user!==job.user_id)throw new Error('Invalid Source retrieval identity');
    const identity={spaceId:job.space_id,userId:user},body=job.payload.request as Record<string,unknown>;
    return executeSourceDispatch(getDbPool(config.databaseUrl!),job,async()=>{
      const kind=job.payload.kind as Kind;
      if(kind==='recipe_plan'||kind==='recipe_dry_run')return runSourceRecipeRequest(config,identity,kind,body);
      if(kind==='custom_test'||kind==='custom_repair')return runCustomSourceRequest(config,identity,kind,body);
      if(kind==='goal_preview'){const {runGoalPreviewRequest}=await import('./goals/operations.js');return runGoalPreviewRequest(config,identity,body);}
      const out=kind==='search'?await runSearch(config,identity,body as RetrievalSearchRequest):kind==='brief'?await runBrief(config,identity,body as RetrievalBriefRequest):await new SourceQueryPreviewService(getDbPool(config.databaseUrl!),config).preview(identity,body);
      return out as unknown as Record<string,unknown>;
    });
  });
}

type Ref={object_type:RetrievalObjectType;object_id:string};
const refsOf=(value:unknown):Ref[]=>Array.isArray(value)?(value as Partial<Ref>[]).filter((r):r is Ref=>typeof r?.object_type==='string'&&typeof r.object_id==='string'):[];
/**
 * A stored search/brief result released under the reader's CURRENT access. Every
 * object it names goes back through the canonical retrieval gate (adapter
 * revalidation with subscription/history and Evidence provenance, then Source
 * consent) and the released reads are audited; a stored object only leaves
 * whole and fully readable, never as a partially stripped copy. A brief is
 * rebuilt from what may still be released: once any source it was built from is
 * withheld, its synthesized answer and model-generated gap findings go too, and
 * the deterministic gap lists keep only releasable sources.
 */
async function currentResult(db:Queryable,identity:SpaceUserIdentity,kind:Kind,result:Record<string,unknown>){
  // Provider previews and recipe plans are external endpoint samples, not Space content.
  if(kind!=='search'&&kind!=='brief')return {result,withheld:0};
  const brief=kind==='brief'&&result.brief&&typeof result.brief==='object'?result.brief as Record<string,unknown>:null;
  const gaps=brief?.gap_analysis&&typeof brief.gap_analysis==='object'?brief.gap_analysis as Record<string,unknown>:null;
  const named=[...refsOf(result.items),...refsOf(result.rewrite_items),...refsOf(brief?.citations),...refsOf(gaps?.stale),...refsOf(gaps?.thin)];
  const releasable=await withQueryableTransaction(db,async tx=>{
    await lockSourceRetrievalRelease(tx,identity.spaceId,identity.userId,named);
    return new RetrievalSearchService(tx,sourceRetrievalRegistry).revalidateForRelease({spaceId:identity.spaceId,viewerUserId:identity.userId},named,kind==='brief'?'retrieval brief request read':'retrieval search request read');
  });
  const allowed=(r:Ref)=>releasable.has(`${r.object_type}:${r.object_id}`);
  const withheld=new Set(named.filter(r=>!allowed(r)).map(r=>`${r.object_type}:${r.object_id}`));
  const keep=(value:unknown)=>Array.isArray(value)?value.filter(v=>{const r=refsOf([v])[0];return r?allowed(r):false;}):value;
  const out:Record<string,unknown>={...result,items:keep(result.items)};
  if('rewrite_items' in result)out.rewrite_items=keep(result.rewrite_items);
  if(brief){
    const changed=withheld.size>0;
    out.brief={
      ...brief,
      citations:keep(brief.citations),
      ...(changed?{answer:null,synthesized:false}:{}),
      ...(gaps?{gap_analysis:{...gaps,stale:keep(gaps.stale),thin:keep(gaps.thin),...(changed?{uncited_claims:[],contradictions:[],missing_topics:[]}:{})}}:{}),
    };
  }
  delete out.trace;
  return {result:out,withheld:withheld.size};
}

/** GET /sources/retrieval/requests/:jobId — the requester's own request, released under current access. */
export function registerSourceRetrievalRoutes(app:FastifyInstance,context:ModuleContext){
  registerOperationAdapters(app,context.config,[
    {method:'POST',url:'/api/v1/sources/retrieval/search',operation:'source.retrieval.search.request'},
    {method:'POST',url:'/api/v1/sources/retrieval/brief',operation:'source.retrieval.brief.request'},
    {method:'POST',url:'/api/v1/sources/retrieval/reindex',operation:'source.retrieval.reindex'},
    {method:'POST',url:'/api/v1/sources/query-preview',operation:'source.query.preview'},
  ]);
  app.get('/api/v1/sources/retrieval/requests/:jobId',async(request,reply)=>{
    const identity=await resolveIdentity(context.config,request,reply);if(!identity)return reply;
    try{
      const db=dbPool(context.config);
      const job=(await db.query<{id:string;status:string;payload_json:{kind?:Kind};result_json:Record<string,unknown>|null}>('SELECT id,status,payload_json,result_json FROM jobs WHERE id=$1 AND space_id=$2 AND user_id=$3 AND job_type=$4',[params(request).jobId,identity.spaceId,identity.userId,SOURCE_RETRIEVAL_JOB])).rows[0];
      if(!job)throw new HttpError(404,'Source retrieval request not found');
      const kind=job.payload_json.kind??'search',status=(['pending','running','completed','failed','cancelled'].includes(job.status)?job.status:job.status==='claimed'?'running':'pending') as SourceRetrievalRequestView['status'];
      const settled=status==='completed'&&job.result_json&&job.result_json.source_dispatch!=='started'?await currentResult(db,identity,kind,job.result_json):{result:null,withheld:0};
      reply.header('cache-control','private, no-store');
      return reply.send({job_id:job.id,kind,status,result:settled.result,withheld:settled.withheld} satisfies SourceRetrievalRequestView);
    }catch(error){return sendRouteError(reply,error);}
  });
}
