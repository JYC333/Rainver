import type { ContextPackage } from "@agent-space/protocol" with {
  "resolution-mode": "import",
};
import { serializeMemoryRow } from "../memory/repository";
import type {
  ContextEvidenceSelection,
  ContextArtifactAttachmentSelection,
  ContextMemoryRow,
  PolicyRow,
  SessionSummaryRow,
} from "./repository";

export function buildContextPackage(input: {
  memories: readonly ContextMemoryRow[];
  activePolicies: readonly PolicyRow[];
  sourceRefs: readonly Record<string, unknown>[];
  retrievalTrace: Record<string, unknown>;
  tokenBudget: Record<string, unknown>;
  userId: string;
  spaceId: string;
  projectFolderId: string | null;
  sessionSummary: SessionSummaryRow | null;
  evidenceSelections?: readonly ContextEvidenceSelection[];
  artifactAttachments?: readonly ContextArtifactAttachmentSelection[];
}): ContextPackage {
  const userMemory = input.memories.filter((m) => m.scope_type === "user");
  const workspaceMemory = input.memories.filter((m) => m.scope_type === "project_folder");
  const capabilityMemory = input.memories.filter((m) => m.scope_type === "capability");
  const agentMemory = input.memories.filter((m) => m.scope_type === "agent");
  const systemPolicy = input.memories.filter((m) => m.scope_type === "system");
  const relevantEpisodes = input.memories.filter(
    (m) => m.memory_layer === "episodic" && m.scope_type !== "system",
  );

  const stablePrefixRefs = input.sourceRefs.filter(
    (ref) => ref.section === "stable_prefix" || ref.source_type === "policy",
  );
  const dynamicTailRefs = input.sourceRefs.filter(
    (ref) => ref.section === "dynamic_tail",
  );

  const retrievalTrace = { ...input.retrievalTrace };
  const sourceRefs = [...input.sourceRefs];
  const recentSessionSummary = input.sessionSummary
    ? [
        {
          id: input.sessionSummary.id,
          session_id: input.sessionSummary.session_id,
          summary_text: input.sessionSummary.summary_text,
          version: Number(input.sessionSummary.version),
          condenser_version: input.sessionSummary.condenser_version ?? "",
        },
      ]
    : [];
  if (input.sessionSummary) {
    const ref = {
      source_type: "session_summary",
      source_id: input.sessionSummary.id,
      version: Number(input.sessionSummary.version),
      section: "dynamic_tail",
      derived_context: true,
    };
    sourceRefs.push(ref);
    dynamicTailRefs.push(ref);
    retrievalTrace.session_summary = {
      session_summary_used: true,
      session_summary_id: input.sessionSummary.id,
      session_summary_version: Number(input.sessionSummary.version),
      session_summary_fallback_reason: null,
    };
  } else {
    retrievalTrace.session_summary = {
      session_summary_used: false,
      session_summary_id: null,
      session_summary_version: null,
      session_summary_fallback_reason: "no_active_summary",
    };
  }

  const evidenceSelections = input.evidenceSelections ?? [];
  const evidenceRefs = evidenceSelections.map((selection) => selection.ref);
  sourceRefs.push(...evidenceRefs);
  dynamicTailRefs.push(...evidenceRefs);
  const artifactAttachments = input.artifactAttachments ?? [];
  const artifactRefs = artifactAttachments.map((selection) => selection.ref);
  sourceRefs.push(...artifactRefs);
  dynamicTailRefs.push(...artifactRefs);
  retrievalTrace.evidence_selection = {
    selected_count: evidenceSelections.length,
    evidence_refs: evidenceRefs,
    selection_owner: "ts_context_prepare",
    selection_status: "selected",
  };
  retrievalTrace.artifact_attachment = {
    requested_count: artifactAttachments.length,
    attached_count: artifactAttachments.filter((selection) => selection.item.approved !== false).length,
    blocked_count: artifactAttachments.filter((selection) => selection.item.approved === false).length,
    artifact_refs: artifactRefs,
    attachment_owner: "explicit_user_selection",
    selection_status: "selected",
  };

  const serialize = (rows: readonly ContextMemoryRow[], includeSystem: boolean) =>
    rows.map((row) => serializeMemoryRow(row, input.userId)).filter((row) => {
      if (includeSystem) return true;
      return row.scope !== "system";
    });

  const pkg = {
    user_memory: serialize(userMemory, false),
    project_folder_memory: serialize(workspaceMemory, false),
    capability_memory: serialize(capabilityMemory, false),
    agent_memory: serialize(agentMemory, false),
    system_policy: serialize(systemPolicy, true),
    recent_session_summary: recentSessionSummary,
    relevant_episodes: serialize(relevantEpisodes, false),
    evidence_items: evidenceSelections.map((selection) => selection.item),
    attachments: artifactAttachments.map((selection) => selection.item),
    active_policies: input.activePolicies.map((policy) => ({
      id: policy.id,
      name: policy.name,
      domain: policy.domain,
      policy_key: policy.policy_key,
      enforcement_mode: policy.enforcement_mode,
      priority: Number(policy.priority),
      policy_json: recordValue(policy.policy_json),
    })),
    stable_prefix_refs: stablePrefixRefs,
    dynamic_tail_refs: dynamicTailRefs,
    source_refs: sourceRefs,
    retrieval_trace: retrievalTrace,
    token_budget: input.tokenBudget,
    personal_context_block: "",
  };
  return pkg as unknown as ContextPackage;
}

export function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
