import {safeBusinessCursor} from './watermark.js';
import {preflightGoalSource} from './preflight.js';
import {queueNativeSearch} from './nativeSearch.js';
import {trustedSearchMetadataOrigins} from './validation.js';
import {goalResponseDiagnostic} from './diagnostics.js';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SourcePolicyEnvelopeSchema,type SourceGoalBindingSpec,type SourceResponse} from '@rainver/protocol';
import type {ServerConfig} from '../../../config.js';
import {type Pool,type SpaceUserIdentity} from '../../routeUtils/common.js';
import {createSourceRequestBroker,SourceRequestError} from '../sourceRequestBroker.js';
import {sourceQuotaGroup} from '../sourceRequestQuota.js';
import {PgCustomSourceHandlerRepository} from '../customSources/customSourceHandlerRepository.js';
import {CustomSourceCredentialService} from '../customSources/customSourceCredentialService.js';
import {validateCustomSourceHandlerOutput} from '../customSources/customSourceContractValidator.js';
import {effectiveSourceExecutionLimits} from '../sourceExecutionPolicy.js';
import {sourceConnectorRegistry} from '../catalog/sourceConnectorRegistry.js';
import {runSourceRecipe} from '../sourceRecipes/recipeInterpreter.js';
import {sharedHostConnectionRegistry} from '../../hosts/connectionRegistry.js';
import {requireGoal,requireAuthorRun,goalSourceFingerprint,type GoalRow} from './access.js';
import type {GoalExecutionPort,GoalExecutionResult} from './service.js';
import type {OutboundGuard} from '../outboundUrlSafety.js';
export class SourceGoalExecutor implements GoalExecutionPort {
 constructor(readonly db:Pool,readonly config:ServerConfig,readonly guard?:OutboundGuard){}
 async execute(identity:SpaceUserIdentity,g:GoalRow,spec:SourceGoalBindingSpec,cursor:Record<string,unknown>,signal:AbortSignal,offlineFixture?:unknown,inspectOnly=false):Promise<GoalExecutionResult>{
  cursor=safeBusinessCursor(cursor);
  if(spec.implementation.kind==='agent_search'){signal.throwIfAborted();if(offlineFixture||inspectOnly)throw new Error('source_native_inspect_refused');return queueNativeSearch(this.db,this.config,identity,g,spec,cursor);}
  const c=await preflightGoalSource(this.db,this.config,identity,g,spec);if(g.execution_authority && goalSourceFingerprint(c)!==g.execution_authority)throw new Error('source_authority_revoked');const settings=await new PgCustomSourceHandlerRepository(this.db,this.config).getEffectiveSettings(identity);
  if(!settings.runner.runner_enabled)throw new Error('source_runner_disabled');
  const version=await this.db.query(`SELECT policy_envelope_json FROM source_recipe_versions WHERE id=$1 AND source_connection_id=$2 AND status='active' UNION ALL SELECT policy_envelope_json FROM source_handler_versions WHERE id=$3 AND source_connection_id=$2 AND status='active'`,[c.active_recipe_version_id,c.id,c.active_handler_version_id]);
  const connector=sourceConnectorRegistry.get(c.connector_key);
  if(c.connector_key==='brave_web_search_api'&&!c.credential_id)throw new Error('source_credential_unavailable');
  if(connector.getCapabilities().supports_search&&(!c.provider_query_json||!Object.keys(c.provider_query_json as object).length))throw new Error('source_search_query_unavailable');
  const channel={endpoint_url:c.endpoint_url,compiled_query:c.provider_query_json};
  const initialRequest=connector.buildScanRequest(channel,{});
  const endpoint=new URL(initialRequest.url);
  const defaults={allowed_network_origins:[endpoint.origin],capture_policy:c.capture_policy,retention_policy:'metadata_only',credential_ref:c.credential_id,limits:{timeout_ms:10000,max_download_bytes:1048576,max_output_bytes:1048576,max_items:g.budget_json.items_per_source,max_files:1,max_evidence_items:100,log_max_bytes:1}};
  const envelope=SourcePolicyEnvelopeSchema.parse(version.rows[0]?.policy_envelope_json??defaults);
  // Existing approvals define reach. Goal/repair JSON cannot author an envelope.
  if(!envelope.allowed_network_origins.includes(endpoint.origin))throw new Error('source_scope_refused');
  if(envelope.credential_ref!==c.credential_id)throw new Error('source_credential_scope_changed');
  if(c.credential_id && !settings.space.credentialed_sources_allowed)throw new Error('source_credential_scope_changed');
  if(spec.implementation.kind==='isolated' && !settings.runner.allowed_languages.includes('typescript_node'))throw new Error('source_language_refused');
  if(c.credential_id)await new CustomSourceCredentialService(this.db,this.config).requireOwnCredential(identity,c.credential_id);
  const limits=effectiveSourceExecutionLimits(settings.runner,envelope.limits);
  if(settings.space.allowed_domains.length && !settings.space.allowed_domains.some(d=>endpoint.hostname===d || endpoint.hostname.endsWith('.'+d)))throw new Error('source_scope_refused');
  if(settings.runner.network_hard_deny_rules.length)throw new Error('source_network_policy_requires_review');
  let authorizeHost:undefined|(()=>Promise<void>);
  const authorize=async()=>{
   signal.throwIfAborted();if(g.execution_repair_binding&&g.execution_scope)await requireAuthorRun(this.db,g,g.execution_scope,'repair',g.execution_repair_binding);await authorizeHost?.();const latest=await new PgCustomSourceHandlerRepository(this.db,this.config).getEffectiveSettings(identity);
   if(c.credential_id && !latest.space.credentialed_sources_allowed || spec.implementation.kind==='isolated' && !latest.runner.allowed_languages.includes('typescript_node'))throw new Error('source_authority_revoked');
   if(!latest.runner.runner_enabled || latest.runner.output_bytes_max<limits.max_output_bytes || latest.runner.timeout_ms_max<limits.timeout_ms || latest.runner.max_files<limits.max_files || latest.runner.network_hard_deny_rules.length || latest.runner.download_bytes_max<limits.max_download_bytes || latest.space.allowed_domains.length && !latest.space.allowed_domains.some(d=>endpoint.hostname===d || endpoint.hostname.endsWith('.'+d)))throw new Error('source_authority_revoked');
   const current=await requireGoal(this.db,identity,g.id,true);
   if(g.execution_repair_binding&&current.active_version_id!==g.active_version_id)throw new Error('source_authority_revoked');
   if(['paused','deleted'].includes(current.status))throw new Error('source_authority_revoked');
   const live=await preflightGoalSource(this.db,this.config,identity,{...current,execution_search_path:g.execution_search_path},spec);
   if(goalSourceFingerprint(live)!==goalSourceFingerprint(c))throw new Error('source_authority_revoked');
  };
  const broker=createSourceRequestBroker(this.db,{
   scopeId:`goal:${g.id}:${c.id}:${g.revision}`,quotaGroup:sourceQuotaGroup(`${c.owner_user_id}:${c.provider_connector_id}`,'account'),
   quota:[{window:'minute',limit:10},{window:'day',limit:100}],
   endpointQuotas:[...(c.credential_id?[{key:sourceQuotaGroup(c.credential_id,'credential-account'),windows:[{window:'minute' as const,limit:10},{window:'day' as const,limit:100}]}]:[]),{key:sourceQuotaGroup(`${g.execution_scope??g.id}:${c.id}`,'execution-budget'),windows:[{window:'day',limit:g.budget_json.requests_per_run}]},{key:sourceQuotaGroup(`${c.owner_user_id}:${c.provider_connector_id}`,endpoint.origin),windows:[{window:'minute',limit:10},{window:'day',limit:100}]}],
   routes:[{origin:endpoint.origin,path_prefix:endpoint.pathname,methods:['GET','HEAD'],query_keys:[...endpoint.searchParams.keys()],
    ...(c.credential_id?{credentialHeaders:async()=>{const h=await new CustomSourceCredentialService(this.db,this.config).resolveCredentialHeader(identity.spaceId,c.credential_id);if(!h)throw new Error('Credential unavailable');return {[h.header_name]:h.header_value};}}:{})}],
   maxBytes:Math.min(8*1024*1024,limits.max_download_bytes),deadlineMs:Math.min(120000,limits.timeout_ms),authorize,
  },signal,this.guard);
  let sends=0;const captures:SourceResponse[]=[];
  const fetch=async(url:string,s:AbortSignal)=>{
   s.throwIfAborted();
   if(++sends>g.budget_json.requests_per_run)throw new Error('source_request_limit');
   await authorize();
   const response=offlineFixture? (offlineFixture as {responses:SourceResponse[]}).responses[sends-1]:await broker({sequence:sends,url,method:'GET'},s);
   if(!response)throw new Error('source_fixture_request_missing');
   if(offlineFixture && new URL(response.final_url??url).origin!==endpoint.origin)throw new Error('source_fixture_scope_refused');
   if(response.retry_at || response.status===429)throw new SourceRequestError('source_quota_exhausted',response.retry_at);
   if(response.status>=500)throw new Error('source_network_failed');
   if(response.status>=400)throw new Error('source_upstream_refused');
   if(captures.reduce((n,r)=>n+Buffer.byteLength(r.body_base64),0)+Buffer.byteLength(response.body_base64)>1500000)throw new Error('source_fixture_limit');
   captures.push(response);return response;
  };
  let filesRoot=await mkdtemp(join(tmpdir(),'source-goal-'));
  try{
   let selection:GoalExecutionResult['selection'];let output:unknown;let nextCursor:Record<string,unknown>={};
   if(spec.implementation.kind==='isolated'){
    if(createHash('sha256').update(spec.implementation.code).digest('hex')!==spec.implementation.sha256)throw new Error('source_version_mismatch');
    // Server chooses an owner-authorized Host, never a Host supplied by model JSON.
    const host=await this.db.query(`SELECT id FROM hosts WHERE (owner_user_id=$1 OR kind='server') AND status='online' AND capabilities_json->>'sources_execution'='isolated-v1' ORDER BY created_at,id LIMIT 1`,[g.owner_user_id]);
    if(!host.rows[0])throw new Error('source_isolation_unavailable');
    authorizeHost=async()=>{const h=await this.db.query(`SELECT 1 FROM hosts WHERE id=$1 AND (owner_user_id=$2 OR kind='server') AND status='online' AND capabilities_json->>'sources_execution'='isolated-v1'`,[host.rows[0].id,g.owner_user_id]);if(!h.rows[0])throw new Error('source_host_authority_revoked');};
    const bound=Object.assign(async(raw:{url:string},s:AbortSignal)=>fetch(raw.url,s),{scopeSha256:broker.scopeSha256,authorizeExecution:async(s:AbortSignal)=>{s.throwIfAborted();await authorize();const h=await this.db.query(`SELECT 1 FROM hosts WHERE id=$1 AND (owner_user_id=$2 OR kind='server') AND status='online'`,[host.rows[0].id,g.owner_user_id]);if(!h.rows[0])throw new Error('source_host_authority_revoked');}});
    const result=await sharedHostConnectionRegistry.executeSource(host.rows[0].id,{execution_id:randomUUID(),code:spec.implementation.code,version_sha256:spec.implementation.sha256,input_json:JSON.stringify({cursor,endpoint_url:initialRequest.url}),limits:{wall_ms:Math.min(300000,limits.timeout_ms),memory_bytes:268435456,cpu_quota_percent:50,processes:32,output_bytes:Math.min(8388608,limits.max_output_bytes),requests:g.budget_json.requests_per_run}},bound,signal);
    await bound.authorizeExecution(signal);
    if(result.status!=='succeeded')throw new SourceRequestError(result.error??'source_execution_failed',result.retry_at);
    const raw=JSON.parse(result.output_json!);output={...raw,contract_version:'custom_source.handler_output.v1'};nextCursor=raw.cursor??{};
   }else{
    const handler=connector;
    if(cursor.__goal_history===true && !handler.getCapabilities().supports_date_range && !handler.getCapabilities().supports_all_history)throw new Error('source_history_unavailable');
    const request=cursor.__goal_history===true?handler.buildBackfillRequest(channel,{...((cursor.__goal_window??{}) as Record<string,unknown>),from:(cursor.__goal_window as {since?:unknown})?.since,to:(cursor.__goal_window as {until?:unknown})?.until,max_items:g.budget_json.items_per_source},cursor):handler.buildScanRequest(channel,{...cursor,last_published_at:cursor.watermark??cursor.last_published_at});
    if(!offlineFixture)await handler.prepareRequest?.();
    const response=await fetch(request.url,signal);const text=Buffer.from(response.body_base64,'base64').toString('utf8');
    if(inspectOnly){output={contract_version:'custom_source.handler_output.v1',items:[]};}
    else if(spec.implementation.kind==='connector'){
     const items=handler.parseResponse(text);nextCursor=handler.parseCursor?.(text)??{};
     const normalized=items.map(i=>({external_id:i.externalId,title:i.title,source_uri:i.sourceUri??i.canonicalUri!,published_at:i.occurredAt,author:i.author,excerpt:i.excerpt,metadata:i.metadata,snapshots:[],evidence:[]}));
     if(cursor.__goal_history===true && handler.getCapabilities().supports_date_range)nextCursor={...nextCursor,history_window:{...(cursor.__goal_window as object),exhausted:normalized.length<g.budget_json.items_per_source}};
     output={contract_version:'custom_source.handler_output.v1',cursor:nextCursor,items:normalized};
    }else{
     const run=await runSourceRecipe(settings.runner,{policyEnvelope:envelope,recipe:spec.implementation.recipe,mode:'scan',endpointUrl:c.endpoint_url,sourceName:c.name,primaryEndpointContent:text,controlledFetch:async(url,s)=>{const r=await fetch(url,s);return {url:r.final_url??url,status:r.status,ok:r.status<400,headers:new Headers({'content-type':r.content_type,...r.headers}),bytes:Buffer.from(r.body_base64,'base64'),truncated:false};}});
     await rm(filesRoot,{recursive:true,force:true});filesRoot=run.sandbox_files_root;
     if(run.status!=='succeeded')throw new Error('source_parser_failed');output=JSON.parse(run.raw_output_json!);nextCursor={...((output as {cursor?:Record<string,unknown>}).cursor??{}),...(run.warnings.includes('source_recipe_items_truncated')?{coverage:'recipe_truncated',unrecoverable_remainder:true}:{})};
    }
   }
   if(!inspectOnly){const checked=await validateCustomSourceHandlerOutput({raw:output,limits:{...limits,max_items:Math.max(limits.max_items,(output as {items:unknown[]}).items?.length??0)},allowedNetworkOrigins:envelope.allowed_network_origins,metadataOnlyOrigins:trustedSearchMetadataOrigins(c.connector_key,spec.implementation,output),sandboxFilesRoot:filesRoot});if(!checked.ok)throw new Error('source_parser_validation_failed');}
   await authorize();return {selection,output,fixture:{responses:captures},source_kind:spec.implementation.kind==='connector'&&connector.getCapabilities().supports_search?'search':captures[0]?.content_type.includes("json")?"api":captures[0]?.content_type.includes("html")?"html":captures[0]?.content_type.includes("xml")?"feed":c.connector_key,cursor:nextCursor,filesRoot,envelope,cleanup:()=>rm(filesRoot,{recursive:true,force:true})};
  }catch(error){if(error instanceof Error && captures.length)Object.defineProperty(error,'sourceDiagnostic',{value:{capture_policy:envelope.capture_policy,retention_policy:envelope.retention_policy,code:/^source_[a-z_]+$/.test(error.message)?error.message:'source_execution_failed',responses:captures.map(goalResponseDiagnostic),fixture:{responses:captures}},enumerable:false});await rm(filesRoot,{recursive:true,force:true});if(signal.aborted)throw new SourceRequestError(signal.reason?.name==='TimeoutError'?'source_timeout':'source_cancelled');throw error;}
 }
}
