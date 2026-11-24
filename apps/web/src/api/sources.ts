import type {
  CustomSourceActivationResult,
  CustomSourceCredentialDTO,
  CustomSourceHandlerRun,
  CustomSourceHandlerSummary,
  CustomSourceHandlerVersion,
  CustomSourceInstanceRunnerSettings,
  CustomSourceInstanceRunnerSettingsUpdate,
  CustomSourceSpacePolicy,
  CustomSourceSpacePolicyUpdate,
  CustomSourceTestOutcome,
  EvidenceLink,
  ExtractedEvidence,
  ExtractionJob,
  FollowedSourceChannel,
  InformationDigestBackfillResult,
  InformationDigestLookup,
  InterestProfileSnapshot,
  Page,
  ProjectSourceBinding,
  ProjectSourceItem,
  ProjectSourceSummary,
  SerendipityFeedbackResult,
  SourceAnnotationEpisode,
  SourceBackfillPlan,
  SourceBackfillPreview,
  SourceBackfillQuotaPolicy,
  SourceBackfillStrategy,
  SourceCatalog,
  SourceCatalogMapping,
  SourceCatalogProvider,
  SourceChannel,
  SourceConnector,
  SourceHealth,
  SourceItem,
  SourcePostProcessingBacklog,
  SourcePostProcessingBriefingDaySummary,
  SourcePostProcessingBriefingDetail,
  SourcePostProcessingDecisionReviewStatus,
  SourcePostProcessingItemDecision,
  SourcePostProcessingItemRelevance,
  SourcePostProcessingRule,
  SourcePostProcessingRuleCreate,
  SourcePostProcessingRuleUpdate,
  SourcePostProcessingRun,
  SourceProvider,
  SourceQueryPreview,
  SourceRecipeActivationResult,
  SourceRecipeCreateRequest,
  SourceRecipeCreateResponse,
  SourceRecipeDryRunResponse,
  SourceRecipePipelineBridgeRequest,
  SourceRecipePlanResponse,
  SourceRecipeVersion,
  SourceRecommendation,
  SourceScheduleRule,
} from '../types/api'
import { waitForJobResult, waitForSourceRequest } from './jobReads'
import { callOperation, commandReceipt, operationAt, queryAt, queryOperation } from './operations'
import type { RequestOptions } from './transport'
import { ApiRequestError, get } from './transport'
import type {
  Briefing,
  BriefingAdoptionPreview,
  BriefingFollowUpPreview,
  BriefingOverviewResponse,
  MonitoringVersion,
  OperationInput,
  ProjectMonitoringConfig,
  ProjectMonitoringState,
  ReadingPage,
  ReadingQuery,
  ReadingStateRequest,
} from '@rainver/protocol'

/** One explicit-key Source command. A structured refusal code (for example
 * `source_retention_policy` or `reading_version_changed`) becomes the error's
 * `code`, so callers act on it rather than on prose. */
const receiptState=<T extends {id:string;space_id:string}>({id:_id,space_id:_space,...state}:T)=>state;

async function sourceObjectCall<Id extends import('@rainver/protocol').OperationId>(id:Id,input:import('@rainver/protocol').OperationInput<Id>,key:string,options:RequestOptions={}){
 try{const result=await callOperation(id,input,key,options);if(!('status' in result)||result.status!=='succeeded')throw new Error('Source action did not complete');return result.data;}
 catch(e){if(e instanceof ApiRequestError){const metadata=(e.payload?.error as {metadata?:Record<string,unknown>}|undefined)?.metadata;if(metadata&&typeof metadata.code==='string')throw new ApiRequestError(e.message,e.status,metadata.code,metadata);}throw e;}
}

async function currentSourceItem(receipt:{id:string;space_id:string}){return get<SourceItem>(`/sources/items/${encodeURIComponent(receipt.id)}`,{spaceId:receipt.space_id});}

// ── Source / Evidence ────────────────────────────────────────────────────
/** Project briefings: reads never generate; generating, cancelling and the daily setting need Project write access. */
/** The caller's own personal briefing in this Space (never another person's). */
export const personalBriefingsApi = {
  overview: (spaceId: string, options: RequestOptions = {}) =>
    get<BriefingOverviewResponse>(`/spaces/${encodeURIComponent(spaceId)}/information-briefings/personal`, options),
  get: (spaceId: string, briefingId: string, options: RequestOptions = {}) =>
    get<Briefing>(`/spaces/${encodeURIComponent(spaceId)}/information-briefings/personal/${encodeURIComponent(briefingId)}`, options),
  generate: (spaceId: string, key: string = crypto.randomUUID()) =>
    commandReceipt('briefing.personal.request', {space_id:spaceId}, key, {spaceId}),
  cancel: (spaceId: string, briefingId: string, key: string = crypto.randomUUID()) =>
    commandReceipt('briefing.personal.cancel', {space_id:spaceId,briefing_id:briefingId}, key, {spaceId}),
  setDaily: async (spaceId: string, daily_enabled: boolean, key: string = crypto.randomUUID()) => {
    const result = await commandReceipt('briefing.personal.settings.set', { space_id: spaceId, daily_enabled }, key, { spaceId })
    return { daily_enabled: result.daily_enabled }
  },
  followUp: (spaceId: string, briefingId: string, index: number) =>
    queryAt<BriefingFollowUpPreview>(`/spaces/${encodeURIComponent(spaceId)}/information-briefings/personal/${encodeURIComponent(briefingId)}/highlights/${index}/follow-up`, {},{spaceId}),
  previewAdoption: (spaceId: string, briefingId: string, index: number) =>
    queryAt<BriefingAdoptionPreview>(`/spaces/${encodeURIComponent(spaceId)}/information-briefings/personal/${encodeURIComponent(briefingId)}/highlights/${index}/adoption/preview`, {},{spaceId}),
  adopt: (spaceId: string, briefingId: string, index: number, preview_hash: string, key:string=crypto.randomUUID()) =>
    commandReceipt('briefing.personal.adoption.confirm',{space_id:spaceId,briefing_id:briefingId,index,preview_hash},key,{spaceId}),
}

/** Retained historical Project highlights; every read reauthorizes the whole audience. */
export const projectBriefingHighlightsApi={
 followUp:(spaceId:string,projectId:string,briefingId:string,index:number)=>queryAt<BriefingFollowUpPreview>(`/spaces/${encodeURIComponent(spaceId)}/projects/${encodeURIComponent(projectId)}/information-briefings/${encodeURIComponent(briefingId)}/highlights/${index}/follow-up`,{},{spaceId}),
 previewAdoption:(spaceId:string,projectId:string,briefingId:string,index:number)=>queryAt<BriefingAdoptionPreview>(`/spaces/${encodeURIComponent(spaceId)}/projects/${encodeURIComponent(projectId)}/information-briefings/${encodeURIComponent(briefingId)}/highlights/${index}/adoption/preview`,{},{spaceId}),
 adopt:(spaceId:string,projectId:string,briefingId:string,index:number,preview_hash:string,key:string=crypto.randomUUID())=>commandReceipt('briefing.project.adoption.confirm',{space_id:spaceId,project_id:projectId,briefing_id:briefingId,index,preview_hash},key,{spaceId}),
};

export const informationDigestsApi = {
  reading: (spaceId: string, input: Partial<ReadingQuery> = {}, projectId?: string, options: RequestOptions = {}) => {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(input)) if (value !== undefined) search.set(key, String(value))
    const scope = projectId ? `/projects/${encodeURIComponent(projectId)}` : ''
    return get<ReadingPage>(`/spaces/${encodeURIComponent(spaceId)}${scope}/reading?${search}`, { ...options, spaceId })
  },
  readingPreference: (spaceId: string, projectId: string) =>
    get<{ show_in_my_reading: boolean }>(`/spaces/${encodeURIComponent(spaceId)}/projects/${encodeURIComponent(projectId)}/reading-preference`),
  setReadingPreference: async (spaceId: string, projectId: string, show_in_my_reading: boolean, key: string = crypto.randomUUID()) => {
    const result = await commandReceipt('reading.preference.set', { space_id: spaceId, project_id: projectId, show_in_my_reading }, key, { spaceId })
    return { show_in_my_reading: result.show_in_my_reading }
  },
  readingState: async (spaceId: string, itemId: string, body: ReadingStateRequest, projectId?: string, key: string = crypto.randomUUID()) => {
    const result = projectId
      ? await commandReceipt('reading.project_state.set', { ...body, space_id: spaceId, project_id: projectId, item_id: itemId }, key, { spaceId })
      : await commandReceipt('reading.personal_state.set', { ...body, space_id: spaceId, item_id: itemId }, key, { spaceId })
    return { updated: result.updated }
  },
  /** Read-only: the day's snapshot, or `missing`. Without a date, the latest complete day of the digest's timezone. */
  personal: (spaceId: string, date?: string) => {
    const q = date ? `?date=${encodeURIComponent(date)}` : ''
    return get<InformationDigestLookup>(`/spaces/${encodeURIComponent(spaceId)}/information-digests/personal${q}`)
  },
  project: (spaceId: string, projectId: string, date?: string, options: RequestOptions = {}) => {
    const q = date ? `?date=${encodeURIComponent(date)}` : ''
    return get<InformationDigestLookup>(`/spaces/${encodeURIComponent(spaceId)}/projects/${encodeURIComponent(projectId)}/information-digests${q}`, options)
  },
  /** Builds a missing complete day once; never rewrites an existing snapshot. */
  backfillPersonal: async (spaceId: string, date: string, key:string=crypto.randomUUID()):Promise<InformationDigestBackfillResult> => {
    const receipt=await commandReceipt('digest.personal.backfill',{space_id:spaceId,date},key,{spaceId});
    const result=await waitForJobResult<{digest_id:string;created:boolean}>(receipt,'Digest backfill');
    const current=await informationDigestsApi.personal(spaceId,date);
    if(current.status!=='available'||current.digest.id!==result.digest_id)throw new Error('Digest is unavailable');
    return {digest:current.digest,created:result.created};
  },
  backfillProject: async (spaceId: string, projectId: string, date: string, key:string=crypto.randomUUID()):Promise<InformationDigestBackfillResult> => {
    const receipt=await commandReceipt('digest.project.backfill',{space_id:spaceId,project_id:projectId,date},key,{spaceId});
    const result=await waitForJobResult<{digest_id:string;created:boolean}>(receipt,'Digest backfill');
    const current=await informationDigestsApi.project(spaceId,projectId,date);
    if(current.status!=='available'||current.digest.id!==result.digest_id)throw new Error('Digest is unavailable');
    return {digest:current.digest,created:result.created};
  },
  /** The caller's own Source annotation failure episodes. */
  annotationEpisodes: (spaceId: string) =>
    get<{ episodes: SourceAnnotationEpisode[] }>(`/spaces/${encodeURIComponent(spaceId)}/source-annotation/episodes`),
  retryAnnotation: (spaceId: string, body: { episode_id?: string; connection_id?: string } = {}, key:string=crypto.randomUUID()):Promise<{reopened:number}> =>
    commandReceipt('reading.annotation.retry',{...body,space_id:spaceId},key,{spaceId}),
  profile: (spaceId: string) =>
    get<InterestProfileSnapshot>(`/spaces/${encodeURIComponent(spaceId)}/interest-profile`),
  acceptCandidate: async (spaceId: string, phraseKey: string, body: { label?: string; domain_key?: string }, key: string = crypto.randomUUID()) =>
    (await commandReceipt('interest.candidate.accept',{space_id:spaceId,phrase_key:phraseKey,...body},key)).topic,
  dismissCandidate: async (spaceId: string, phraseKey: string, key: string = crypto.randomUUID()) => {
    const r=await commandReceipt('interest.candidate.dismiss',{space_id:spaceId,phrase_key:phraseKey},key);return {dismissed:r.dismissed};
  },
  updateProfileSettings: async (spaceId: string, body: Partial<InterestProfileSnapshot['settings']>, key: string = crypto.randomUUID()) => {
    const r=await commandReceipt('interest.settings.update',{space_id:spaceId,...body},key);return {settings:r.settings};
  },
  createTopic: async (spaceId: string, body: { label: string; domain_key: string; weight: number }, key: string = crypto.randomUUID()) =>
    (await commandReceipt('interest.topic.create',{space_id:spaceId,...body},key)).topic,
  updateTopic: async (spaceId: string, topicKey: string, body: { label: string; domain_key: string; weight: number }, key: string = crypto.randomUUID()) =>
    (await commandReceipt('interest.topic.update',{space_id:spaceId,topic_key:topicKey,...body},key)).topic,
  archiveTopic: async (spaceId: string, topicKey: string, key: string = crypto.randomUUID()) => {
    const r=await commandReceipt('interest.topic.archive',{space_id:spaceId,topic_key:topicKey},key);return {archived:r.archived};
  },
  applyStarterPack: async (spaceId: string, pack: 'technology'|'science'|'world', key: string = crypto.randomUUID()) => {
    const r=await commandReceipt('interest.starter_pack.apply',{space_id:spaceId,key:pack},key);return {topics:r.topics,source_recommendations:r.source_recommendations};
  },
  backfillProfileHistory: async (spaceId: string, limit=500, key: string = crypto.randomUUID()) => {
    const r=await commandReceipt('interest.history.backfill',{space_id:spaceId,limit},key);return {queued:r.queued,limit:r.limit};
  },
  serendipityFeedback: async (spaceId: string, itemId: string, feedback: 'interesting' | 'neutral' | 'never', key: string = crypto.randomUUID()): Promise<SerendipityFeedbackResult> => {
    const {space_id: _space,user_id: _user,...result}=await commandReceipt('digest.serendipity.feedback',{space_id:spaceId,item_id:itemId,feedback},key);return result;
  },
}

export const sourcesApi = {
  materialProcessing: (itemId:string,options?:RequestOptions)=>get<import('@rainver/protocol').SourceMaterialProcessingState>(`/sources/items/${itemId}/processing`,options),
  /** Shows the named version of this material's literal Agent text as Markdown: a new version through the canonical writer (one material, on request; 409 if the shown version changed). */
  /** Material commands: one explicit key per attempt; the processing state is reread through materialProcessing. */
  showAgentTextAsMarkdown:async(itemId:string,shown:{artifact_id:string;source_snapshot_id:string|null},options:RequestOptions={},key:string=crypto.randomUUID())=>({artifact_id:(await sourceObjectCall('source.material.show_markdown',{source_item_id:itemId,syntax:'markdown',...shown},key,options)).artifact_id}),
  prepareMaterial:async(itemId:string,selection:Omit<OperationInput<'source.material.start'>,'source_item_id'>={},options:RequestOptions={},key:string=crypto.randomUUID()):Promise<import('@rainver/protocol').SourceMaterialProcessingState>=>receiptState(await sourceObjectCall('source.material.start',{...selection,source_item_id:itemId},key,options)),
  cancelMaterialProcessing:async(itemId:string,options:RequestOptions={},key:string=crypto.randomUUID()):Promise<import('@rainver/protocol').SourceMaterialProcessingState>=>receiptState(await sourceObjectCall('source.material.cancel',{source_item_id:itemId},key,options)),
  requestMaterialStorage:async(itemId:string,options:RequestOptions={},key:string=crypto.randomUUID()):Promise<{proposal_id?:string;source_name?:string;allowed?:boolean}>=>receiptState(await sourceObjectCall('source.material.request_storage',{source_item_id:itemId},key,options)),
  providers: (options?: RequestOptions) => get<SourceProvider[]>('/sources/providers', options),
  sourceCatalog: () => get<SourceCatalog>('/instance/source-catalog'),
  updateCatalogProvider: (id: string, body: { status?: 'active' | 'disabled' }, key: string = crypto.randomUUID()) =>
    operationAt<SourceCatalogProvider>('PATCH', `/instance/source-catalog/providers/${encodeURIComponent(id)}`, body, key),
  updateCatalogConnector: (id: string, body: { status?: 'active' | 'disabled' }, key: string = crypto.randomUUID()) =>
    operationAt<SourceConnector>('PATCH', `/instance/source-catalog/connectors/${encodeURIComponent(id)}`, body, key),
  updateCatalogMapping: (id: string, body: { status?: 'active' | 'disabled'; priority?: number }, key: string = crypto.randomUUID()) =>
    operationAt<SourceCatalogMapping>('PATCH', `/instance/source-catalog/mappings/${encodeURIComponent(id)}`, body, key),
  channels: (params: { status?: string; provider_key?: string } = {}, options?: RequestOptions) => {
    const q = new URLSearchParams()
    if (params.status) q.set('status', params.status)
    if (params.provider_key) q.set('provider_key', params.provider_key)
    const suffix = q.toString() ? `?${q.toString()}` : ''
    return get<SourceChannel[]>(`/sources/channels${suffix}`, options)
  },
  recommendations: () => get<SourceRecommendation[]>('/sources/recommendations'),
  followed: (options?: RequestOptions) => get<FollowedSourceChannel[]>('/sources/followed', options),
  decideRecommendation: async (channelId:string,decision:'subscribed'|'dismissed'|'muted',key:string=crypto.randomUUID()) => {
    const result=await callOperation('source.recommendation.decide',{source_channel_id:channelId,decision},key);
    if(!('status' in result)||result.status!=='succeeded')throw new Error('Source recommendation decision did not complete');
    return result.data;
  },
  /** Leave (`muted`) or rejoin (`subscribed`) a channel; what was delivered while subscribed stays readable. */
  setChannelSubscription: async (channelId:string,status:'subscribed'|'muted',key:string=crypto.randomUUID()) => {
    const result=await callOperation('source.channel.set_subscription',{source_channel_id:channelId,status},key);
    if(!('status' in result)||result.status!=='succeeded')throw new Error('Source subscription did not complete');
    return result.data;
  },
  customSourceCredentials: () => get<CustomSourceCredentialDTO[]>('/sources/custom-source-credentials'),
  getChannel: (id: string) => get<SourceChannel>(`/sources/channels/${id}`),
  createChannel: async (body:OperationInput<'source.channel.create'>,options:RequestOptions={},key:string=crypto.randomUUID()):Promise<SourceChannel> => {
    const result=await callOperation('source.channel.create',body,key,options);
    if(!('status' in result)||result.status!=='succeeded')throw new Error('Source Monitor creation did not complete');
    return result.data;
  },
  /** Queues one provider preview (quota spent at admission), then reads its result through the Source request reader; never resubmits. */
  previewQuery: async (body: OperationInput<'source.query.preview'>, key: string = crypto.randomUUID()): Promise<SourceQueryPreview> =>
    (await waitForSourceRequest(await sourceObjectCall('source.query.preview', body, key), 'Query preview')) as unknown as SourceQueryPreview,
  updateChannel: async (id:string,body:OperationInput<'source.channel.update'>['changes'],key:string=crypto.randomUUID()) => {
    const result=await callOperation('source.channel.update',{source_channel_id:id,changes:body},key);
    if(!('status' in result)||result.status!=='succeeded')throw new Error('Source Monitor update did not complete');
    return result.data;
  },
  scanChannel: async (id:string,options:RequestOptions={},key:string=crypto.randomUUID()) => {
    const result=await callOperation('source.channel.scan',{source_channel_id:id},key,options);
    if(!('status' in result)||result.status!=='succeeded')throw new Error('Source Monitor scan was not queued');
    return result.data;
  },
  previewChannelBackfill: async (channelId: string, body: { strategy: Partial<SourceBackfillStrategy>; quota_policy?: Partial<SourceBackfillQuotaPolicy> }):Promise<SourceBackfillPreview> => {
    const result=await queryOperation('source.backfill.preview',{...body,source_channel_id:channelId});
    if(!('status' in result)||result.status!=='succeeded')throw new Error('Backfill preview unavailable');
    return result.data;
  },
  createChannelBackfillPlan: async (channelId: string, body: { idempotency_key: string; strategy: Partial<SourceBackfillStrategy>; quota_policy?: Partial<SourceBackfillQuotaPolicy>; project_source_binding_id?: string; project_operation_id?: string },key:string=crypto.randomUUID()) => {
    const result=await callOperation('source.backfill.create_plan',{...body,source_channel_id:channelId},key);
    if(!('status' in result)||result.status!=='succeeded')throw new Error('Backfill plan unavailable');
    return get<SourceBackfillPlan>(`/sources/channels/${encodeURIComponent(channelId)}/backfill/plans/${encodeURIComponent(result.data.plan_id)}`);
  },
  channelBackfillPlans: (channelId: string) => get<SourceBackfillPlan[]>(`/sources/channels/${channelId}/backfill/plans`),
  /** Draft creation through core (access-owner placement); the Monitor is reread through its authorized reader. */
  createCustomSourceDraft: async (body: OperationInput<'source.custom.draft.create'>, key: string = crypto.randomUUID()): Promise<SourceChannel> => {
    const receipt = await sourceObjectCall('source.custom.draft.create', body, key)
    return { ...(await get<SourceChannel>(`/sources/channels/${encodeURIComponent(receipt.source_channel_id!)}`, { spaceId: receipt.space_id })), id: receipt.id, source_channel_id: receipt.source_channel_id } as SourceChannel
  },
  customSourceSummary: (connectionId: string) =>
    get<CustomSourceHandlerSummary>(`/sources/connections/${connectionId}/custom-source`),
  customSourceVersions: (connectionId: string, params: { limit?: number; offset?: number } = {}) => {
    const q: Record<string, string> = {}
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<Page<CustomSourceHandlerVersion>>(`/sources/connections/${connectionId}/handler-versions?` + new URLSearchParams(q))
  },
  customSourceRuns: (connectionId: string, params: { limit?: number; offset?: number } = {}) => {
    const q: Record<string, string> = {}
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<Page<CustomSourceHandlerRun>>(`/sources/connections/${connectionId}/handler-runs?` + new URLSearchParams(q))
  },
  /** Queues the handler test (it executes externally) and waits; the run is reread through the handler-run reader. */
  testCustomSourceHandler: async (connectionId: string, body: { handler_version_id: string; fixture_html?: string }, key: string = crypto.randomUUID()): Promise<CustomSourceTestOutcome> => {
    const done = await waitForSourceRequest(await sourceObjectCall('source.custom.handler.test.request', { ...body, source_connection_id: connectionId }, key), 'Handler test')
    return get<CustomSourceTestOutcome>(`/sources/connections/${encodeURIComponent(connectionId)}/handler-runs/${encodeURIComponent(String(done.run_id))}`)
  },
  activateCustomSourceHandler: async (connectionId: string, body: { handler_version_id: string; next_check_at?: string | null; schedule_rule?: SourceScheduleRule | null }, key: string = crypto.randomUUID()): Promise<CustomSourceActivationResult> => {
    const receipt = await sourceObjectCall('source.custom.handler.activate', { ...body, schedule_rule: body.schedule_rule as Record<string, unknown> | null | undefined, source_connection_id: connectionId }, key)
    const handler_version = await get<CustomSourceActivationResult['handler_version']>(`/sources/connections/${encodeURIComponent(connectionId)}/handler-versions/${encodeURIComponent(receipt.handler_version_id)}`)
    return { status: receipt.status, deltas: receipt.deltas, proposal_id: receipt.proposal_id, handler_version } as CustomSourceActivationResult
  },
  customSourceSpacePolicy: () =>
    get<CustomSourceSpacePolicy>('/sources/custom-source-settings/space'),
  customSourceInstanceRunnerSettings: () =>
    get<CustomSourceInstanceRunnerSettings>('/sources/custom-source-settings/instance'),
  updateCustomSourceInstanceRunnerSettings: async (body: CustomSourceInstanceRunnerSettingsUpdate, key: string = crypto.randomUUID()): Promise<CustomSourceInstanceRunnerSettings> =>
    (await sourceObjectCall('source.custom.settings.instance.update', body, key)) as CustomSourceInstanceRunnerSettings,
  updateCustomSourceSpacePolicy: async (body: CustomSourceSpacePolicyUpdate, key: string = crypto.randomUUID()): Promise<CustomSourceSpacePolicy> =>
    (await sourceObjectCall('source.custom.settings.space.update', body, key)) as CustomSourceSpacePolicy,
  /** Recipe planning fetches the endpoint, so it is queued; the plan is read through the Source request reader. */
  planSourceRecipe: async (body: OperationInput<'source.recipe.plan.request'>, key: string = crypto.randomUUID()): Promise<SourceRecipePlanResponse> =>
    (await waitForSourceRequest(await sourceObjectCall('source.recipe.plan.request', body, key), 'Recipe planning')) as unknown as SourceRecipePlanResponse,
  createSourceRecipe: async (body: SourceRecipeCreateRequest,key:string=crypto.randomUUID()):Promise<SourceRecipeCreateResponse> => {
    const result=await callOperation('source.recipe.create',body,key);
    if(!('status' in result)||result.status!=='succeeded')throw new Error('Source recipe draft did not complete');
    return result.data;
  },
  /** Queues the dry-run, waits for it, then rereads the version (its recorded result) through the authorized reader. */
  dryRunSourceRecipe: async (connectionId: string, body: { recipe_version_id: string; fixture_content?: string }, key: string = crypto.randomUUID()): Promise<SourceRecipeDryRunResponse> => {
    await waitForSourceRequest(await sourceObjectCall('source.recipe.dry_run.request', { ...body, source_connection_id: connectionId }, key), 'Recipe dry-run')
    const version = await get<SourceRecipeDryRunResponse['recipe_version']>(`/sources/connections/${encodeURIComponent(connectionId)}/recipe-versions/${encodeURIComponent(body.recipe_version_id)}`)
    return { recipe_version: version, dry_run: version.test_result_json } as SourceRecipeDryRunResponse
  },
  activateSourceRecipe: async (connectionId: string, body: { recipe_version_id: string; next_check_at?: string | null; schedule_rule?: SourceScheduleRule | null }, key: string = crypto.randomUUID()): Promise<SourceRecipeActivationResult> => {
    const receipt = await sourceObjectCall('source.recipe.activate', { ...body, schedule_rule: body.schedule_rule as Record<string, unknown> | null | undefined, source_connection_id: connectionId }, key)
    const version = await get<SourceRecipeActivationResult['recipe_version']>(`/sources/connections/${encodeURIComponent(connectionId)}/recipe-versions/${encodeURIComponent(receipt.recipe_version_id)}`)
    return { status: receipt.status, deltas: receipt.deltas, proposal_id: receipt.proposal_id, recipe_version: version } as SourceRecipeActivationResult
  },
  /** Bridge receipt; the new recipe Source and its version are reread through their authorized readers. */
  bridgePipelineSourceRecipe: async (connectionId: string, body: SourceRecipePipelineBridgeRequest = {}, key: string = crypto.randomUUID()) =>
    sourceObjectCall('source.custom.pipeline_bridge', { ...(body as Record<string, unknown>), source_connection_id: connectionId } as OperationInput<'source.custom.pipeline_bridge'>, key),
  sourceRecipeVersions: (connectionId: string, params: { limit?: number; offset?: number } = {}) => {
    const q: Record<string, string> = {}
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<Page<SourceRecipeVersion>>(`/sources/connections/${connectionId}/recipe-versions?` + new URLSearchParams(q))
  },

  items: (params: {
    library_status?: string
    read_status?: string
    connection_id?: string
    content_state?: string
    q?: string
    library_type?: string
    created_after?: string
    limit?: number
    offset?: number
  } = {}) => {
    const q: Record<string, string> = {}
    if (params.library_status !== undefined) q.library_status = params.library_status
    if (params.read_status !== undefined) q.read_status = params.read_status
    if (params.connection_id !== undefined) q.connection_id = params.connection_id
    if (params.content_state !== undefined) q.content_state = params.content_state
    if (params.q !== undefined) q.q = params.q
    if (params.library_type !== undefined) q.library_type = params.library_type
    if (params.created_after !== undefined) q.created_after = params.created_after
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<Page<SourceItem>>('/sources/items?' + new URLSearchParams(q))
  },
  getItem: (id: string, options?: RequestOptions) =>
    get<SourceItem>(`/sources/items/${id}`, options),
  /** Core commands return identity receipts; the item is reread through its authorized reader in the receipt Space. */
  updateItem: async (id: string, body: { connection_id: string | null }, key: string = crypto.randomUUID()) =>
    currentSourceItem(await sourceObjectCall('source.item.update', { source_item_id: id, connection_id: body.connection_id }, key)),
  createManualUrl: async (body: OperationInput<'source.item.save_url'>, options: RequestOptions = {}, key: string = crypto.randomUUID()) =>
    currentSourceItem(await sourceObjectCall('source.item.save_url', body, key, options)),
  itemAction: async (id: string, action: OperationInput<'source.item.queue'>['action'] | OperationInput<'source.item.triage'>['action'], options: RequestOptions = {}, key: string = crypto.randomUUID()) =>
    currentSourceItem(action === 'queue_content' || action === 'archive_snapshot'
      ? await sourceObjectCall('source.item.queue', { source_item_id: id, action }, key, options)
      : await sourceObjectCall('source.item.triage', { source_item_id: id, action }, key, options)),
  jobs: (params: {
    status?: string
    source_item_id?: string
    connection_id?: string
    job_type?: string
    limit?: number
    offset?: number
  } = {}, options?: RequestOptions) => {
    const q: Record<string, string> = {}
    if (params.status !== undefined) q.status = params.status
    if (params.source_item_id !== undefined) q.source_item_id = params.source_item_id
    if (params.connection_id !== undefined) q.connection_id = params.connection_id
    if (params.job_type !== undefined) q.job_type = params.job_type
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<Page<ExtractionJob>>('/sources/jobs?' + new URLSearchParams(q), options)
  },
  runJob: async(id:string,options:RequestOptions={},key:string=crypto.randomUUID()) => {
    const result=await callOperation('source.extraction.dispatch',{extraction_job_id:id},key,options);
    if(!('status' in result)||result.status!=='succeeded')throw new Error('Source dispatch did not enqueue');return result.data;
  },

  evidence: (params: { status?: string; evidence_type?: string; source_item_id?: string; project_id?: string; connection_id?: string; limit?: number; offset?: number } = {}) => {
    const q: Record<string, string> = {}
    if (params.status !== undefined) q.status = params.status
    if (params.evidence_type !== undefined) q.evidence_type = params.evidence_type
    if (params.source_item_id !== undefined) q.source_item_id = params.source_item_id
    if (params.project_id !== undefined) q.project_id = params.project_id
    if (params.connection_id !== undefined) q.connection_id = params.connection_id
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<Page<ExtractedEvidence>>('/sources/evidence?' + new URLSearchParams(q))
  },
  updateEvidence: async (id: string, body: Omit<OperationInput<'source.evidence.update'>, 'evidence_id'>, key: string = crypto.randomUUID()) => {
    const receipt = await sourceObjectCall('source.evidence.update', { ...body, evidence_id: id }, key)
    return get<ExtractedEvidence>(`/sources/evidence/${encodeURIComponent(receipt.id)}`, { spaceId: receipt.space_id })
  },
  /** Returns the link receipt; current links are listed through evidenceLinks. */
  createEvidenceLink: (body: OperationInput<'source.evidence.link'>, key: string = crypto.randomUUID()) =>
    sourceObjectCall('source.evidence.link', body, key),
  evidenceLinks: (params: { evidence_id?: string; target_type?: string; target_id?: string; status?: string } = {}) => {
    const q: Record<string, string> = {}
    if (params.evidence_id !== undefined) q.evidence_id = params.evidence_id
    if (params.target_type !== undefined) q.target_type = params.target_type
    if (params.target_id !== undefined) q.target_id = params.target_id
    if (params.status !== undefined) q.status = params.status
    return get<Page<EvidenceLink>>('/sources/evidence-links?' + new URLSearchParams(q))
  },

  projectSourceBindings: (params: { project_id: string; source_channel_id?: string }) => {
    const q: Record<string, string> = {}
    if (params.source_channel_id !== undefined) q.source_channel_id = params.source_channel_id
    return get<ProjectSourceBinding[]>(`/projects/${params.project_id}/sources/bindings?` + new URLSearchParams(q))
  },
  createProjectSourceBinding: async (body: OperationInput<'project.source.bind'>,key:string=crypto.randomUUID()) => {
    const result=await callOperation('project.source.bind',body,key);
    if(!('status' in result)||result.status!=='succeeded')throw new Error('Source binding did not complete');
    return result.data;
  },
  updateProjectSourceBinding: async (projectId:string,bindingId:string,changes:OperationInput<'project.source.update'>['changes'],key:string=crypto.randomUUID()) => {
    const result=await callOperation('project.source.update',{project_id:projectId,binding_id:bindingId,changes},key);
    if(!('status' in result)||result.status!=='succeeded')throw new Error('Source binding update did not complete');
    return result.data;
  },
  deleteProjectSourceBinding: async (projectId:string,bindingId:string,key:string=crypto.randomUUID()) => {
    const result=await callOperation('project.source.unbind',{project_id:projectId,binding_id:bindingId},key);
    if(!('status' in result)||result.status!=='succeeded')throw new Error('Source unbinding did not complete');
    return result.data;
  },
  backfillProjectSourceBinding: async (projectId:string,bindingId:string,key:string=crypto.randomUUID()) => {
    const result=await callOperation('project.source.backfill',{project_id:projectId,binding_id:bindingId},key);
    if(!('status' in result)||result.status!=='succeeded')throw new Error('Source material routing did not complete');
    return result.data;
  },
  projectItems: (params: {
    project_id: string
    source_channel_id?: string
    item_type?: string
    source_domain?: string
    matched_date?: string
    created_after?: string
    occurred_after?: string
    q?: string
    limit?: number
    offset?: number
  }) => {
    const q: Record<string, string> = { project_id: params.project_id }
    if (params.source_channel_id !== undefined) q.source_channel_id = params.source_channel_id
    if (params.item_type !== undefined) q.item_type = params.item_type
    if (params.source_domain !== undefined) q.source_domain = params.source_domain
    if (params.matched_date !== undefined) q.matched_date = params.matched_date
    if (params.created_after !== undefined) q.created_after = params.created_after
    if (params.occurred_after !== undefined) q.occurred_after = params.occurred_after
    if (params.q !== undefined) q.q = params.q
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<Page<ProjectSourceItem>>('/sources/project-items?' + new URLSearchParams(q))
  },
  projectSourceSummary: (projectId: string) =>
    get<ProjectSourceSummary>(`/sources/project-source-summary?project_id=${encodeURIComponent(projectId)}`),
  projectSourceHealth: (projectId: string) =>
    get<SourceHealth[]>(`/projects/${encodeURIComponent(projectId)}/sources/health`),
  sourceHealth: (params: { channel_id?: string } = {}) => {
    const q: Record<string, string> = {}
    if (params.channel_id !== undefined) q.channel_id = params.channel_id
    const suffix = new URLSearchParams(q).toString()
    return get<SourceHealth[]>(`/sources/source-health${suffix ? `?${suffix}` : ''}`)
  },
  /** Queues a one-off processing run (a Job receipt); the run itself is read through the Source run reader. */
  summarize: (body: OperationInput<'source.processing.run_once'>, key: string = crypto.randomUUID()) =>
    sourceObjectCall('source.processing.run_once', body, key),
  postProcessingRules: (channelId: string) =>
    get<SourcePostProcessingRule[]>(`/sources/channels/${channelId}/post-processing/rules`),
  createPostProcessingRule: async(channelId:string,body:SourcePostProcessingRuleCreate,key:string=crypto.randomUUID()) => {
    const result=await callOperation('source.processing.rule.create',{source_channel_id:channelId,rule:body},key);
    if(!('status' in result)||result.status!=='succeeded')throw new Error('Source rule configuration did not complete');return result.data;
  },
  updatePostProcessingRule: async(channelId:string,ruleId:string,body:SourcePostProcessingRuleUpdate,key:string=crypto.randomUUID()) => {
    const result=await callOperation('source.processing.rule.update',{source_channel_id:channelId,rule_id:ruleId,changes:body},key);
    if(!('status' in result)||result.status!=='succeeded')throw new Error('Source rule configuration did not complete');return result.data;
  },
  runPostProcessingRule: async(channelId:string,ruleId:string,key:string=crypto.randomUUID()) => {
    const result=await callOperation('source.processing.rule.dispatch',{source_channel_id:channelId,rule_id:ruleId,mode:'run'},key);
    if(!('status' in result)||result.status!=='succeeded')throw new Error('Source dispatch did not enqueue');return result.data;
  },
  drainPostProcessingRule: async(channelId:string,ruleId:string,key:string=crypto.randomUUID()) => {
    const result=await callOperation('source.processing.rule.dispatch',{source_channel_id:channelId,rule_id:ruleId,mode:'drain'},key);
    if(!('status' in result)||result.status!=='succeeded')throw new Error('Source dispatch did not enqueue');return result.data;
  },
  postProcessingRuns: (channelId: string, params: { limit?: number; offset?: number } = {}) => {
    const q: Record<string, string> = {}
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<Page<SourcePostProcessingRun>>(`/sources/channels/${channelId}/post-processing/runs?` + new URLSearchParams(q))
  },
  postProcessingBacklog: (channelId: string) =>
    get<SourcePostProcessingBacklog>(`/sources/channels/${channelId}/post-processing/backlog`),
  postProcessingDecisions: (params: {
    channel_id?: string
    project_id?: string
    rule_id?: string
    relevance?: SourcePostProcessingItemRelevance
    review_status?: SourcePostProcessingDecisionReviewStatus
    limit?: number
    offset?: number
  } = {}) => {
    const q: Record<string, string> = {}
    if (params.channel_id !== undefined) q.channel_id = params.channel_id
    if (params.project_id !== undefined) q.project_id = params.project_id
    if (params.rule_id !== undefined) q.rule_id = params.rule_id
    if (params.relevance !== undefined) q.relevance = params.relevance
    if (params.review_status !== undefined) q.review_status = params.review_status
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<Page<SourcePostProcessingItemDecision>>('/sources/post-processing/decisions?' + new URLSearchParams(q))
  },
  postProcessingChannelDecisions: (channelId: string, params: {
    rule_id?: string
    relevance?: SourcePostProcessingItemRelevance
    review_status?: SourcePostProcessingDecisionReviewStatus
    limit?: number
    offset?: number
  } = {}) => {
    const q: Record<string, string> = {}
    if (params.rule_id !== undefined) q.rule_id = params.rule_id
    if (params.relevance !== undefined) q.relevance = params.relevance
    if (params.review_status !== undefined) q.review_status = params.review_status
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<Page<SourcePostProcessingItemDecision>>(`/sources/channels/${channelId}/post-processing/decisions?` + new URLSearchParams(q))
  },
  /** Decision review through core: an identity receipt (review status, proposal / queued Job ids); decisions are reread through their list. */
  postProcessingDecisionAction: (decisionId: string, action: OperationInput<'source.processing.decision.queue'>['action'] | OperationInput<'source.processing.decision.review'>['action'], key: string = crypto.randomUUID()) =>
    action === 'queue_content' || action === 'extract_evidence'
      ? sourceObjectCall('source.processing.decision.queue', { decision_id: decisionId, action }, key)
      : sourceObjectCall('source.processing.decision.review', { decision_id: decisionId, action }, key),
  briefings: (params: {
    channel_id?: string
    project_id?: string
    limit?: number
    offset?: number
  } = {}) => {
    const q: Record<string, string> = {}
    if (params.channel_id !== undefined) q.channel_id = params.channel_id
    if (params.project_id !== undefined) q.project_id = params.project_id
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<Page<SourcePostProcessingBriefingDaySummary>>('/sources/briefings?' + new URLSearchParams(q))
  },
  briefing: (channelId: string, date: string) =>
    get<SourcePostProcessingBriefingDetail>(`/sources/briefings/${channelId}/${date}`),
}

export const projectMonitoringApi = {
  reconcile:async(projectId:string,key:string=crypto.randomUUID())=>{
    const receipt=await commandReceipt('project.monitoring.reconcile',{project_id:projectId},key)
    // Stopped work is reconciled either way; an active coordinator still needs the person to wait or cancel.
    if(receipt.coordinator_active)throw new Error('Coordinator or child Run is still active; wait or cancel the child Run before retrying')
    return get<ProjectMonitoringState>(`/projects/${encodeURIComponent(receipt.project_id)}/information-monitoring`,{spaceId:receipt.space_id})
  },
  state:(projectId:string,offset=0)=>get<ProjectMonitoringState>(`/projects/${projectId}/information-monitoring?offset=${offset}`),
  setup:(projectId:string,query:string,provider_key:'arxiv'|'rss'|'atom'|'web_page'='arxiv',key:string=crypto.randomUUID())=>
    commandReceipt('project.monitoring.source.setup',{project_id:projectId,query,provider_key,idempotency_key:key},key),
  propose:(projectId:string,config:ProjectMonitoringConfig,active:string|null,key:string=crypto.randomUUID())=>
    commandReceipt('project.monitoring.proposal.create',{project_id:projectId,config,expected_active_version_id:active,idempotency_key:key},key),
  details:async(projectId:string,body:{expected_version_id:string;recommendation_count:number;language:string},key:string=crypto.randomUUID())=>{
    const result=await callOperation('project.monitoring.details.update',{project_id:projectId,...body},key);
    if(!('status' in result)||result.status!=='succeeded')throw new Error('Monitoring details command did not complete');
    const state=await get<ProjectMonitoringState>(`/projects/${encodeURIComponent(result.data.project_id)}/information-monitoring`,{spaceId:result.data.space_id});
    if(!state.active)throw new Error('Monitoring version no longer available');return state.active;
  },
  paused:async(projectId:string,versionId:string,paused:boolean,key:string=crypto.randomUUID())=>{
    const result=await callOperation('project.monitoring.state.update',{project_id:projectId,expected_version_id:versionId,paused},key);
    if(!('status' in result)||result.status!=='succeeded')throw new Error('Monitoring state command did not complete');
    return get<ProjectMonitoringState>(`/projects/${encodeURIComponent(result.data.project_id)}/information-monitoring`,{spaceId:result.data.space_id});
  },
  run:(projectId:string,version:MonitoringVersion,kind:'initial'|'check'='initial',key:string=crypto.randomUUID())=>
    commandReceipt('project.monitoring.run.start',{project_id:projectId,version_id:version.id,config_hash:version.config_hash,kind,idempotency_key:key},key),
  feedback:(projectId:string,itemId:string,feedback:'read'|'relevant'|'not_relevant',key:string=crypto.randomUUID())=>
    commandReceipt('project.monitoring.feedback',{project_id:projectId,item_id:itemId,feedback},key),
};

// Goal collection uses the same scoped transport and canonical Run stream.
// Commands are core operations with a fresh transport key per attempt; the
// domain keys in their bodies (message, follow, edit, save, feedback) still dedupe.
const goalCall=<Id extends import('@rainver/protocol').SourceGoalOperationId>(id:Id,input:import('@rainver/protocol').OperationInput<Id>,options:RequestOptions={})=>sourceObjectCall(id,input,crypto.randomUUID(),options) as Promise<import('@rainver/protocol').OperationOutput<Id>>;

export type SourceGoalAction='edit'|'explore'|'preview'|'save'|'follow'|'feedback'|'check'|'resume'|'pause'|'delete'|'rollback';

const SOURCE_GOAL_ACTION_OPERATIONS={edit:'source.goal.edit',explore:'source.goal.explore',preview:'source.goal.preview.request',save:'source.goal.save',follow:'source.goal.follow',feedback:'source.goal.feedback',check:'source.goal.check',resume:'source.goal.resume',pause:'source.goal.pause',delete:'source.goal.delete',rollback:'source.goal.binding.rollback'} as const satisfies Record<SourceGoalAction,import('@rainver/protocol').SourceGoalOperationId>;

export const sourceGoalsApi={
 edit:(id:string,body:import('@rainver/protocol').SourceGoalEdit,options:RequestOptions={})=>goalCall('source.goal.edit',{goal_id:id,...body},options),
 check:(id:string,body:{expected_version_id:string|null;retry_failed?:true},options:RequestOptions={})=>goalCall('source.goal.check',{goal_id:id,...body},options),
 nativeAvailability:(profile:string,options:RequestOptions={})=>get<{supported:boolean;reason?:string;supported_modes?:string[]}>(`/sources/goal-setup/agent-search/${encodeURIComponent(profile)}`,options),
 findLegacy:(channel:string,options:RequestOptions={})=>get<{goal_id:string|null}>(`/sources/goal-setup/legacy/${encodeURIComponent(channel)}`,options),
 /** The secret is sent once with an explicit key; the receipt is the credential's metadata only. */
 storeCredential:async(data:{name:string;secret:string},options:RequestOptions={},key:string=crypto.randomUUID()):Promise<CustomSourceCredentialDTO>=>(await sourceObjectCall('source.custom.credential.create',data,key,options)) as CustomSourceCredentialDTO,
 list:(options:RequestOptions={})=>get<{goals:import('@rainver/protocol').SourceGoalDetail['goal'][]}>('/sources/goals',options),
 read:(id:string,options:RequestOptions={})=>get<import('@rainver/protocol').SourceGoalDetail>(`/sources/goals/${encodeURIComponent(id)}`,options),
 /** Creates a topic; with `follow`, creation and its one follow confirmation commit together. */
 begin:(data:import('@rainver/protocol').SourceGoalBeginRequest,options:RequestOptions={})=>goalCall('source.goal.setup.begin',data,options),
 /** Owner-only lookup of a committed creation by its idempotency key. */
 findCreation:(key:string,projectId:string|null,options:RequestOptions={})=>get<{goal_id:string|null;space_id?:string}>(`/sources/goal-setup/begin/${encodeURIComponent(key)}${projectId?`?project_id=${encodeURIComponent(projectId)}`:''}`,options),
 message:(goal_id:string,content:string,idempotency_key:string,options:RequestOptions={},execution?:{search_path?:'agent'|'api';agent_id?:string;runtime_profile_id?:string;session_config?:import('@rainver/protocol').RuntimeSessionConfigSelection[]})=>goalCall('source.goal.setup.message',{goal_id,content,idempotency_key,...execution},options),
 /** Maps a Monitor to a topic; the receipt names the goal (`goal_id`). */
 legacy:(channel_id:string,options:RequestOptions={})=>goalCall('source.goal.setup.legacy',{channel_id},options),
 /** One goal control. The preview is queued as a Job; its result appears on the goal (`previews`). */
 action:(id:string,action:SourceGoalAction,body:Record<string,unknown>={},options:RequestOptions={})=>goalCall(SOURCE_GOAL_ACTION_OPERATIONS[action],{goal_id:id,...body} as never,options),
 /** A binding stopped because its Source changed: the Source as it is now and what changed (see the server's reconfirm.ts). */
 sourceConfirmation:(id:string,bindingId:string,options:RequestOptions={})=>get<import('@rainver/protocol').SourceGoalBindingReconfirmation>(`/sources/goals/${encodeURIComponent(id)}/bindings/${encodeURIComponent(bindingId)}/source-confirmation`,options),
 /** The owner confirms exactly the state shown (binding revision and its token). */
 confirmSource:(id:string,bindingId:string,body:import('@rainver/protocol').SourceGoalBindingConfirmRequest,options:RequestOptions={})=>goalCall('source.goal.binding.confirm_source',{goal_id:id,binding_id:bindingId,...body},options),
 /** One confirmation starts continuous following; no manual preview is required. */
 /** Tightening-only owner feedback on a followed topic. */
 feedback:(id:string,body:import('@rainver/protocol').SourceGoalFeedbackRequest,options:RequestOptions={})=>goalCall('source.goal.feedback',{goal_id:id,...body},options),
 follow:(id:string,body:import('@rainver/protocol').SourceGoalFollowRequest,options:RequestOptions={})=>goalCall('source.goal.follow',{goal_id:id,...body},options),
}

// Reading method workspace: all writes remain explicit; GET never starts a trial.
export const readingMethodsApi={
 generate:async(body:unknown,key:string=crypto.randomUUID())=>readingMethodsApi.generation((await commandReceipt('reading_method.generation.start',body as OperationInput<'reading_method.generation.start'>,key)).generation_id),
 generation:(id:string)=>get<import('@rainver/protocol').ReadingMethodGenerationView>(`/prompts/reading-method/generations/${encodeURIComponent(id)}`),
 cancelGeneration:async(id:string,key:string=crypto.randomUUID())=>readingMethodsApi.generation((await commandReceipt('reading_method.generation.cancel',{generation_id:id},key)).generation_id),
 readSample:(id:string)=>get<{name:string;pages:Array<{url:string;text:string}>}>(`/prompts/reading-method/samples/${encodeURIComponent(id)}`),
 entry:(projectId?:string|null)=>get<{can_manage:boolean;project_id:string|null}>(`/prompts/reading-method/entry?${new URLSearchParams(projectId?{project_id:projectId}:{})}`),
 cliOptions:(projectId?:string|null)=>get<import('@rainver/protocol').ReadingMethodContext['runtimes']>(`/prompts/reading-method/cli-options${projectId?`?${new URLSearchParams({project_id:projectId})}`:''}`),
 context:(itemId:string|null,projectId?:string|null,artifactId?:string|null,targetKey?:string)=>get<import('@rainver/protocol').ReadingMethodContext>(`/prompts/reading-method?${new URLSearchParams({...(itemId?{item_id:itemId}:{}),...(projectId?{project_id:projectId}:{}),...(artifactId?{artifact_id:artifactId}:{}),...(targetKey?{target_key:targetKey}:{})})}`),
 // Keyed commands; content is read back through the GET readers above.
 initialize:(key:string=crypto.randomUUID())=>commandReceipt('reading_method.initialize',{},key),
 draft:async(body:unknown,key:string=crypto.randomUUID()):Promise<{id:string}>=>({id:(await commandReceipt('reading_method.draft.save',body as OperationInput<'reading_method.draft.save'>,key)).version_id}),
 sample:async(body:unknown,key:string=crypto.randomUUID()):Promise<{id:string}>=>({id:(await commandReceipt('reading_method.sample.save',body as OperationInput<'reading_method.sample.save'>,key)).case_id}),
 trial:async(body:unknown,key:string=crypto.randomUUID())=>readingMethodsApi.readTrial((await commandReceipt('reading_method.trial.start',body as OperationInput<'reading_method.trial.start'>,key)).trial_id),
 readTrial:(id:string)=>get<import('@rainver/protocol').ReadingMethodTrialView>(`/prompts/reading-method/trials/${encodeURIComponent(id)}`),
 judge:(id:string,body:{judgment:string;reason:string},key:string=crypto.randomUUID())=>commandReceipt('reading_method.trial.judge',{...body,trial_id:id} as OperationInput<'reading_method.trial.judge'>,key),
 cancel:(id:string,key:string=crypto.randomUUID())=>commandReceipt('reading_method.trial.cancel',{trial_id:id},key),
 promote:async(body:unknown,key:string=crypto.randomUUID()):Promise<{id:string;proposal_id?:string}>=>{const receipt=await commandReceipt('reading_method.promotion.propose',body as OperationInput<'reading_method.promotion.propose'>,key);return {id:receipt.proposal_id,proposal_id:receipt.proposal_id};},
 rollback:(body:unknown,key:string=crypto.randomUUID())=>commandReceipt('reading_method.rollback',body as OperationInput<'reading_method.rollback'>,key),
}

// Project Reading consumes the durable stage-two and private operation contracts.
export const projectReadingApi={
 favoriteStatus:(space:string,project:string,item:string,options:RequestOptions={})=>get<{item_id:string;favorite:boolean}>(`/spaces/${space}/projects/${project}/reading/items/${item}/favorite`,{...options,spaceId:space}),
 composition:(space:string,project:string,version?:string,options:RequestOptions&{date?:string}={})=>{const {date,...request}=options;return get<import('@rainver/protocol').ProjectReadingResponse>(`/spaces/${space}/projects/${project}/reading-compositions${version?`/${encodeURIComponent(version)}/export`:''}${date?`?date=${encodeURIComponent(date)}`:''}`,{...request,spaceId:space})},
 archivedTheme:(space:string,project:string,id:string,options:RequestOptions={})=>get<import('@rainver/protocol').Briefing>(`/spaces/${space}/projects/${project}/reading-compositions/analyses/${encodeURIComponent(id)}`,{...options,spaceId:space}),
 history:(space:string,project:string,cursor?:string,options:RequestOptions={})=>get<import('@rainver/protocol').ProjectReadingHistory>(`/spaces/${space}/projects/${project}/reading-compositions/history${cursor?`?cursor=${encodeURIComponent(cursor)}`:''}`,{...options,spaceId:space}),
 retryComposition:(space:string,project:string,key:string=crypto.randomUUID())=>commandReceipt('reading.composition.retry',{space_id:space,project_id:project},key,{spaceId:space}),
 themes:(goal:string,options:RequestOptions={})=>get<import('@rainver/protocol').ProjectThemeRoundsResponse>(`/sources/goals/${encodeURIComponent(goal)}/theme-rounds`,options),
 /** Receipts only; the rounds are read again through `themes`. */
 retryTheme:(goal:string,round:string,options:RequestOptions={})=>goalCall('source.goal.theme.retry',{goal_id:goal,round_id:round},options),
 consent:(goal:string,body:Omit<import('@rainver/protocol').OperationInput<'source.goal.theme.configure'>,'goal_id'>,options:RequestOptions={})=>goalCall('source.goal.theme.configure',{goal_id:goal,...body} as import('@rainver/protocol').OperationInput<'source.goal.theme.configure'>,options),
 operations:(space:string,project:string,offset=0,options:RequestOptions={})=>get<import('@rainver/protocol').ProjectDeepReadList>(`/spaces/${space}/projects/${project}/reading/deep-reads?offset=${offset}`,{...options,spaceId:space}),
 purposes:(space:string,project:string,item:string,options:RequestOptions={})=>get<import('@rainver/protocol').ProjectDeepReadPurposes>(`/spaces/${space}/projects/${project}/reading/items/${item}/purposes`,{...options,spaceId:space}),
 start:(space:string,project:string,item:string,body:Omit<import('@rainver/protocol').OperationInput<'reading.deep_read.start'>,'space_id'|'project_id'|'item_id'>,key:string=crypto.randomUUID()):Promise<{status:string;run_id?:string;processing_id?:string;source_id?:string;source_name?:string;can_request_consent?:boolean}>=>commandReceipt('reading.deep_read.start',{...body,space_id:space,project_id:project,item_id:item},key,{spaceId:space}),
 cancel:(space:string,project:string,id:string,key:string=crypto.randomUUID())=>commandReceipt('reading.deep_read.cancel',{space_id:space,project_id:project,operation_id:id},key,{spaceId:space}),
 favorite:async(space:string,project:string,item:string,favorite:boolean,key:string=crypto.randomUUID())=>{const result=await commandReceipt('reading.favorite.set',{space_id:space,project_id:project,item_id:item,favorite},key,{spaceId:space});return {item_id:result.item_id,favorite:result.favorite}},
 record:(space:string,project:string,item:string,snapshot:string,options:RequestOptions={})=>get<import('@rainver/protocol').ProjectReadingRecords>(`/reader/source-items/${item}/records?project_id=${project}&snapshot_id=${encodeURIComponent(snapshot)}`,{...options,spaceId:space}),
 records:(space:string,project:string,item:string,offset=0,options:RequestOptions={})=>get<import('@rainver/protocol').ProjectReadingRecords>(`/reader/source-items/${item}/records?project_id=${project}&offset=${offset}`,{...options,spaceId:space}),
}
