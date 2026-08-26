/**
 * Route registry — the composition pattern for server routes (the
 * permanent "gateway" entry layer).
 *
 * Server-owned backend modules live under `../modules/<module_name>/` and each
 * exposes a {@link ServerModule}: a name plus a
 * `registerRoutes(app, context)` function. The registry mounts every server-owned
 * module FIRST, then the explicit `/api/v1/*` 404 catch-all LAST. Anything the
 * server does not explicitly own is not a public API route.
 *
 * New server features must be added as explicit modules in {@link SERVER_MODULES},
 * never by widening the proxy.
 */

import type { FastifyInstance } from "fastify";
import { createConfigSnapshot, type ConfigSnapshot, type ServerConfig } from "../config.js";
import { systemModule } from "../modules/system/index.js";
import { authModule } from "../modules/auth/index.js";
import { spacesModule } from "../modules/spaces/index.js";
import { catalogModule } from "../modules/catalog/index.js";
import { capabilitiesModule } from "../modules/capabilities/index.js";
import { streamingModule } from "../modules/streaming/index.js";
import { notificationsModule } from "../modules/notifications/index.js";
import { jobsModule } from "../modules/jobs/index.js";
import { automationsModule } from "../modules/automations/index.js";
import { autonomyModule } from "../modules/autonomy/index.js";
import { dailyReportsModule } from "../modules/dailyReports/index.js";
import { backupsModule } from "../modules/backups/index.js";
import { providersModule } from "../modules/providers/index.js";
import { networkProfilesModule } from "../modules/networkProfiles/index.js";
import { runtimeToolsModule } from "../modules/runtimeTools/index.js";
import { acpAgentsModule } from "../modules/acpAgents/index.js";
import { runtimeConformanceModule } from "../modules/runtimeConformance/index.js";
import { runtimeToolBindingsModule } from "../modules/runtimeToolBindings/index.js";
import { runtimeHostModule } from "../modules/runtimeHost/index.js";
import { usageModule } from "../modules/usage/index.js";
import { runsModule } from "../modules/runs/index.js";
import { artifactsModule } from "../modules/artifacts/index.js";
import { projectsModule } from "../modules/projects/index.js";
import { inquiryModule } from "../modules/inquiry/index.js";
import { experimentsModule } from "../modules/experiments/index.js";
import { knowledgePromotionModule } from "../modules/knowledgePromotion/index.js";
import { projectReviewModule } from "../modules/projectReview/index.js";
import { decisionsModule } from "../modules/decisions/index.js";
import { learningModule } from "../modules/learning/index.js";
import { projectResearchModule } from "../modules/projectResearch/index.js";
import { researchModule } from "../modules/research/index.js";
import { policyModule } from "../modules/policy/index.js";
import { runtimeContextModule } from "../modules/runtimeContext/index.js";
import { contentAccessModule } from "../modules/contentAccess/index.js";
import { proposalsModule } from "../modules/proposals/index.js";
import { sessionsModule } from "../modules/sessions/index.js";
import { agentTemplatesModule } from "../modules/agentTemplates/index.js";
import { agentsModule } from "../modules/agents/index.js";
import { agentGroupsModule } from "../modules/agentGroups/index.js";
import { roomsModule } from "../modules/rooms/index.js";
import { personalMemoryGrantsModule } from "../modules/personalMemoryGrants/index.js";
import { memoryModule } from "../modules/memory/index.js";
import { contextOpsModule } from "../modules/contextOps/index.js";
import { askSpaceModule } from "../modules/askSpace/index.js";
import { captureModule } from "../modules/capture/index.js";
import { captureFilingModule } from "../modules/captureFiling/index.js";
import { crossSpaceRetrievalModule } from "../modules/crossSpaceRetrieval/index.js";
import { activityModule } from "../modules/activity/index.js";
import { focusAreasModule } from "../modules/focusAreas/index.js";
import { publicationsModule } from "../modules/publications/index.js";
import { sourcesModule } from "../modules/sources/index.js";
import { readerModule } from "../modules/reader/index.js";
import { informationDigestModule } from "../modules/informationDigest/index.js";
import { knowledgeModule } from "../modules/knowledge/index.js";
import { relationsModule } from "../modules/relations/index.js";
import { academicModule } from "../modules/academic/index.js";
import { graphModule } from "../modules/graph/index.js";
import { evolutionModule } from "../modules/evolution/index.js";
import { promptsModule } from "../modules/prompts/index.js";
import { tasksModule } from "../modules/tasks/index.js";
import { projectFolderExecutionConfigsModule } from "../modules/projectFolderExecutionConfigs/index.js";
import { projectFoldersModule } from "../modules/projectFolders/index.js";
import { hostsModule } from "../modules/hosts/index.js";
import { deploymentModule } from "../modules/deployment/index.js";
import { frontendSupportModule } from "../modules/frontendSupport/index.js";
// Official optional module control plane — registered before optional product modules.
import { pluginsModule } from "../modules/plugins/index.js";
import { plansModule } from "../modules/plans/index.js";
import { routingModule } from "../modules/routing/index.js";
// Plugin host — activates built-in official plugins after SERVER_MODULES.
import type { PluginHost } from "../modules/plugins/host/index.js";
import { registerGatewayConventions, registerUnknownApiRoute } from "./appShell.js";

/** Dependencies handed to every server-owned module at registration time. */
export interface ModuleContext {
  config: ServerConfig;
  /** Immutable, hash-identified view of the same validated config. */
  snapshot: ConfigSnapshot;
  /** Built-in official plugin host for modules that own extension registries. */
  pluginHost?: PluginHost;
}

/** Contract every server-owned backend module implements. */
export interface ServerModule {
  /** Stable module id (matches its `src/modules/<name>/` directory). */
  name: string;
  registerRoutes(app: FastifyInstance, context: ModuleContext): void;
}

/**
 * All server-owned modules, in registration order. The unknown-API catch-all is not
 * a module and is registered separately, always last.
 */
export const SERVER_MODULES: readonly ServerModule[] = [
  systemModule,
  authModule,
  spacesModule,
  catalogModule,
  capabilitiesModule,
  streamingModule,
  notificationsModule,
  runtimeToolsModule,
  runtimeConformanceModule,
  networkProfilesModule,
  providersModule,
  runtimeToolBindingsModule,
  runtimeHostModule,
  usageModule,
  runsModule,
  artifactsModule,
  projectsModule,
  inquiryModule,
  experimentsModule,
  knowledgePromotionModule,
  projectReviewModule,
  decisionsModule,
  learningModule,
  projectResearchModule,
  researchModule,
  policyModule,
  runtimeContextModule,
  contentAccessModule,
  proposalsModule,
  sessionsModule,
  agentTemplatesModule,
  agentsModule,
  agentGroupsModule,
  roomsModule,
  personalMemoryGrantsModule,
  memoryModule,
  contextOpsModule,
  askSpaceModule,
  captureModule,
  captureFilingModule,
  crossSpaceRetrievalModule,
  activityModule,
  focusAreasModule,
  publicationsModule,
  sourcesModule,
  readerModule,
  informationDigestModule,
  knowledgeModule,
  relationsModule,
  academicModule,
  graphModule,
  evolutionModule,
  promptsModule,
  tasksModule,
  projectFolderExecutionConfigsModule,
  projectFoldersModule,
  hostsModule,
  acpAgentsModule,
  jobsModule,
  autonomyModule,
  automationsModule,
  dailyReportsModule,
  backupsModule,
  deploymentModule,
  frontendSupportModule,
  // Official optional module control plane.
  // Must appear before optional product modules that depend on the plugin guard.
  pluginsModule,
  plansModule,
  routingModule,
  // Note: official optional product modules (e.g. diary) are no longer in
  // SERVER_MODULES. They are loaded and activated via the PluginHost after this list.
];

export function registerServerRoutes(
  app: FastifyInstance,
  config: ServerConfig,
  pluginHost?: PluginHost,
): void {
  const context: ModuleContext = { config, snapshot: createConfigSnapshot(config), pluginHost };

  registerGatewayConventions(app);

  // 1. Server-owned modules (permanent).
  for (const module of SERVER_MODULES) {
    module.registerRoutes(app, context);
  }

  // 2. Plugin-contributed routes. activate() is synchronous by contract.
  if (pluginHost) {
    pluginHost.activate(app, config);
  }

  // 3. Unknown API catch-all. Must stay last so explicitly owned server routes win.
  registerUnknownApiRoute(app);
}
