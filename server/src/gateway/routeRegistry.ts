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
import { createConfigSnapshot, type ConfigSnapshot, type ServerConfig } from "../config";
import { systemModule } from "../modules/system";
import { authModule } from "../modules/auth";
import { spacesModule } from "../modules/spaces";
import { catalogModule } from "../modules/catalog";
import { capabilitiesModule } from "../modules/capabilities";
import { streamingModule } from "../modules/streaming";
import { notificationsModule } from "../modules/notifications";
import { jobsModule } from "../modules/jobs";
import { automationsModule } from "../modules/automations";
import { autonomyModule } from "../modules/autonomy";
import { dailyReportsModule } from "../modules/dailyReports";
import { backupsModule } from "../modules/backups";
import { providersModule } from "../modules/providers";
import { networkProfilesModule } from "../modules/networkProfiles";
import { runtimeToolsModule } from "../modules/runtimeTools";
import { runtimeConformanceModule } from "../modules/runtimeConformance";
import { runtimeToolBindingsModule } from "../modules/runtimeToolBindings";
import { runtimeHostModule } from "../modules/runtimeHost";
import { usageModule } from "../modules/usage";
import { runsModule } from "../modules/runs";
import { artifactsModule } from "../modules/artifacts";
import { projectsModule } from "../modules/projects";
import { inquiryModule } from "../modules/inquiry";
import { experimentsModule } from "../modules/experiments";
import { knowledgePromotionModule } from "../modules/knowledgePromotion";
import { projectReviewModule } from "../modules/projectReview";
import { decisionsModule } from "../modules/decisions";
import { learningModule } from "../modules/learning";
import { projectResearchModule } from "../modules/projectResearch";
import { researchModule } from "../modules/research";
import { policyModule } from "../modules/policy";
import { runtimeContextModule } from "../modules/runtimeContext";
import { contentAccessModule } from "../modules/contentAccess";
import { proposalsModule } from "../modules/proposals";
import { sessionsModule } from "../modules/sessions";
import { agentTemplatesModule } from "../modules/agentTemplates";
import { agentsModule } from "../modules/agents";
import { agentGroupsModule } from "../modules/agentGroups";
import { roomsModule } from "../modules/rooms";
import { personalMemoryGrantsModule } from "../modules/personalMemoryGrants";
import { memoryModule } from "../modules/memory";
import { contextOpsModule } from "../modules/contextOps";
import { askSpaceModule } from "../modules/askSpace";
import { captureModule } from "../modules/capture";
import { captureFilingModule } from "../modules/captureFiling";
import { crossSpaceRetrievalModule } from "../modules/crossSpaceRetrieval";
import { activityModule } from "../modules/activity";
import { focusAreasModule } from "../modules/focusAreas";
import { publicationsModule } from "../modules/publications";
import { sourcesModule } from "../modules/sources";
import { readerModule } from "../modules/reader";
import { informationDigestModule } from "../modules/informationDigest";
import { knowledgeModule } from "../modules/knowledge";
import { relationsModule } from "../modules/relations";
import { academicModule } from "../modules/academic";
import { graphModule } from "../modules/graph";
import { evolutionModule } from "../modules/evolution";
import { promptsModule } from "../modules/prompts";
import { tasksModule } from "../modules/tasks";
import { projectFolderExecutionConfigsModule } from "../modules/projectFolderExecutionConfigs";
import { projectFoldersModule } from "../modules/projectFolders";
import { deploymentModule } from "../modules/deployment";
import { frontendSupportModule } from "../modules/frontendSupport";
// Official optional module control plane — registered before optional product modules.
import { pluginsModule } from "../modules/plugins";
import { plansModule } from "../modules/plans";
import { routingModule } from "../modules/routing";
// Plugin host — activates built-in official plugins after SERVER_MODULES.
import type { PluginHost } from "../modules/plugins/host";
import { registerErrorEnvelopeHandler } from "./errorEnvelope";
import {
  REQUEST_ID_HEADER,
  SERVER_MARKER_HEADER,
  SERVER_MARKER_VALUE,
  resolveRequestId,
} from "./requestContext";

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

  // Cross-cutting gateway conventions: the error envelope for server-owned route
  // errors, and request-id continuity on every response.
  registerErrorEnvelopeHandler(app);
  app.addHook("onRequest", async (request, reply) => {
    reply.header(REQUEST_ID_HEADER, resolveRequestId(request));
    reply.header(SERVER_MARKER_HEADER, SERVER_MARKER_VALUE);
  });

  // 1. Server-owned modules (permanent).
  for (const module of SERVER_MODULES) {
    module.registerRoutes(app, context);
  }

  // 2. Plugin-contributed routes. activate() is synchronous by contract.
  if (pluginHost) {
    pluginHost.activate(app, config);
  }

  // 3. Unknown API catch-all. Must stay last so explicitly owned server routes win.
  app.all("/api/v1/*", async (_request, reply) =>
    reply.code(404).send({ detail: "Route not found" }),
  );
}
