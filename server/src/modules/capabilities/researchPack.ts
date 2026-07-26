import type {
  CapabilityDefinition,
  CapabilityPackDescriptor,
  CapabilityRuntimeBinding,
  WorkflowTemplate,
} from "./types";

const RESEARCH_ARTIFACT_TYPES = [
  "research_report.archive.v1",
];
const RESEARCH_WORKFLOW_CAPABILITY_IDS = [
  "research.source_collect",
  "research.source_summarize",
  "research.evidence_extract",
  "research.brief_synthesize",
  "research.idea_generate",
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
    "Analyze a bounded notebook and paper selection and propose a reviewed Research Area update.",
    [],
  ),
  researchCapability(
    "research.ask",
    "Ask AI",
    "Hold a multi-turn conversation grounded in the notebook and selected papers, optionally proposing a reviewable notebook edit.",
    [],
  ),
  researchCapability(
    "research.monitor_compare",
    "Monitoring Evidence Comparison",
    "Compare newly screened evidence with the project's current research understanding.",
    [],
  ),
];

function workflow(
  id: string,
  name: string,
  description: string,
  outputArtifactTypes: string[],
): WorkflowTemplate {
  return {
    id,
    name,
    description,
    category: "research",
    capability_ids: RESEARCH_WORKFLOW_CAPABILITY_IDS,
    input_schema_json: {
      type: "object",
      properties: {
        query: { type: "string" },
        source_mode: {
          type: "string",
          enum: ["runtime_native", "project_sources", "manual_urls"],
        },
      },
      required: ["query"],
      additionalProperties: true,
    },
    default_config_json: {
      source_mode: "project_sources",
      output_artifact_types: outputArtifactTypes,
      proposal_policy: "review_required",
    },
    output_artifact_types: outputArtifactTypes,
    proposal_policy: {
      memory_writes: "proposal_only",
      capability_changes: "proposal_required",
    },
    recommended_runtime_adapters: ["model_api", "claude_code", "codex_cli"],
    execution_shape: "structured_generation",
    required_capabilities: [],
    required_tools: [],
    prompt_asset_keys: [`workflow.${id}.run`],
  };
}

export const RESEARCH_WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  workflow(
    "research.academic_literature_review",
    "Academic Literature Review",
    "Review academic sources and synthesize cited findings into a research brief.",
    ["research_report.archive.v1"],
  ),
  workflow(
    "research.news_scan",
    "News Scan",
    "Scan time-sensitive sources and produce a cited summary of developments.",
    ["research_report.archive.v1"],
  ),
  workflow(
    "research.market_research",
    "Market Research",
    "Compare market sources, extract evidence, and produce brief findings and candidate ideas.",
    ["research_report.archive.v1"],
  ),
  workflow(
    "research.technical_survey",
    "Technical Survey",
    "Survey technical sources and synthesize implementation-relevant findings.",
    ["research_report.archive.v1"],
  ),
];

export const RESEARCH_PACK: CapabilityPackDescriptor = {
  id: "research",
  name: "Research Skills",
  description: "Built-in research capabilities and reusable research modes.",
  version: "0.1.0",
  capability_ids: RESEARCH_CAPABILITIES.map((capability) => capability.id),
  workflow_template_ids: RESEARCH_WORKFLOW_TEMPLATES.map((template) => template.id),
  artifact_types: RESEARCH_ARTIFACT_TYPES,
  source_kind: "builtin",
  status: "available",
};
