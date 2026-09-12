export type RuntimeInvocationClass =
  | "agent_task_gateway"
  | "agent_task_renderer"
  | "agent_task_transport"
  | "bounded_cli_task"
  | "bounded_provider_task"
  | "provider_facade"
  | "provider_transport";

export interface RuntimeInvocationEntry {
  entrypoint: string;
  source: string;
  classification: RuntimeInvocationClass;
  owner: string;
  targetBoundary: "runtime_context_gateway" | "provider_task" | "delivery_renderer";
}

export interface ManagedConversationEntrypoint {
  source: string;
  executionMode: "conversation_lightweight.v1" | "room_conversation.v1";
  targetBoundary: "runtime_context_gateway";
}

/** Conversation producers queue Runs instead of invoking providers directly.
 * Keep them explicit so a new conversation mode requires a Gateway boundary
 * decision even though the direct invocation inventory cannot discover it. */
export const MANAGED_CONVERSATION_ENTRYPOINT_INVENTORY = [
  {
    source: "agents/routes.ts",
    executionMode: "conversation_lightweight.v1",
    targetBoundary: "runtime_context_gateway",
  },
  {
    source: "agentGroups/service.ts",
    executionMode: "room_conversation.v1",
    targetBoundary: "runtime_context_gateway",
  },
] as const satisfies readonly ManagedConversationEntrypoint[];

/**
 * Executable inventory of every production module that directly reaches the
 * provider invocation transport or an Agent runtime adapter. Boundary tests
 * compare source imports to this registry so a new bypass cannot land unseen.
 */
export const RUNTIME_INVOCATION_INVENTORY = [
  providerCall("dailyReports/service.ts", "completeProviderText", 1, "bounded_provider_task", "dailyReports", "provider_task"),
  // A bounded one-shot over imported CLI history, owned by its module: it
  // reads records the person already imported and produces proposals, and it
  // is not an Agent task-context entrypoint (ADR 0014 decision 1).
  providerCall("importedSessions/extraction.ts", "completeProviderText", 1, "bounded_provider_task", "importedSessions", "provider_task"),
  // The same shape for the same module: one bounded pass over a session's own
  // records to produce the summary a whole-session reference carries. Not an
  // Agent task-context entrypoint either.
  providerCall("importedSessions/summary.ts", "completeProviderText", 1, "bounded_provider_task", "importedSessions", "provider_task"),
  providerCall("inquiry/adviceService.ts", "completeProviderMessages", 1, "bounded_provider_task", "inquiry", "provider_task"),
  providerCall("projectResearch/questionRefineService.ts", "completeProviderMessages", 1, "bounded_provider_task", "projectResearch", "provider_task"),
  providerCall("projects/publicSummaryGenerator.ts", "completeProviderText", 1, "bounded_provider_task", "projects", "provider_task"),
  providerCall("research/queryPlanning/intentPlanner.ts", "completeProviderMessages", 1, "bounded_provider_task", "research", "provider_task"),
  providerCall("retrieval/embedding/providerEmbedder.ts", "completeProviderEmbedding", 1, "bounded_provider_task", "retrieval", "provider_task"),
  providerCall("retrieval/embedding/queryEmbedder.ts", "completeProviderEmbedding", 1, "bounded_provider_task", "retrieval", "provider_task"),
  providerCall("retrieval/queryRewriteProvider/providerQueryRewriter.ts", "completeProviderText", 1, "bounded_provider_task", "retrieval", "provider_task"),
  providerCall("retrieval/rerankProvider/providerReranker.ts", "completeProviderText", 1, "bounded_provider_task", "retrieval", "provider_task"),
  providerCall("retrieval/rerankProvider/providerReranker.ts", "completeProviderRerank", 1, "bounded_provider_task", "retrieval", "provider_task"),
  providerCall("retrieval/synthesisProvider/providerSynthesizer.ts", "completeProviderText", 1, "bounded_provider_task", "retrieval", "provider_task"),
  providerCall("rooms/conversationSummaryService.ts", "completeProviderMessages", 1, "bounded_provider_task", "rooms", "provider_task"),
  providerCall("runtimeContext/continuity/semanticExtractor.ts", "completeProviderText", 1, "bounded_provider_task", "runtimeContext", "provider_task"),
  providerCall("providers/commands/routes.ts", "completeProviderEmbedding", 1, "bounded_provider_task", "providers", "provider_task"),
  providerCall("providers/commands/routes.ts", "completeProviderRerank", 1, "bounded_provider_task", "providers", "provider_task"),
  providerCall("providers/commands/routes.ts", "completeProviderChat", 1, "bounded_provider_task", "providers", "provider_task"),
  entry("providers/index.ts", "provider_facade", "providers", "provider_task"),
  providerCall("runtimeHost/service.ts", "completeProviderMessages", 1, "agent_task_gateway", "runtimeHost", "runtime_context_gateway"),
  entry("runs/managedApiAdapter.ts", "agent_task_renderer", "runs", "delivery_renderer"),
  invocationCall("runs/managedApiAdapter.ts", "executeRuntimeHost", 1, "agent_task_renderer", "runs", "delivery_renderer"),
  // The CLI renderer is the remote-host adapter now: every `local_cli` run is
  // dispatched to a host daemon, and the server spawns no vendor CLI of its own.
  entry("runs/remoteHostCliAdapter.ts", "agent_task_renderer", "runs", "delivery_renderer"),
  // A renderer, not a Gateway invoker: a run handed to a host daemon gets no
  // server-brokered Runtime Context and pulls through its own work surface.
  invocationCall("runs/orchestrationService.ts", "executeRemoteHostCliAdapter", 1, "agent_task_renderer", "runs", "delivery_renderer"),
  // The conformance probe asks the host that holds the copy rather than
  // spawning locally; its command site is the server-owned duplex executor.
  invocationCall("runs/orchestrationService.ts", "executeManagedApiNoToolAdapter", 1, "agent_task_gateway", "runs", "runtime_context_gateway"),
  entry("providers/invocation/invocation.ts", "provider_transport", "providers", "provider_task"),
  entry("providers/proxy/server.ts", "provider_transport", "providers", "delivery_renderer"),
] as const satisfies readonly RuntimeInvocationEntry[];

function entry(
  source: string,
  classification: RuntimeInvocationClass,
  owner: string,
  targetBoundary: RuntimeInvocationEntry["targetBoundary"],
  entrypoint = source,
): RuntimeInvocationEntry {
  return { entrypoint, source, classification, owner, targetBoundary };
}

function providerCall(
  source: string,
  helper: string,
  ordinal: number,
  classification: RuntimeInvocationClass,
  owner: string,
  targetBoundary: RuntimeInvocationEntry["targetBoundary"],
): RuntimeInvocationEntry {
  return entry(source, classification, owner, targetBoundary, `${source}#${helper}:${ordinal}`);
}

function invocationCall(
  source: string,
  helper: string,
  ordinal: number,
  classification: RuntimeInvocationClass,
  owner: string,
  targetBoundary: RuntimeInvocationEntry["targetBoundary"],
): RuntimeInvocationEntry {
  return entry(source, classification, owner, targetBoundary, `${source}#${helper}:${ordinal}`);
}
