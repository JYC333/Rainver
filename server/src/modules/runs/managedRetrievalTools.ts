import { KNOWLEDGE_RETRIEVAL_OBJECT_TYPES } from "../knowledge/retrievalObjectTypes";
import type {
  CanonicalMessage,
  CanonicalToolCall,
  CanonicalToolDefinition,
  RetrievalBriefResponse,
  RetrievalSearchResponse,
  RetrievalToolMode,
  RuntimeHostExecuteRequest,
  RuntimeHostExecuteResponse,
} from "@agent-space/protocol" with { "resolution-mode": "import" };
import type { ServerConfig } from "../../config";
import { getDbPool } from "../../db/pool";
import { knowledgeRetrievalRegistry } from "../knowledge/retrievalAdapter";
import { memoryRetrievalRegistry } from "../memory/retrievalAdapter";
import { projectRetrievalRegistry } from "../projects/retrievalAdapter";
import { sourceRetrievalRegistry } from "../sources/retrievalAdapter";
import { resolveProviderCommandStore } from "../providers/commands/store";
import {
  buildRetrievalBriefArtifactSpec,
  RetrievalSearchService,
} from "../retrieval";
import type { RetrievalObjectType, RetrievalSearchMode } from "../retrieval";
import { readSpaceRetrievalSettings } from "../retrieval/settings";
import { ProviderQueryEmbedder } from "../retrieval/embedding/queryEmbedder";
import { ProviderReranker } from "../retrieval/rerankProvider/providerReranker";
import { ProviderSynthesizer } from "../retrieval/synthesisProvider/providerSynthesizer";
import { RetrievalToolService } from "../retrieval/tool/service";
import {
  enforceRetrievalToolCallPolicy,
  type RetrievalToolPolicyAction,
} from "../retrieval/tool/policy";
import type { RunRecord } from "./repository";

export type RuntimeHostExecutor = (
  config: ServerConfig,
  request: RuntimeHostExecuteRequest,
) => Promise<RuntimeHostExecuteResponse>;

export interface ManagedApiRetrievalToolDeps {
  retrievalToolService?: RetrievalToolService | null;
}

export interface ResolvedRetrievalToolBinding {
  service: RetrievalToolService;
  services: Partial<Record<RetrievalToolDomain, RetrievalToolService>>;
  toolMode: RetrievalToolMode;
  toolDefinitions: CanonicalToolDefinition[];
  toolBindings: RuntimeHostExecuteRequest["tool_bindings"];
  policyDatabaseUrl: string | null;
  egressPolicySnapshot: { external_egress_enabled: boolean };
  settingsSnapshot: Record<string, unknown>;
}

// The Knowledge domain's own retrieval types, not a second copy of them: this
// list was character-for-character identical and would have drifted silently.
const RETRIEVAL_TOOL_OBJECT_TYPES = KNOWLEDGE_RETRIEVAL_OBJECT_TYPES;
const MEMORY_RETRIEVAL_TOOL_OBJECT_TYPES = ["memory_entry"] as const;
const PROJECT_RETRIEVAL_TOOL_OBJECT_TYPES = ["project_public_summary"] as const;
const SOURCE_RETRIEVAL_TOOL_OBJECT_TYPES = ["source_item", "extracted_evidence"] as const;
const RETRIEVAL_TOOL_MODES = ["exact", "lexical", "hybrid", "hybrid_rerank"] as const;
const MAX_TOOL_TURNS = 4;
const MAX_MODEL_RESULT_ITEMS = 8;
const MAX_MODEL_SNIPPET_CHARS = 500;
// Mirrors the runtime-host error code for a provider that cannot do tool calls.
const RUNTIME_TOOL_PROVIDER_UNSUPPORTED = "runtime_tool_provider_unsupported";

type RetrievalToolDomain = "knowledge" | "memory" | "project_public_summary" | "source";

interface RetrievalToolDomainSpec {
  domain: RetrievalToolDomain;
  registry: typeof knowledgeRetrievalRegistry;
  searchTool: RetrievalToolPolicyAction;
  briefTool: RetrievalToolPolicyAction;
  searchDescription: string;
  briefDescription: string;
  objectTypes: readonly RetrievalObjectType[];
  objectTypeLabel: string;
  requiredScopes: string[];
  serviceSurface: string;
  artifactSurface: string;
  persistTrace: boolean;
}

const KNOWLEDGE_TOOL_SPEC: RetrievalToolDomainSpec = {
  domain: "knowledge",
  registry: knowledgeRetrievalRegistry,
  searchTool: "retrieval.search",
  briefTool: "retrieval.brief",
  searchDescription: "Search this space's Knowledge objects under the instructing user's read access.",
  briefDescription: "Build a cited Knowledge Context Brief under the instructing user's read access.",
  objectTypes: RETRIEVAL_TOOL_OBJECT_TYPES,
  objectTypeLabel: "knowledge_item, note, source, or claim",
  requiredScopes: ["knowledge.read"],
  serviceSurface: "managed_run",
  artifactSurface: "managed_run_retrieval_tool",
  persistTrace: true,
};

const MEMORY_TOOL_SPEC: RetrievalToolDomainSpec = {
  domain: "memory",
  registry: memoryRetrievalRegistry,
  searchTool: "memory.retrieval.search",
  briefTool: "memory.retrieval.brief",
  searchDescription: "Search Memory entries under the instructing user's read access. Requires explicit Memory tool opt-in.",
  briefDescription: "Build a cited Memory Context Brief under the instructing user's read access. Requires explicit Memory tool opt-in.",
  objectTypes: MEMORY_RETRIEVAL_TOOL_OBJECT_TYPES,
  objectTypeLabel: "memory_entry",
  requiredScopes: ["memory.read"],
  serviceSurface: "managed_run_memory",
  artifactSurface: "managed_run_memory_retrieval_tool",
  persistTrace: false,
};

const PROJECT_TOOL_SPEC: RetrievalToolDomainSpec = {
  domain: "project_public_summary",
  registry: projectRetrievalRegistry,
  searchTool: "project.summary.search",
  briefTool: "project.summary.brief",
  searchDescription: "Search approved Project public summaries under the instructing user's read access. Requires explicit Project summary tool opt-in.",
  briefDescription: "Build a cited Project public-summary Context Brief under the instructing user's read access. Requires explicit Project summary tool opt-in.",
  objectTypes: PROJECT_RETRIEVAL_TOOL_OBJECT_TYPES,
  objectTypeLabel: "project_public_summary",
  requiredScopes: ["project_public_summary.read"],
  serviceSurface: "managed_run_project_public_summary",
  artifactSurface: "managed_run_project_public_summary_retrieval_tool",
  persistTrace: false,
};

const SOURCE_TOOL_SPEC: RetrievalToolDomainSpec = {
  domain: "source",
  registry: sourceRetrievalRegistry,
  searchTool: "source.retrieval.search",
  briefTool: "source.retrieval.brief",
  searchDescription: "Search Source items and extracted evidence under the instructing user's read access. Requires explicit Source tool opt-in.",
  briefDescription: "Build a cited Source Context Brief under the instructing user's read access. Requires explicit Source tool opt-in.",
  objectTypes: SOURCE_RETRIEVAL_TOOL_OBJECT_TYPES,
  objectTypeLabel: "source_item or extracted_evidence",
  requiredScopes: ["source.read"],
  serviceSurface: "managed_run_source",
  artifactSurface: "managed_run_source_retrieval_tool",
  persistTrace: false,
};

const OPTIONAL_DOMAIN_TOOL_SPECS = [MEMORY_TOOL_SPEC, PROJECT_TOOL_SPEC, SOURCE_TOOL_SPEC] as const;

export async function resolveRetrievalToolBinding(
  config: ServerConfig,
  run: RunRecord,
  deps: ManagedApiRetrievalToolDeps,
): Promise<ResolvedRetrievalToolBinding | null> {
  if (!run.instructed_by_user_id) return null;
  // Enablement: either the run/runtime config opts in, or the space sets a
  // managed-run retrieval_tool_mode other than `off`. Default stays no-tool.
  const runMode = retrievalToolModeFromRun(run);
  if (runMode === "off") return null;
  if (deps.retrievalToolService) {
    // The test-injected path has no DB to read the space setting from, so it
    // still requires explicit run-level opt-in. It intentionally models only
    // the Knowledge surface; Memory/Project domain tests use the DB-backed path
    // so registry-specific revalidation and artifact trimming are exercised.
    if (!runMode) return null;
    const toolDefinitions = toolDefinitionsForSpecs([KNOWLEDGE_TOOL_SPEC]);
    return {
      service: deps.retrievalToolService,
      services: { knowledge: deps.retrievalToolService },
      toolMode: runMode,
      toolDefinitions,
      toolBindings: toolBindingsForSpecs([KNOWLEDGE_TOOL_SPEC]),
      policyDatabaseUrl: null,
      egressPolicySnapshot: { external_egress_enabled: true },
      settingsSnapshot: { source: "test_injected_service" },
    };
  }
  if (!config.databaseUrl) return null;
  const pool = getDbPool(config.databaseUrl);
  const settings = await readSpaceRetrievalSettings(pool, run.space_id);
  const effectiveMode = runMode ?? (settings.retrievalToolMode === "off" ? null : settings.retrievalToolMode);
  if (!effectiveMode) return null;
  const enabledSpecs = enabledToolSpecs(run);
  const store = resolveProviderCommandStore(config);
  const egressPolicy = { externalEgressEnabled: settings.externalEgressEnabled };
  const services = Object.fromEntries(
    enabledSpecs.map((spec) => {
      const search = new RetrievalSearchService(pool, spec.registry, {
        egressPolicy,
        queryEmbedder: new ProviderQueryEmbedder(
          store,
          null,
          undefined,
          settings.embeddingDimensions,
          egressPolicy,
        ),
        reranker: settings.rerankEnabled
          ? new ProviderReranker(store, {
              databaseUrl: config.databaseUrl,
              surface: spec.artifactSurface,
              egressPolicy,
            })
          : undefined,
        synthesizer: new ProviderSynthesizer(store, {
          databaseUrl: config.databaseUrl,
          surface: spec.artifactSurface,
          egressPolicy,
        }),
      });
      return [
        spec.domain,
        new RetrievalToolService(search, {
          databaseUrl: config.databaseUrl,
          surface: spec.serviceSurface,
          domain: spec.domain,
          searchAction: spec.searchTool,
          briefAction: spec.briefTool,
        }),
      ];
    }),
  ) as Partial<Record<RetrievalToolDomain, RetrievalToolService>>;
  const knowledgeService = services.knowledge;
  if (!knowledgeService) return null;
  return {
    service: knowledgeService,
    services,
    toolMode: effectiveMode,
    toolDefinitions: toolDefinitionsForSpecs(enabledSpecs),
    toolBindings: toolBindingsForSpecs(enabledSpecs),
    policyDatabaseUrl: config.databaseUrl,
    egressPolicySnapshot: {
      external_egress_enabled: settings.externalEgressEnabled,
    },
    settingsSnapshot: {
      default_search_mode: settings.defaultSearchMode,
      rerank_enabled: settings.rerankEnabled,
      query_rewrite_enabled: settings.queryRewriteEnabled,
      use_query_cache: settings.useQueryCache,
      include_trace: settings.includeTrace,
      retrieval_tool_mode: settings.retrievalToolMode,
      embedding_dimensions: settings.embeddingDimensions,
      max_results_default: settings.maxResultsDefault,
    },
  };
}

export async function executeWithRetrievalTools(
  config: ServerConfig,
  run: RunRecord,
  request: RuntimeHostExecuteRequest,
  execute: RuntimeHostExecutor,
  binding: ResolvedRetrievalToolBinding,
  extensions: {
    toolDefinitions?: CanonicalToolDefinition[];
    toolBindings?: RuntimeHostExecuteRequest["tool_bindings"];
    dispatch?: (call: CanonicalToolCall) => Promise<{ modelResult: unknown; summary: Record<string, unknown>; artifact?: unknown; suspend?: RuntimeHostExecuteResponse }>;
    onActionEvent?: (eventType: "action_invoked" | "action_completed", call: CanonicalToolCall, metadata?: Record<string, unknown>) => Promise<void>;
  } = {},
): Promise<RuntimeHostExecuteResponse> {
  const actor = {
    spaceId: run.space_id,
    instructedByUserId: run.instructed_by_user_id!,
    agentId: run.agent_id,
    runId: run.id,
  };
  const messages = initialMessagesForToolLoop(request);
  const artifacts: unknown[] = [];
  const toolSummaries: Array<Record<string, unknown>> = [];
  let lastResponse: RuntimeHostExecuteResponse | null = null;

  await applyRetrievalPreflight(binding, actor, run, request, messages, toolSummaries, artifacts, extensions.dispatch);

  if (isRetrievalPreflightMode(binding.toolMode)) {
    const response = await execute(config, {
      ...request,
      messages: cloneMessages(messages),
      tool_mode: "disabled",
      tool_bindings: [],
    });
    return responseWithRetrievalToolMetadata(response, toolSummaries, artifacts);
  }

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn += 1) {
    const response = await execute(config, {
      ...request,
      messages: cloneMessages(messages),
      tool_mode: "authorized_bindings",
      tool_bindings: [...binding.toolBindings, ...(extensions.toolBindings ?? [])],
      tools: [...binding.toolDefinitions, ...(extensions.toolDefinitions ?? [])],
    });
    lastResponse = response;
    // The run's provider cannot perform tool calls (e.g. ollama). Rather than
    // failing the whole run, degrade to a single plain no-tool turn and record
    // why, so the run still produces output. Only on the first turn — once a
    // tool call has succeeded the model is provably tool-capable.
    if (
      turn === 0 &&
      !response.success &&
      response.error_code === RUNTIME_TOOL_PROVIDER_UNSUPPORTED
    ) {
      const plain = await execute(config, {
        ...request,
        messages: cloneMessages(messages),
        tool_mode: "disabled",
      });
      return responseWithRetrievalToolMetadata(
        plain,
        [{ tool_name: "retrieval", ok: false, error_code: "retrieval_tool_provider_unsupported" }],
        [],
      );
    }
    const toolCalls = toolCallsFromResponse(response);
    if (!response.success || toolCalls.length === 0) {
      return responseWithRetrievalToolMetadata(response, toolSummaries, artifacts);
    }

    messages.push({
      role: "assistant",
      content: response.output_text || null,
      tool_calls: toolCalls,
    });
    for (const call of toolCalls) {
      const result = extensions.dispatch
        ? await extensions.dispatch(call)
        : await runRetrievalToolCall(call, binding, actor, run);
      toolSummaries.push(result.summary);
      if ("artifact" in result && result.artifact) artifacts.push(result.artifact);
      if ("suspend" in result && result.suspend) {
        return responseWithRetrievalToolMetadata(result.suspend, toolSummaries, artifacts);
      }
      messages.push({
        role: "tool",
        content: JSON.stringify(result.modelResult),
        tool_call_id: call.id,
        name: call.name,
      });
    }
  }

  return responseWithRetrievalToolMetadata(
    withoutPendingToolCalls(
      lastResponse ?? toolLoopFailure(request, "retrieval_tool_loop_empty", "No model response was produced."),
    ),
    [
      ...toolSummaries,
      { tool_name: "retrieval", ok: false, error_code: "retrieval_tool_turn_limit" },
    ],
    artifacts,
  );
}

async function applyRetrievalPreflight(
  binding: ResolvedRetrievalToolBinding,
  actor: {
    spaceId: string;
    instructedByUserId: string;
    agentId?: string | null;
    runId?: string | null;
  },
  run: RunRecord,
  request: RuntimeHostExecuteRequest,
  messages: CanonicalMessage[],
  toolSummaries: Array<Record<string, unknown>>,
  artifacts: unknown[],
  dispatch?: (call: CanonicalToolCall) => Promise<{ modelResult: unknown; summary: Record<string, unknown>; artifact?: unknown; suspend?: RuntimeHostExecuteResponse }>,
): Promise<void> {
  if (!isRetrievalPreflightMode(binding.toolMode)) return;
  // Delivery-backed execution has already completed governed acquisition and
  // planning. Adapter-side preflight would inject model-visible content that
  // is absent from the immutable Delivery/Snapshot.
  if (request.invocation_audit_refs) return;
  const query = preflightQuery(request, messages);
  if (!query) return;
  const mode = retrievalSearchModeFromSettings(binding.settingsSnapshot.default_search_mode) ?? "hybrid";
  const maxResults = numberFromSettings(binding.settingsSnapshot.max_results_default) ?? 10;
  const call: CanonicalToolCall = {
    id: `preflight-${binding.toolMode}`,
    name: binding.toolMode === "preflight_brief" ? "retrieval.brief" : "retrieval.search",
    arguments_json: JSON.stringify({
      query,
      mode,
      max_results: Math.min(Math.max(maxResults, 1), 50),
      include_trace: false,
    }),
  };
  const result = dispatch ? await dispatch(call) : await runRetrievalToolCall(call, binding, actor, run);
  toolSummaries.push({ ...result.summary, preflight: true });
  if (result.artifact) artifacts.push(result.artifact);
  messages.push({
    role: "user",
    content: `Retrieval preflight (${call.name}) result:\n${JSON.stringify(result.modelResult)}`,
  });
}

function retrievalToolInputSchema(
  includeTraceDefault: boolean,
  objectTypes: readonly RetrievalObjectType[],
): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["query"],
    properties: {
      query: { type: "string", minLength: 1 },
      object_types: {
        type: "array",
        items: { type: "string", enum: objectTypes },
      },
      object_profiles: {
        type: "array",
        items: { type: "string", pattern: "^[a-z][a-z0-9_]{0,63}$" },
        maxItems: 20,
      },
      max_results: { type: "integer", minimum: 1, maximum: 50 },
      mode: { type: "string", enum: RETRIEVAL_TOOL_MODES },
      include_trace: { type: "boolean", default: includeTraceDefault },
    },
  };
}

function initialMessagesForToolLoop(request: RuntimeHostExecuteRequest): CanonicalMessage[] {
  if (request.messages?.length) return cloneMessages(request.messages);
  return [{ role: "user", content: request.prompt }];
}

function cloneMessages(messages: readonly CanonicalMessage[]): CanonicalMessage[] {
  return messages.map((message) => ({
    ...message,
    tool_calls: message.tool_calls?.map((call) => ({ ...call })),
  }));
}

function toolDefinitionsForSpecs(specs: readonly RetrievalToolDomainSpec[]): CanonicalToolDefinition[] {
  return specs.flatMap((spec) => [
    {
      name: spec.searchTool,
      description: spec.searchDescription,
      input_schema: retrievalToolInputSchema(false, spec.objectTypes),
    },
    {
      name: spec.briefTool,
      description: spec.briefDescription,
      input_schema: retrievalToolInputSchema(true, spec.objectTypes),
    },
  ]);
}

function toolBindingsForSpecs(specs: readonly RetrievalToolDomainSpec[]): RuntimeHostExecuteRequest["tool_bindings"] {
  return specs.flatMap((spec) => [spec.searchTool, spec.briefTool].map((toolName) => ({
    id: toolName,
    external_type: "internal",
    external_ref: toolName,
    display_name: toolName,
    required_scopes: spec.requiredScopes,
    credential_ref: null,
    data_exposure_level: "model_provider",
    observability_level: "structured_events",
    side_effect_level: "none",
    approval_required: false,
  })));
}

export async function runRetrievalToolCall(
  call: CanonicalToolCall,
  binding: ResolvedRetrievalToolBinding,
  actor: {
    spaceId: string;
    instructedByUserId: string;
    agentId?: string | null;
    runId?: string | null;
  },
  run: RunRecord,
  policyAlreadyEnforced = false,
): Promise<{
  modelResult: unknown;
  summary: Record<string, unknown>;
  artifact: unknown | null;
}> {
  try {
    const spec = toolSpecForName(call.name);
    if (!spec) {
      return {
        modelResult: { ok: false, tool: call.name, error: "Unknown retrieval tool." },
        summary: { tool_name: call.name, ok: false, error_code: "unknown_retrieval_tool" },
        artifact: null,
      };
    }
    const service = binding.services[spec.domain];
    if (!service) {
      let policyDecisionRecordId: string | null = null;
      try {
        await enforceRetrievalToolCallPolicy({
          databaseUrl: binding.policyDatabaseUrl,
          actor,
          action: call.name === spec.searchTool ? spec.searchTool : spec.briefTool,
          domain: spec.domain,
          domainEnabled: false,
          surface: spec.serviceSurface,
        });
      } catch (error) {
        policyDecisionRecordId = policyDecisionRecordIdFromError(error);
        // The policy denial is expected here and has already been audited when
        // audit persistence is available. Keep the model-facing error stable.
      }
      return {
        modelResult: {
          ok: false,
          tool: call.name,
          error: "Retrieval tool domain is not enabled for this run.",
          ...(policyDecisionRecordId ? { policy_decision_record_id: policyDecisionRecordId } : {}),
        },
        summary: {
          tool_name: call.name,
          domain: spec.domain,
          ok: false,
          error_code: "retrieval_tool_domain_not_enabled",
          ...(policyDecisionRecordId ? { policy_decision_record_id: policyDecisionRecordId } : {}),
        },
        artifact: null,
      };
    }
    const params = parseRetrievalToolArguments(call.arguments_json, spec);
    const searchParams = {
      ...params,
      objectTypes: params.objectTypes ?? (spec.domain === "knowledge" ? undefined : [...spec.objectTypes]),
    };
    if (call.name === spec.searchTool) {
      const response = await service.toolSearch(actor, searchParams, policyAlreadyEnforced);
      return {
        modelResult: modelResultForSearch(call.name, response),
        summary: {
          tool_name: call.name,
          domain: spec.domain,
          ok: true,
          result_count: response.items.length,
          mode: params.mode ?? null,
          policy_decision_record_id: consumePolicyDecisionRecordId(service),
        },
        artifact: null,
      };
    }
    if (call.name === spec.briefTool) {
      const response = await service.toolBrief(actor, searchParams, policyAlreadyEnforced);
      const artifact = buildRetrievalBriefArtifactSpec({
        spaceId: run.space_id,
        ownerUserId: actor.instructedByUserId,
        runId: run.id,
        projectId: run.project_id,
        query: params.query,
        objectTypes: searchParams.objectTypes,
        objectProfiles: searchParams.objectProfiles,
        maxResults: params.maxResults ?? 10,
        mode: params.mode ?? "hybrid",
        includeTrace: params.includeTrace ?? false,
        surface: spec.artifactSurface,
        response,
        persistTrace: spec.persistTrace,
        egressPolicySnapshot: binding.egressPolicySnapshot,
        settingsSnapshot: binding.settingsSnapshot,
      });
      return {
        modelResult: modelResultForBrief(call.name, response),
        summary: {
          tool_name: call.name,
          domain: spec.domain,
          ok: true,
          result_count: response.items.length,
          synthesized: response.brief.synthesized,
          mode: params.mode ?? null,
          policy_decision_record_id: consumePolicyDecisionRecordId(service),
        },
        artifact,
      };
    }
    throw new Error("Tool name does not match its retrieval domain.");
  } catch (error) {
    const policyDecisionRecordId = policyDecisionRecordIdFromError(error);
    return {
      modelResult: {
        ok: false,
        tool: call.name,
        error: error instanceof Error ? error.message : "Retrieval tool call failed.",
        ...(policyDecisionRecordId ? { policy_decision_record_id: policyDecisionRecordId } : {}),
      },
      summary: {
        tool_name: call.name,
        ok: false,
        error_code: "retrieval_tool_call_failed",
        ...(policyDecisionRecordId ? { policy_decision_record_id: policyDecisionRecordId } : {}),
      },
      artifact: null,
    };
  }
}

function policyDecisionRecordIdFromError(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const value = (error as { policy_decision_record_id?: unknown }).policy_decision_record_id;
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function validateRetrievalToolInput(actionId: string, input: unknown): void {
  const spec = toolSpecForName(actionId);
  if (!spec) throw new Error("Unknown retrieval tool.");
  parseRetrievalToolArguments(JSON.stringify(input), spec);
}

function consumePolicyDecisionRecordId(service: RetrievalToolService): string | null {
  const candidate = service as RetrievalToolService & { consumePolicyDecisionRecordId?: () => string | null };
  return typeof candidate.consumePolicyDecisionRecordId === "function"
    ? candidate.consumePolicyDecisionRecordId()
    : null;
}

function parseRetrievalToolArguments(
  argumentsJson: string,
  spec: RetrievalToolDomainSpec,
): {
  query: string;
  objectTypes?: RetrievalObjectType[];
  objectProfiles?: string[];
  maxResults?: number;
  mode?: RetrievalSearchMode;
  includeTrace?: boolean;
} {
  let raw: unknown;
  try {
    raw = JSON.parse(argumentsJson || "{}");
  } catch {
    throw new Error("Tool arguments must be valid JSON.");
  }
  const record = recordOrEmpty(raw);
  const query = typeof record.query === "string" ? record.query.trim() : "";
  if (!query) throw new Error("query is required.");
  const params: {
    query: string;
    objectTypes?: RetrievalObjectType[];
    objectProfiles?: string[];
    maxResults?: number;
    mode?: RetrievalSearchMode;
    includeTrace?: boolean;
  } = { query };
  if (Array.isArray(record.object_types)) {
    const values = record.object_types.filter((value): value is RetrievalObjectType =>
      typeof value === "string" && (spec.objectTypes as readonly string[]).includes(value),
    );
    if (values.length !== record.object_types.length) {
      throw new Error(`object_types may only include ${spec.objectTypeLabel}.`);
    }
    if (values.length) params.objectTypes = values;
  }
  if (Array.isArray(record.object_profiles)) {
    const values = record.object_profiles.filter((value): value is string =>
      typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value),
    );
    if (values.length !== record.object_profiles.length) {
      throw new Error("object_profiles may only include slug keys.");
    }
    if (values.length) params.objectProfiles = [...new Set(values)].slice(0, 20);
  }
  if (typeof record.max_results === "number") {
    if (!Number.isInteger(record.max_results) || record.max_results < 1 || record.max_results > 50) {
      throw new Error("max_results must be an integer between 1 and 50.");
    }
    params.maxResults = record.max_results;
  }
  if (typeof record.mode === "string") {
    if (!(RETRIEVAL_TOOL_MODES as readonly string[]).includes(record.mode)) {
      throw new Error("mode is not supported.");
    }
    params.mode = record.mode as RetrievalSearchMode;
  }
  if (typeof record.include_trace === "boolean") params.includeTrace = record.include_trace;
  return params;
}

function toolCallsFromResponse(response: RuntimeHostExecuteResponse): CanonicalToolCall[] {
  const output = recordOrEmpty(response.output_json);
  const calls = Array.isArray(output.tool_calls) ? output.tool_calls : [];
  return calls.filter((call): call is CanonicalToolCall => {
    const record = recordOrEmpty(call);
    return (
      typeof record.id === "string" &&
      typeof record.name === "string" &&
      typeof record.arguments_json === "string"
    );
  });
}

function responseWithRetrievalToolMetadata(
  response: RuntimeHostExecuteResponse,
  toolSummaries: Array<Record<string, unknown>>,
  artifacts: unknown[],
): RuntimeHostExecuteResponse {
  if (toolSummaries.length === 0 && artifacts.length === 0) return response;
  const output = {
    ...recordOrEmpty(response.output_json),
    ...(toolSummaries.length ? { retrieval_tool_calls: toolSummaries } : {}),
    ...(artifacts.length ? { artifacts } : {}),
  };
  const metadata = {
    ...recordOrEmpty(response.adapter_metadata),
    retrieval_tool_calls: toolSummaries.map((summary) => ({
      tool_name: summary.tool_name,
      ok: summary.ok,
      result_count: summary.result_count ?? null,
      synthesized: summary.synthesized ?? null,
      error_code: summary.error_code ?? null,
    })),
  };
  return {
    ...response,
    output_json: output,
    adapter_metadata: metadata,
  };
}

function withoutPendingToolCalls(response: RuntimeHostExecuteResponse): RuntimeHostExecuteResponse {
  const output = recordOrEmpty(response.output_json);
  if (!("tool_calls" in output)) return response;
  const rest = { ...output };
  delete rest.tool_calls;
  return { ...response, output_json: rest };
}

function preflightQuery(
  request: RuntimeHostExecuteRequest,
  messages: readonly CanonicalMessage[],
): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === "user" && typeof message.content === "string" && message.content.trim()) {
      return message.content.trim().slice(0, 1024);
    }
  }
  return request.prompt.trim().slice(0, 1024);
}

function numberFromSettings(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}

function retrievalSearchModeFromSettings(value: unknown): RetrievalSearchMode | null {
  return typeof value === "string" && (RETRIEVAL_TOOL_MODES as readonly string[]).includes(value)
    ? (value as RetrievalSearchMode)
    : null;
}

function toolSpecForName(name: string): RetrievalToolDomainSpec | null {
  for (const spec of [KNOWLEDGE_TOOL_SPEC, ...OPTIONAL_DOMAIN_TOOL_SPECS]) {
    if (name === spec.searchTool || name === spec.briefTool) return spec;
  }
  return null;
}

function enabledToolSpecs(run: RunRecord): RetrievalToolDomainSpec[] {
  const enabledDomains = explicitRetrievalToolDomainsFromRun(run);
  return [
    KNOWLEDGE_TOOL_SPEC,
    ...OPTIONAL_DOMAIN_TOOL_SPECS.filter((spec) => enabledDomains.has(spec.domain)),
  ];
}

function explicitRetrievalToolDomainsFromRun(run: RunRecord): Set<RetrievalToolDomain> {
  const domains = new Set<RetrievalToolDomain>();
  const records = [
    recordOrEmpty(run.runtime_config_json),
    recordOrEmpty(run.model_override_json),
  ];
  for (const record of records) {
    addDomainsFromRecord(domains, record);
  }
  addDomainsFromCapabilities(domains, run.capabilities_json);
  return domains;
}

function addDomainsFromRecord(domains: Set<RetrievalToolDomain>, record: Record<string, unknown>): void {
  const retrievalTools = recordOrEmpty(record.retrieval_tools);
  for (const value of arrayOfStrings(retrievalTools.domains)) {
    addDomainAlias(domains, value);
  }
  for (const key of ["memory", "project_public_summary", "source"]) {
    const nested = recordOrEmpty(retrievalTools[key]);
    if (retrievalTools[key] === true || nested.enabled === true) addDomainAlias(domains, key);
  }
  if (record.memory_retrieval_tools_enabled === true) domains.add("memory");
  if (record.project_public_summary_retrieval_tools_enabled === true) domains.add("project_public_summary");
  if (record.source_retrieval_tools_enabled === true) domains.add("source");
}

function addDomainsFromCapabilities(domains: Set<RetrievalToolDomain>, value: unknown): void {
  if (!Array.isArray(value)) return;
  const capabilities = new Set(value.filter((item): item is string => typeof item === "string"));
  if (
    capabilities.has("memory.retrieval_tools") ||
    capabilities.has("memory.retrieval.tools") ||
    capabilities.has("memory.retrieval.search") ||
    capabilities.has("memory.retrieval.brief")
  ) {
    domains.add("memory");
  }
  if (
    capabilities.has("project_public_summary.retrieval_tools") ||
    capabilities.has("project_public_summary.retrieval.tools") ||
    capabilities.has("project.summary.search") ||
    capabilities.has("project.summary.brief")
  ) {
    domains.add("project_public_summary");
  }
  if (
    capabilities.has("source.retrieval_tools") ||
    capabilities.has("source.retrieval.tools") ||
    capabilities.has("source.retrieval.search") ||
    capabilities.has("source.retrieval.brief")
  ) {
    domains.add("source");
  }
}

function addDomainAlias(domains: Set<RetrievalToolDomain>, value: string): void {
  if (value === "memory" || value === "memory_entry") {
    domains.add("memory");
  } else if (
    value === "project" ||
    value === "projects" ||
    value === "project_public_summary" ||
    value === "project_public_summaries"
  ) {
    domains.add("project_public_summary");
  } else if (
    value === "source" ||
    value === "source_item" ||
    value === "extracted_evidence" ||
    value === "source_items"
  ) {
    domains.add("source");
  }
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function retrievalToolModeFromRun(run: RunRecord): RetrievalToolMode | null {
  const runtimeConfig = recordOrEmpty(run.runtime_config_json);
  const modelOverride = recordOrEmpty(run.model_override_json);
  const capabilities = run.capabilities_json;
  return (
    retrievalToolModeIn(runtimeConfig) ??
    retrievalToolModeIn(modelOverride) ??
    retrievalCapabilityMode(capabilities)
  );
}

function retrievalToolModeIn(record: Record<string, unknown>): RetrievalToolMode | null {
  if (record.retrieval_tools_enabled === true) return "manual_tool_only";
  const nested = recordOrEmpty(record.retrieval_tools);
  if (nested.enabled === true) return "manual_tool_only";
  const mode = typeof nested.mode === "string"
    ? nested.mode
    : typeof record.retrieval_tool_mode === "string"
      ? record.retrieval_tool_mode
      : null;
  if (mode === "enabled") return "manual_tool_only";
  return isRetrievalToolMode(mode) ? mode : null;
}

function retrievalCapabilityMode(value: unknown): RetrievalToolMode | null {
  if (!Array.isArray(value)) return null;
  if (value.includes("retrieval.preflight_brief")) return "preflight_brief";
  if (value.includes("retrieval.preflight_search")) return "preflight_search";
  if (
    value.includes("retrieval.tools") ||
    value.includes("knowledge.retrieval_tools") ||
    value.includes("retrieval.manual_tool_only")
  ) {
    return "manual_tool_only";
  }
  return null;
}

function isRetrievalToolMode(value: unknown): value is RetrievalToolMode {
  return (
    value === "off" ||
    value === "manual_tool_only" ||
    value === "preflight_search" ||
    value === "preflight_brief"
  );
}

function isRetrievalPreflightMode(value: RetrievalToolMode): boolean {
  return value === "preflight_search" || value === "preflight_brief";
}

function modelResultForSearch(tool: string, response: RetrievalSearchResponse): Record<string, unknown> {
  return {
    ok: true,
    tool,
    total: response.total,
    items: compactRetrievalItems(response.items),
  };
}

function modelResultForBrief(tool: string, response: RetrievalBriefResponse): Record<string, unknown> {
  return {
    ok: true,
    tool,
    total: response.total,
    brief: {
      answer: response.brief.answer,
      synthesized: response.brief.synthesized,
      citations: response.brief.citations,
      gap_analysis: response.brief.gap_analysis,
    },
    items: compactRetrievalItems(response.items),
  };
}

function compactRetrievalItems(items: RetrievalSearchResponse["items"]): Array<Record<string, unknown>> {
  return items.slice(0, MAX_MODEL_RESULT_ITEMS).map((item) => ({
    object_type: item.object_type,
    object_id: item.object_id,
    title: item.title,
    snippet: truncateModelText(item.snippet ?? null, MAX_MODEL_SNIPPET_CHARS),
    score: item.score,
    matched_fields: item.matched_fields,
    source_refs: item.source_refs ?? [],
  }));
}

function truncateModelText(value: string | null, maxChars: number): string | null {
  if (value === null) return null;
  return value.length > maxChars ? `${value.slice(0, maxChars - 3)}...` : value;
}

function toolLoopFailure(
  request: RuntimeHostExecuteRequest,
  errorCode: string,
  errorText: string,
): RuntimeHostExecuteResponse {
  const now = new Date().toISOString();
  return {
    success: false,
    stdout: "",
    stderr: errorText,
    output_text: "",
    output_json: { adapter_type: "ts_agent_host", run_id: request.run_id },
    exit_code: 1,
    error_code: errorCode,
    error_text: errorText,
    started_at: now,
    completed_at: now,
    model: request.model ?? null,
    usage: null,
    events: [],
    adapter_metadata: {
      adapter_type: "ts_agent_host",
      run_id: request.run_id,
      tool_mode: "authorized_bindings",
    },
    adapter_log_json: null,
  };
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
