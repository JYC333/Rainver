import type {
  CapabilityDefinition,
  CapabilityPackDescriptor,
  CapabilityRuntimeBinding,
} from "./types";

const RESEARCH_ARTIFACT_TYPES = [
  "research_report.archive.v1",
];
function binding(
  capabilityId: string,
  runtime: string,
  renderMode: CapabilityRuntimeBinding["render_mode"],
): CapabilityRuntimeBinding {
  return {
    id: `${capabilityId}:${runtime}:${renderMode}`,
    capability_id: capabilityId,
    runtime_adapter_type: runtime,
    render_mode: renderMode,
    binding_json: {},
    enabled: true,
  };
}

function researchCapability(
  id: string,
  name: string,
  description: string,
  outputArtifactTypes: string[],
): CapabilityDefinition {
  return {
    id,
    namespace: "research",
    name,
    description,
    version: "0.1.0",
    source_kind: "builtin",
    input_schema_json: {
      type: "object",
      additionalProperties: true,
    },
    output_artifact_types: outputArtifactTypes,
    permissions: {
      network: "profile_controlled",
      filesystem: "workspace_scoped",
      memory_writes: "proposal_only",
    },
    supported_execution_modes: ["runtime_native", "project_sources", "manual_urls"],
    default_runtime_bindings: [
      binding(id, "model_api", "inline_prompt"),
      binding(id, "claude_code", "render_skill"),
      binding(id, "codex_cli", "render_skill"),
    ],
    status: "available",
  };
}

export const RESEARCH_CAPABILITIES: CapabilityDefinition[] = [
  researchCapability(
    "research.source_collect",
    "Source Collection",
    "Collect candidate sources from project sources, manual URLs, or runtime-native source tools.",
    ["research_report.archive.v1"],
  ),
  researchCapability(
    "research.source_summarize",
    "Source Summarization",
    "Summarize source material with citations and stated uncertainty.",
    ["research_report.archive.v1"],
  ),
  researchCapability(
    "research.evidence_extract",
    "Evidence Extraction",
    "Extract structured evidence, claims, and provenance from source material.",
    ["research_report.archive.v1"],
  ),
  researchCapability(
    "research.brief_synthesize",
    "Brief Synthesis",
    "Synthesize cited evidence into a concise research brief.",
    ["research_report.archive.v1"],
  ),
  researchCapability(
    "research.idea_generate",
    "Idea Generation",
    "Generate candidate ideas, questions, or follow-up directions from research evidence.",
    ["research_report.archive.v1"],
  ),
  researchCapability(
    "research.adhoc_analyze",
    "Ad-hoc Research Analysis",
    "Analyze a bounded note and evidence selection and propose a reviewed Research Area update.",
    [],
  ),
  researchCapability(
    "research.ask",
    "Ask AI",
    "Hold a multi-turn conversation grounded in Project Notes and selected evidence, optionally proposing a reviewable note edit.",
    [],
  ),
  researchCapability(
    "research.monitor_compare",
    "Monitoring Evidence Comparison",
    "Compare newly screened evidence with the project's current research understanding.",
    [],
  ),
];

export const RESEARCH_PACK: CapabilityPackDescriptor = {
  id: "research",
  name: "Research Skills",
  description: "Built-in reusable research capabilities.",
  version: "0.1.0",
  capability_ids: RESEARCH_CAPABILITIES.map((capability) => capability.id),
  artifact_types: RESEARCH_ARTIFACT_TYPES,
  source_kind: "builtin",
  status: "available",
};
