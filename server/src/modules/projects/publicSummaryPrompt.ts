import {
  HttpError,
  dateIso,
  optionalString,
  stringArray,
} from "../routeUtils/common.js";
import { shouldRedactMemoryContent } from "../memory/memoryReadAuth.js";

export const PROJECT_PUBLIC_SUMMARY_PROMPT_VERSION = "project_public_summary.prompt.v1";
export const PROJECT_PUBLIC_SUMMARY_REDACTION_VERSION = "project_public_summary.v1";

const CONTEXT_MAX_CHARS = 14_000;

export interface PublicSummarySourceRef {
  source_type: string;
  source_id: string;
  label?: string;
  trust_level?: string;
}

export interface PublicSummaryPromptContext {
  project: {
    id: string;
    name: string;
    description: string | null;
    current_focus: string | null;
  };
  viewerUserId: string;
  memories: Array<{
    id: string;
    namespace: string | null;
    memory_type: string;
    title: string | null;
    content: string | null;
    visibility: string | null;
    owner_user_id: string | null;
    sensitivity_level: string | null;
    tags: unknown;
  }>;
  activities: Array<{
    id: string;
    activity_type: string;
    title: string | null;
    content: string | null;
    occurred_at: unknown;
  }>;
  artifacts: Array<{
    id: string;
    artifact_type: string;
    title: string;
    mime_type: string | null;
    created_at: unknown;
  }>;
  proposals: Array<{
    id: string;
    proposal_type: string;
    status: string;
    title: string;
    rationale: string | null;
    created_at: unknown;
  }>;
  allowedSourceRefs: Map<string, PublicSummarySourceRef>;
}

export interface GeneratedPublicSummary {
  summary_text: string;
  topics: string[];
  highlights: string[];
  source_refs: PublicSummarySourceRef[];
  redaction_version: string;
  review_status: "draft";
}

export function buildProjectPublicSummaryPrompt(
  context: PublicSummaryPromptContext,
): { system: string; user: string } {
  const system = [
    "You generate a space-public Project Public Summary.",
    "The reader may not have permission to read this project's concrete memory, memos, docs, artifacts, or files.",
    "Use only the provided input. Write high-level, redacted discovery metadata.",
    "Do not include raw private memory, memo/document excerpts, file content, credentials, private URLs, secrets, personal notes, customer/user identifiers, exact implementation details that would reveal private work, or any sensitive operational detail.",
    "Prefer broad project purpose, reusable ideas, domain themes, current focus, non-sensitive capabilities, and safe cross-project inspiration.",
    "Return JSON only, with no markdown fence or preamble.",
  ].join(" ");

  const lines = [
    `Prompt version: ${PROJECT_PUBLIC_SUMMARY_PROMPT_VERSION}`,
    "",
    "Output schema:",
    JSON.stringify({
      summary_text: "2-5 concise sentences, safe to show to every member of this space.",
      topics: ["3-12 public search aliases or broad themes"],
      highlights: ["1-6 high-level reusable insights or current directions"],
      source_refs: [
        {
          source_type: "project|memory|activity|artifact|proposal",
          source_id: "must be one of the provided source ids",
          label: "short public label",
          trust_level: "owner_reviewed|agent_generated|derived",
        },
      ],
      redaction_version: PROJECT_PUBLIC_SUMMARY_REDACTION_VERSION,
      review_status: "draft",
    }, null, 2),
    "",
    "Project:",
    `- id: ${context.project.id}`,
    `- name: ${context.project.name}`,
    context.project.description ? `- description: ${compactText(context.project.description, 600)}` : null,
    context.project.current_focus ? `- current_focus: ${compactText(context.project.current_focus, 400)}` : null,
    "",
    "Allowed source ids:",
    ...[...context.allowedSourceRefs.values()].map((ref) =>
      `- ${ref.source_type}:${ref.source_id} (${compactText(ref.label ?? ref.source_type, 100)})`,
    ),
    "",
    "Readable project context:",
    section("Memories", context.memories.map((memory) => memoryLine(memory, context.viewerUserId))),
    section("Activities", context.activities.map(activityLine)),
    section("Artifacts", context.artifacts.map(artifactLine)),
    section("Proposals", context.proposals.map(proposalLine)),
    "",
    "Generate one draft JSON object now. Set review_status to draft.",
  ].filter((line): line is string => typeof line === "string");

  return { system, user: lines.join("\n").slice(0, CONTEXT_MAX_CHARS) };
}

export function parseGeneratedPublicSummary(
  text: string,
  allowedRefs: Map<string, PublicSummarySourceRef>,
): GeneratedPublicSummary {
  const parsed = parseJsonObject(text);
  const summaryText = optionalString(parsed.summary_text);
  if (!summaryText) throw new HttpError(502, "Provider returned invalid project summary: summary_text is required");
  const topics = publicStringList(parsed.topics);
  const highlights = publicStringList(parsed.highlights);
  const sourceRefs = filterSourceRefs(parsed.source_refs, allowedRefs);
  return {
    summary_text: summaryText,
    topics,
    highlights,
    source_refs: sourceRefs.length > 0 ? sourceRefs : firstAllowedSourceRef(allowedRefs),
    redaction_version: PROJECT_PUBLIC_SUMMARY_REDACTION_VERSION,
    review_status: "draft",
  };
}

export function sourceKey(sourceType: string, sourceId: string): string {
  return `${sourceType}:${sourceId}`;
}

function parseJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)?.[1]?.trim();
  const candidate = fenced ?? jsonObjectSlice(trimmed);
  try {
    const parsed = JSON.parse(candidate);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(502, "Provider returned invalid project summary JSON");
  }
}

function jsonObjectSlice(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}

function filterSourceRefs(
  value: unknown,
  allowedRefs: Map<string, PublicSummarySourceRef>,
): PublicSummarySourceRef[] {
  if (!Array.isArray(value)) return [];
  const out: PublicSummarySourceRef[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const sourceType = normalizeSourceType(optionalString(record.source_type));
    const sourceId = optionalString(record.source_id);
    if (!sourceType || !sourceId) continue;
    const key = sourceKey(sourceType, sourceId);
    const allowed = allowedRefs.get(key);
    if (!allowed || seen.has(key)) continue;
    seen.add(key);
    out.push({
      source_type: sourceType,
      source_id: sourceId,
      label: optionalString(record.label) ?? allowed.label,
      trust_level: optionalString(record.trust_level) ?? allowed.trust_level,
    });
  }
  return out.slice(0, 12);
}

function normalizeSourceType(value: string | null): string | null {
  if (!value) return null;
  if (value === "memory_entry") return "memory";
  if (["project", "memory", "activity", "artifact", "proposal"].includes(value)) return value;
  return null;
}

function firstAllowedSourceRef(allowedRefs: Map<string, PublicSummarySourceRef>): PublicSummarySourceRef[] {
  const first = allowedRefs.values().next().value;
  return first ? [first] : [];
}

function publicStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const normalized = item.trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out.slice(0, 32);
}

function section(title: string, rows: string[]): string {
  if (rows.length === 0) return `## ${title}\n- none`;
  return `## ${title}\n${rows.join("\n")}`;
}

function memoryLine(row: PublicSummaryPromptContext["memories"][number], viewerUserId: string): string {
  const tags = stringArray(row.tags).slice(0, 8).join(", ");
  const sensitive = row.sensitivity_level === "sensitive" || row.sensitivity_level === "restricted";
  const redacted = sensitive || shouldRedactMemoryContent(row, viewerUserId);
  const content = redacted ? null : compactText(row.content ?? "", 280);
  return [
    `- memory:${row.id}`,
    `type=${row.memory_type}`,
    row.namespace ? `namespace=${row.namespace}` : null,
    row.title ? `title=${compactText(row.title, 120)}` : null,
    tags ? `tags=${tags}` : null,
    content ? `excerpt=${content}` : null,
  ].filter(Boolean).join(" | ");
}

function activityLine(row: PublicSummaryPromptContext["activities"][number]): string {
  return [
    `- activity:${row.id}`,
    `type=${row.activity_type}`,
    row.title ? `title=${compactText(row.title, 120)}` : null,
    row.content ? `excerpt=${compactText(row.content, 220)}` : null,
    dateIso(row.occurred_at) ? `occurred_at=${dateIso(row.occurred_at)}` : null,
  ].filter(Boolean).join(" | ");
}

function artifactLine(row: PublicSummaryPromptContext["artifacts"][number]): string {
  return [
    `- artifact:${row.id}`,
    `type=${row.artifact_type}`,
    `title=${compactText(row.title, 140)}`,
    row.mime_type ? `mime=${row.mime_type}` : null,
    dateIso(row.created_at) ? `created_at=${dateIso(row.created_at)}` : null,
  ].filter(Boolean).join(" | ");
}

function proposalLine(row: PublicSummaryPromptContext["proposals"][number]): string {
  return [
    `- proposal:${row.id}`,
    `type=${row.proposal_type}`,
    `status=${row.status}`,
    `title=${compactText(row.title, 140)}`,
    row.rationale ? `rationale=${compactText(row.rationale, 180)}` : null,
    dateIso(row.created_at) ? `created_at=${dateIso(row.created_at)}` : null,
  ].filter(Boolean).join(" | ");
}

function compactText(value: string, maxChars: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > maxChars ? `${text.slice(0, maxChars - 1).trim()}...` : text;
}
