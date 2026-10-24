import { createHash } from "node:crypto";
import { parse } from "yaml";
import { HttpError, optionalString } from "../routeUtils/common.js";
import type { NormalizedSkill } from "./types.js";

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?/;

export function parseSkillMarkdown(markdown: string, sourcePath = "SKILL.md"): NormalizedSkill {
  const { metadata, body } = splitFrontmatter(markdown);
  const headingName = firstHeading(body);
  const name = optionalString(metadata.name) ?? headingName;
  const description = optionalString(metadata.description) ?? firstParagraph(body);
  if (!name) throw new HttpError(422, "Skill is missing name");
  if (!description) throw new HttpError(422, "Skill is missing description");

  const requestedPermissions = normalizePermissionList(
    metadata["allowed-tools"] ?? metadata.allowed_tools ?? metadata.tools ?? metadata.permissions,
  );
  const referencedResources = normalizeResources(metadata);

  return {
    name,
    description,
    version: optionalString(metadata.version) ?? "0.1.0",
    license: optionalString(metadata.license),
    instructions_markdown: body.trim(),
    resources: [
      {
        path: sourcePath,
        kind: "skill_markdown",
        description: "Primary skill instructions",
        content_hash: sha256(markdown),
      },
      ...referencedResources,
    ],
    requested_permissions: requestedPermissions,
    execution_profile: {
      scripts_present: hasScriptHints(metadata, body),
    },
    vendor_extensions: metadata,
    trust_analysis: {},
  };
}

function splitFrontmatter(markdown: string): {
  metadata: Record<string, unknown>;
  body: string;
} {
  const match = markdown.match(FRONTMATTER_RE);
  if (!match) return { metadata: {}, body: markdown };
  let parsed: unknown;
  try {
    parsed = parse(match[1] ?? "");
  } catch {
    throw new HttpError(422, "Skill frontmatter is not valid YAML");
  }
  const metadata =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  return { metadata, body: markdown.slice(match[0].length) };
}

function firstHeading(markdown: string): string | null {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match ? match[1]!.trim() : null;
}

function firstParagraph(markdown: string): string | null {
  for (const block of markdown.split(/\n\s*\n/)) {
    const text = block
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && !line.startsWith("```"))
      .join(" ")
      .trim();
    if (text) return text;
  }
  return null;
}

function normalizePermissionList(value: unknown): string[] {
  if (typeof value === "string") {
    return value
      .split(/[,\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value
      .flatMap((item) => (typeof item === "string" ? [item] : []))
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>).sort();
  }
  return [];
}

function normalizeResources(metadata: Record<string, unknown>): NormalizedSkill["resources"] {
  const out: NormalizedSkill["resources"] = [];
  appendResources(out, metadata.references, "reference");
  appendResources(out, metadata.resources, "resource");
  appendResources(out, metadata.assets, "asset");
  return out;
}

function appendResources(
  out: NormalizedSkill["resources"],
  value: unknown,
  defaultKind: string,
): void {
  if (value === undefined || value === null) return;
  const items = Array.isArray(value) ? value : [value];
  for (const item of items) {
    if (typeof item === "string") {
      const path = item.trim();
      if (path) out.push({ path, kind: defaultKind });
      continue;
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const path = optionalString(record.path) ?? optionalString(record.file) ?? optionalString(record.href);
    if (!path) continue;
    out.push({
      path,
      kind: optionalString(record.kind) ?? defaultKind,
      description: optionalString(record.description),
    });
  }
}

function hasScriptHints(metadata: Record<string, unknown>, body: string): boolean {
  const text = `${JSON.stringify(metadata)}\n${body}`.toLowerCase();
  return /\b(script|scripts|bash|shell|npm|pnpm|pip|python|subprocess)\b/.test(text);
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
