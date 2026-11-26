/** Public API facade. Transport and domain implementations live in their owning modules. */
export { setSpaceContext, ApiRequestError, refusalCode, refusalMetadata } from './transport'
export type { RequestOptions } from './transport'
export { agentAttentionApi, homeApi, meApi, spaceEgressApi } from './attention'
export { conversationInputApi, streamTurnParts, sessionsApi } from './conversation'
export {
  contentAccessApi,
  focusAreasApi,
  publicationsApi,
  memoryApi,
  knowledgeApi,
  graphApi,
  objectSchemaApi,
  notesCollectionsApi,
  projectNotebookChatApi,
  notesTreeApi,
  notesApi,
  knowledgeSourcesApi,
} from './knowledge'
export type { GraphProjectionQuery } from './knowledge'
export {
  personalBriefingsApi,
  projectBriefingHighlightsApi,
  informationDigestsApi,
  sourcesApi,
  projectMonitoringApi,
  sourceGoalsApi,
  readingMethodsApi,
  projectReadingApi,
} from './sources'
export type { SourceGoalAction } from './sources'
export { promptsApi, boardsApi, tasksApi } from './tasks'
export { runsApi, authorizationRequestsApi, plansApi } from './runs'
export { roomsApi } from './rooms'
export { apiTransport, queryOperation, callOperation, queryPluginOperation, callPluginOperation } from './operations'
export { personalMemoryGrantsApi, artifactsApi, proposalsApi } from './artifacts'
export { EvolutionRunNotSelected, evolutionApi } from './evolution'
export type { SaveWorkflowFromRunResult } from './evolution'
export { agentsApi, agentRolesApi, skillsApi, contextOpsApi, askSpaceApi, usageApi } from './agents'
export type { UsageApiQuery } from './agents'
export { automationsApi, dailyReportApi } from './automations'
export { agentWorkspacesApi, projectFoldersApi } from './folders'
export { jobsApi } from './jobReads'
export { ambientSessionsApi, hostsApi, ordinaryToolsApi, acpAgentsApi, networkProfilesApi } from './hosts'
export type {
  OrdinaryAccountStreamEvent,
  AcpDistribution,
  AcpRegistryEntry,
  AcpAgentOut,
  RuntimeLoginEvent,
  HostLoginTarget,
} from './hosts'
export { captureApi, activityApi, captureFilingApi } from './capture'
export { readerApi } from './reader'
export { projectsApi } from './projects'
export { inquiryApi, experimentsApi, knowledgePromotionApi, projectReviewApi, decisionCasesApi, learningApi } from './inquiry'
export type { InquiryDeltaBrief, KnowledgePromotionCandidate, ProjectReviewSession, DecisionCase } from './inquiry'
export { projectResearchApi, researchDiscoveryApi, runtimeContextApi } from './research'
export type { RetrievalSwitchTarget } from './research'
export { instanceOperationsApi, deploymentApi, pluginsApi } from './instance'
export { authApi, spacesApi } from './identity'
export { providersApi } from './providers'
export type {
  ProviderType,
  ProviderDeployment,
  ModelProviderOut,
  ProviderPresetMode,
  ProviderPresetOut,
  ProviderTaskChainEntry,
  ProviderTaskPolicyOut,
  ProviderVendorOut,
  ManagedSubscriptionQuota,
  ManagedSubscriptionType,
  ManagedSubscriptionLoginEvent,
} from './providers'
