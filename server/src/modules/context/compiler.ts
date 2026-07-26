import { mkdir, writeFile, chmod, readFile } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import type { ContextCompileTarget, ContextPackage, ContextRoutingManifest } from "@agent-space/protocol" with {
  "resolution-mode": "import",
};
import { selectAgentDocPaths } from "./routingManifest";

const DEFAULT_BUDGET_CHARS = 128_000;

// Graduated compaction: try reducing a section to these fractions before dropping it.
const FRACTION_TIERS = [1.0, 0.75, 0.5] as const;

const SECTION_PRIORITY: Record<string, number> = {
  task: 0,
  stable_prefix: 1,
  policy: 1,
  system_policy: 1,
  runtime_skills: 2,
  user_context: 2,
  project_docs: 3,
  workspace: 4,
  capability: 5,
  agent: 6,
  attachments: 7,
  episodes: 8,
  dynamic_tail: 8,
  session: 9,
  tools: 10,
  sandbox: 11,
  validation: 12,
  constraints: 13,
  output_format: 14,
};

const PER_SECTION_CAPS: Record<string, number> = {
  system_policy: 16_000,
  user_context: 8_000,
  project_docs: 24_000,
  workspace: 12_000,
  agent: 8_000,
  attachments: 16_000,
  episodes: 4_000,
  session: 2_000,
  // runtime_skills is mandatory (never dropped), so it must be capped or a large
  // imported SKILL.md inline rendering would push the compiled context past the
  // overall budget instead of compacting.
  runtime_skills: 24_000,
};

const MANDATORY_SECTIONS = new Set(["task", "runtime_skills"]);

const INSTRUCTION_FILENAME: Record<string, string> = {
  claude: "CLAUDE.md",
  codex_cli: "AGENTS.md",
  cursor: ".cursorrules",
  generic: "CONTEXT.md",
  soul: "SOUL.md",
  prompt: "prompt.md",
};

const VENDOR_FILE_HEADER = `<!-- GENERATED FILE - DO NOT EDIT MANUALLY
     This file is compiled from agent-space context at run start.
     Source of truth: agent-space active memory + .agent/ docs.
     Changes here are NOT persisted. Use the agent-space UI to update memory.
-->

`;

const CLAUDE_SETTINGS = JSON.stringify(
  {
    permissions: {
      // Claude Code's runtime-internal Task tool is not a server-owned
      // delegation channel. Keep it disabled unless a future conformance
      // change explicitly updates this runtime policy.
      deny: ["Task"],
    },
    hooks: {
      PostToolUse: [
        {
          matcher: "Edit|Write",
          hooks: [
            {
              type: "command",
              command: "bash .claude/hooks/check-docs-sync.sh",
            },
          ],
        },
      ],
    },
  },
  null,
  2,
);

const HOOK_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
input=$(cat)
file_path=$(python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get('tool_input', {}).get('file_path', ''))
except Exception:
    print('')
" 2>/dev/null <<< "$input")
[[ -z "$file_path" ]] && exit 0
case "$file_path" in
  */server/src/modules/*|*/packages/protocol/src/*|*/apps/web/src/modules/*)
    echo "DOCS SYNC: '$file_path' edited inside sandbox. Mention relevant .agent docs or context routing updates in your output."
    ;;
esac
exit 0
`;

export interface CompiledContext {
  target: ContextCompileTarget;
  task_prompt: string;
  instruction_file_path: string | null;
  total_chars: number;
  budget_chars: number;
  dropped_sections: string[];
  budget_trace: Record<string, unknown>;
}

export class ContextCompiler {
  async compile(input: {
    context: ContextPackage;
    target: string | null;
    taskGoal: string;
    sandboxDir?: string | null;
    workspacePath?: string | null;
    touchedFiles?: readonly string[] | null;
    budgetChars?: number | null;
    stablePrefixText?: string | null;
    dynamicTailText?: string | null;
    runtimeSkillText?: string | null;
    routingManifest?: ContextRoutingManifest | null;
  }): Promise<CompiledContext> {
    const target = normalizeTarget(input.target);
    const agentDocs = await loadAgentDocs(
      input.workspacePath ?? null,
      input.touchedFiles ?? [],
      input.routingManifest ?? null,
    );
    const sections =
      input.stablePrefixText !== undefined || input.dynamicTailText !== undefined
        ? buildPreparedSections(
            input.taskGoal,
            agentDocs,
            input.stablePrefixText ?? "",
            input.dynamicTailText ?? "",
            input.runtimeSkillText ?? "",
          )
        : buildSections(input.context, input.taskGoal, agentDocs);
    const budgetChars = input.budgetChars ?? DEFAULT_BUDGET_CHARS;
    const { markdown, dropped, trace } = applyBudget(sections, budgetChars);
    const fullMarkdown = VENDOR_FILE_HEADER + markdown;

    let instructionFilePath: string | null = null;
    if (input.sandboxDir) {
      await assertSandboxOnly(input.sandboxDir, input.workspacePath ?? null);
      await mkdir(input.sandboxDir, { recursive: true });
      const filename = INSTRUCTION_FILENAME[target] ?? "CONTEXT.md";
      instructionFilePath = join(input.sandboxDir, filename);
      await writeFile(instructionFilePath, fullMarkdown, "utf8");

      if (target === "claude") {
        const agentPersona = renderAgentPersona(input.context);
        if (agentPersona) {
          await writeFile(
            join(input.sandboxDir, "SOUL.md"),
            VENDOR_FILE_HEADER + agentPersona,
            "utf8",
          );
        }
      }
      const hooksDir = join(input.sandboxDir, ".claude", "hooks");
      await mkdir(hooksDir, { recursive: true });
      await writeFile(join(input.sandboxDir, ".claude", "settings.json"), CLAUDE_SETTINGS, "utf8");
      const hookPath = join(hooksDir, "check-docs-sync.sh");
      await writeFile(hookPath, HOOK_SCRIPT, "utf8");
      await chmod(hookPath, 0o755);
    }

    return {
      target,
      task_prompt: input.taskGoal,
      instruction_file_path: instructionFilePath,
      total_chars: fullMarkdown.length,
      budget_chars: budgetChars,
      dropped_sections: dropped,
      budget_trace: trace,
    };
  }
}

export async function assertSandboxOnly(
  sandboxDir: string,
  workspacePath: string | null,
): Promise<void> {
  if (!workspacePath) return;
  const sandbox = resolve(sandboxDir);
  const workspace = resolve(workspacePath);
  const rel = relative(workspace, sandbox);
  if (sandbox === workspace || (rel && !rel.startsWith("..") && !rel.startsWith("/"))) {
    throw new Error("ContextCompiler refuses to write vendor files inside the real workspace");
  }
}

async function loadAgentDocs(
  workspacePath: string | null,
  touchedFiles: readonly string[],
  routingManifest: ContextRoutingManifest | null,
): Promise<Record<string, string>> {
  if (!workspacePath) return {};
  const docs: Record<string, string> = {};
  for (const path of selectAgentDocPaths({ manifest: routingManifest, touchedFiles })) {
    await readOptional(join(workspacePath, path)).then((content) => {
      if (content) docs[path] = content;
    });
  }
  return docs;
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

function buildSections(
  context: ContextPackage,
  taskGoal: string,
  agentDocs: Record<string, string>,
): Array<[string, string, number]> {
  const sections: Array<[string, string, number]> = [];
  const add = (name: string, text: string) => {
    if (!text.trim()) return;
    sections.push([name, text, SECTION_PRIORITY[name] ?? 99]);
  };

  add("task", `# Task\n\n${taskGoal}`);
  const policiesText = renderPolicies(context.active_policies);
  if (policiesText.trim()) {
    add("policy", `# Active Policies\n\n${policiesText}`);
  }
  add("system_policy", `# System Policy\n\n${renderMemories(context.system_policy, "system")}`);
  add("user_context", `# User Context\n\n${renderMemories(context.user_memory, "user")}`);

  const rootDocs = Object.entries(agentDocs)
    .filter(([key]) => !key.includes("/modules/"))
    .map(([key, content]) => `### ${key}\n\n${content.trim()}`);
  if (rootDocs.length > 0) {
    add("project_docs", `# Project Docs\n\n${rootDocs.join("\n\n---\n\n")}`);
  }
  const moduleDocs = Object.entries(agentDocs)
    .filter(([key]) => key.includes("/modules/"))
    .map(([key, content]) => `### ${key}\n\n${content.trim()}`);
  if (moduleDocs.length > 0) {
    add("project_docs", `# Module Docs\n\n${moduleDocs.join("\n\n---\n\n")}`);
  }

  add(
    "project_folder",
    `# Project Context\n\n${renderMemories(
      [...context.project_folder_memory, ...context.capability_memory],
      "project_folder",
    )}`,
  );
  add("agent", `# Agent Context\n\n${renderMemories(context.agent_memory, "agent")}`);
  add("attachments", `# Attached Context\n\n${renderAttachments(context.attachments)}`);
  add(
    "episodes",
    `# Recent Activity\n\n${renderMemories(context.relevant_episodes.slice(0, 3), "episodic")}`,
  );

  const summaries = context.recent_session_summary
    .slice(0, 2)
    .map((s) => recordValue(s).summary)
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    .map((s) => `- ${s.trim()}`);
  add("session", `# Session History\n\n${summaries.join("\n")}`);

  return sections;
}

function buildPreparedSections(
  taskGoal: string,
  agentDocs: Record<string, string>,
  stablePrefixText: string,
  dynamicTailText: string,
  runtimeSkillText: string,
): Array<[string, string, number]> {
  const sections: Array<[string, string, number]> = [];
  const add = (name: string, text: string) => {
    if (!text.trim()) return;
    sections.push([name, text, SECTION_PRIORITY[name] ?? 99]);
  };

  add("task", `# Task\n\n${taskGoal}`);
  add("stable_prefix", `# Stable Context\n\n${stablePrefixText.trim()}`);
  addAgentDocSections(add, agentDocs);
  add("runtime_skills", runtimeSkillText.trim());
  add("dynamic_tail", `# Dynamic Context\n\n${dynamicTailText.trim()}`);
  return sections;
}

function addAgentDocSections(
  add: (name: string, text: string) => void,
  agentDocs: Record<string, string>,
): void {
  const rootDocs = Object.entries(agentDocs)
    .filter(([key]) => !key.includes("/modules/"))
    .map(([key, content]) => `### ${key}\n\n${content.trim()}`);
  if (rootDocs.length > 0) {
    add("project_docs", `# Project Docs\n\n${rootDocs.join("\n\n---\n\n")}`);
  }
  const moduleDocs = Object.entries(agentDocs)
    .filter(([key]) => key.includes("/modules/"))
    .map(([key, content]) => `### ${key}\n\n${content.trim()}`);
  if (moduleDocs.length > 0) {
    add("project_docs", `# Module Docs\n\n${moduleDocs.join("\n\n---\n\n")}`);
  }
}

function fitToFraction(text: string, fraction: number): string {
  const targetChars = Math.floor(text.length * fraction);
  const slice = text.slice(0, targetChars);
  const lastNewline = slice.lastIndexOf("\n");
  const cutAt = lastNewline > 0 && lastNewline > targetChars * 0.75 ? lastNewline : targetChars;
  const pct = Math.round(fraction * 100);
  return `${text.slice(0, cutAt)}\n\n> [compacted to ${pct}% — token budget]`;
}

function applyBudget(
  sections: Array<[string, string, number]>,
  budgetChars: number,
): { markdown: string; dropped: string[]; trace: Record<string, unknown> } {
  const capped: Array<[string, string, number]> = [];
  const cappedTrace: Record<string, unknown>[] = [];
  for (const [name, text, priority] of sections) {
    const cap = PER_SECTION_CAPS[name];
    if (cap && text.length > cap) {
      const truncated = `${text.slice(0, cap)}\n\n> [truncated - section exceeded per-section cap]`;
      cappedTrace.push({
        section: name,
        original_chars: text.length,
        capped_chars: truncated.length,
        cap,
      });
      capped.push([name, truncated, priority]);
    } else {
      capped.push([name, text, priority]);
    }
  }

  const mandatory = capped.filter(([name]) => MANDATORY_SECTIONS.has(name));
  const optional = capped
    .filter(([name]) => !MANDATORY_SECTIONS.has(name))
    .sort((a, b) => a[2] - b[2]);
  const mandatoryChars = mandatory.reduce((sum, [, text]) => sum + text.length, 0);
  let usedOptional = 0;
  const kept = [...mandatory];
  const dropped: string[] = [];
  const compacted: Array<{ section: string; fraction: number; original_chars: number; compacted_chars: number }> = [];

  for (const [name, text, priority] of optional) {
    let fitted = false;
    for (const fraction of FRACTION_TIERS) {
      const candidate = fraction < 1.0 ? fitToFraction(text, fraction) : text;
      const cost = candidate.length + 8;
      if (mandatoryChars + usedOptional + cost <= budgetChars) {
        kept.push([name, candidate, priority]);
        usedOptional += cost;
        if (fraction < 1.0) {
          compacted.push({ section: name, fraction, original_chars: text.length, compacted_chars: candidate.length });
        }
        fitted = true;
        break;
      }
    }
    if (!fitted) dropped.push(name);
  }

  const sorted = kept.sort((a, b) => a[2] - b[2]);
  const notice =
    dropped.length > 0
      ? `\n\n> **Note:** ${dropped.length} context section(s) omitted to stay within token budget.`
      : "";
  const markdown = `${sorted.map(([, text]) => text).join("\n\n---\n\n")}${notice}`;
  return {
    markdown,
    dropped,
    trace: {
      budget_chars: budgetChars,
      total_chars_before: capped.reduce((sum, [, text]) => sum + text.length, 0),
      total_chars_after: markdown.length,
      mandatory: mandatory.map(([name]) => name),
      capped: cappedTrace,
      dropped,
      compacted,
    },
  };
}

function renderMemories(memories: readonly unknown[], trust: string): string {
  return memories
    .slice(0, 5)
    .map((item) => recordValue(item))
    .map((item) => {
      const title = stringValue(item.title);
      const content = stringValue(item.content);
      if (!content) return "";
      return title
        ? `- **${title}** \`[${trust}]\`: ${content}`
        : `- ${content} \`[${trust}]\``;
    })
    .filter((line) => line.length > 0)
    .join("\n");
}

function renderPolicies(policies: readonly unknown[]): string {
  return policies
    .map((item) => recordValue(item))
    .map((item) => {
      const name = stringValue(item.name) ?? stringValue(item.id) ?? "policy";
      const domain = stringValue(item.domain) ?? "general";
      const mode = stringValue(item.enforcement_mode);
      const detail = JSON.stringify(recordValue(item.policy_json));
      return `- **${name}** \`[${domain}${mode ? `:${mode}` : ""}]\`${detail === "{}" ? "" : `: ${detail}`}`;
    })
    .filter((line) => line.length > 0)
    .join("\n");
}

function renderAttachments(attachments: readonly unknown[]): string {
  return attachments
    .map((item) => recordValue(item))
    .map((item) => {
      if (item.approved === false) {
        return `- [attachment blocked: ${stringValue(item.rejection_reason) ?? "security policy"}]`;
      }
      const label = stringValue(item.label) ?? stringValue(item.attachment_type) ?? "attachment";
      const content = stringValue(item.resolved_content);
      if (!content) return "";
      return `**${label}**:\n\n\`\`\`\n${content}\n\`\`\``;
    })
    .filter((line) => line.length > 0)
    .join("\n\n");
}

function renderAgentPersona(context: ContextPackage): string {
  const lines = context.agent_memory
    .map((item) => recordValue(item))
    .filter((item) => ["preference", "procedural"].includes(stringValue(item.type) ?? ""))
    .slice(0, 8)
    .map((item) => {
      const title = stringValue(item.title);
      const content = stringValue(item.content);
      if (!content) return "";
      return title ? `- **${title}**: ${content}` : `- ${content}`;
    })
    .filter((line) => line.length > 0);
  return lines.length > 0
    ? ["# Agent Identity", "", "This file describes the agent's identity and operating preferences.", "", ...lines].join("\n")
    : "";
}

function normalizeTarget(value: string | null | undefined): ContextCompileTarget {
  if (
    value === "claude" ||
    value === "codex_cli" ||
    value === "cursor" ||
    value === "generic" ||
    value === "soul" ||
    value === "prompt"
  ) {
    return value;
  }
  return "generic";
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
