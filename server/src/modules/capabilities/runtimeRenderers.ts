import type {
  CapabilityDefinition,
  NormalizedSkill,
  RuntimeRenderedSkill,
} from "./types.js";

export function renderClaudeSkill(input: {
  capability: CapabilityDefinition;
  normalizedSkill?: NormalizedSkill | null;
  profile?: Record<string, unknown> | null;
}): RuntimeRenderedSkill {
  const slug = slugify(input.capability.id);
  return {
    runtime_adapter_type: "claude_code",
    render_mode: "render_skill",
    root_path: `.agent-space/generated-skills/claude/${slug}`,
    files: [
      {
        path: `.agent-space/generated-skills/claude/${slug}/SKILL.md`,
        content: renderSkillMarkdown(input, "Claude Code"),
      },
    ],
    prompt_block: null,
  };
}

export function renderCodexSkill(input: {
  capability: CapabilityDefinition;
  normalizedSkill?: NormalizedSkill | null;
  profile?: Record<string, unknown> | null;
}): RuntimeRenderedSkill {
  const slug = slugify(input.capability.id);
  return {
    runtime_adapter_type: "codex_cli",
    render_mode: "render_skill",
    root_path: `.agent-space/generated-skills/codex/${slug}`,
    files: [
      {
        path: `.agent-space/generated-skills/codex/${slug}/SKILL.md`,
        content: renderSkillMarkdown(input, "Codex"),
      },
      {
        path: `.agent-space/generated-skills/codex/${slug}/agents/openai.yaml`,
        content: [
          "schema_version: 1",
          `capability_id: ${JSON.stringify(input.capability.id)}`,
          "source: agent-space-generated",
          "permissions:",
          "  mode: policy_intersection",
          "",
        ].join("\n"),
      },
    ],
    prompt_block: null,
  };
}

export function renderGenericPromptSkill(input: {
  capability: CapabilityDefinition;
  normalizedSkill?: NormalizedSkill | null;
  profile?: Record<string, unknown> | null;
}): RuntimeRenderedSkill {
  return {
    runtime_adapter_type: "model_api",
    render_mode: "inline_prompt",
    root_path: null,
    files: [],
    prompt_block: renderSkillMarkdown(input, "Generic model_api"),
  };
}

export function renderAllRuntimeSkills(input: {
  capability: CapabilityDefinition;
  normalizedSkill?: NormalizedSkill | null;
  profile?: Record<string, unknown> | null;
}): RuntimeRenderedSkill[] {
  return [
    renderClaudeSkill(input),
    renderCodexSkill(input),
    renderGenericPromptSkill(input),
  ];
}

function renderSkillMarkdown(input: {
  capability: CapabilityDefinition;
  normalizedSkill?: NormalizedSkill | null;
  profile?: Record<string, unknown> | null;
}, target: string): string {
  const skill = input.normalizedSkill;
  const lines = [
    `# ${input.capability.name}`,
    "",
    `Capability ID: ${input.capability.id}`,
    `Version: ${input.capability.version}`,
    `Runtime target: ${target}`,
    "",
    "## Description",
    "",
    input.capability.description,
    "",
    "## Output Artifact Types",
    "",
    ...input.capability.output_artifact_types.map((artifactType) => `- ${artifactType}`),
    "",
    "## Instructions",
    "",
    skill?.instructions_markdown?.trim() || "Use the capability definition and project profile to complete the requested work.",
    "",
    "## Governance",
    "",
    "- Treat runtime permissions as the intersection of this skill request and agent-space policy.",
    "- Do not write active memory directly; create proposals where durable memory changes are needed.",
    "- Treat this file as generated adapter content, not source of truth.",
    "",
  ];
  const profile = input.profile && Object.keys(input.profile).length > 0
    ? stableJson(input.profile)
    : null;
  if (profile) {
    lines.push("## Profile", "", "```json", profile, "```", "");
  }
  return lines.join("\n");
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value), null, 2);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, sortJson(item)]),
  );
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "skill";
}

