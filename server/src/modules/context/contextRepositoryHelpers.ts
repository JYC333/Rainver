import { canReadMemory } from "../memory/memoryReadAuth";
import type { OversightMode } from "../access/contentAccessTypes";
import type {
  ContextEvidenceSelection,
  ContextMemoryRow,
  PolicyRow,
} from "./repository";

export interface EvidenceContextRow {
  id: string;
  title: string;
  content_excerpt: string | null;
  evidence_type: string;
  trust_level: string;
  source_item_id: string | null;
  source_snapshot_id: string | null;
  artifact_id: string | null;
  source_uri: string | null;
  source_connection_id: string | null;
  link_id: string;
  link_type: string;
  target_type: string;
  target_id: string | null;
}

export function resolveReadableScopes(
  policy: Record<string, unknown> | null,
  includeSystemScope: boolean,
): Set<string> {
  const all = new Set([
    "system",
    "space",
    "user",
    "project_folder",
    "capability",
    "agent",
  ]);
  const declared = policy?.readable_scopes;
  const scopes =
    Array.isArray(declared) && declared.length > 0
      ? new Set(declared.filter((s): s is string => all.has(String(s))))
      : all;
  if (!includeSystemScope) scopes.delete("system");
  return scopes;
}

export function hardFilterRows(
  rows: readonly ContextMemoryRow[],
  input: {
    spaceId: string;
    userId: string;
    projectFolderId: string | null;
    includeSystemScope: boolean;
    oversightLevel?: OversightMode;
    // When present, project cutting is active: only project-free memory
    // (`project_id IS NULL`) and the single `allowedProjectId` survive; memory of
    // any other project is dropped. Absent means unscoped — no project filter.
    projectFilter?: { allowedProjectId: string | null };
  },
): ContextMemoryRow[] {
  return rows.filter((row) => {
    if (
      !canReadMemory(row, {
        userId: input.userId,
        spaceId: input.spaceId,
        projectFolderId: input.projectFolderId,
        includeSystemScope:
          input.includeSystemScope && row.scope_type === "system",
        oversightLevel: input.oversightLevel,
      })
    ) {
      return false;
    }
    if (input.projectFilter) {
      const projectId = row.project_id ?? null;
      if (projectId !== null && projectId !== input.projectFilter.allowedProjectId) {
        return false;
      }
    }
    return true;
  });
}

export function assignSection(row: ContextMemoryRow): "stable_prefix" | "dynamic_tail" {
  if (row.memory_layer === "episodic") return "dynamic_tail";
  const scope = row.scope_type ?? "";
  return ["system", "space", "project_folder", "user", "capability", "agent"].includes(
    scope,
  )
    ? "stable_prefix"
    : "dynamic_tail";
}

export function memorySourceRef(
  row: ContextMemoryRow,
  reason: string,
  stage: string,
): Record<string, unknown> {
  return {
    source_type: "memory",
    source_id: row.id,
    reason,
    section: assignSection(row),
    stage,
    source_trust: row.source_trust ?? "internal_system",
    memory_type: row.memory_type,
    memory_layer: row.memory_layer,
    scope_type: row.scope_type,
  };
}

export function policySourceRef(row: PolicyRow): Record<string, unknown> {
  return {
    source_type: "policy",
    source_id: row.id,
    reason: "active_policy",
    section: "stable_prefix",
    stage: "policy_load",
    policy_key: row.policy_key,
    domain: row.domain,
  };
}

export function evidenceSelectionFromRow(
  row: EvidenceContextRow,
): ContextEvidenceSelection {
  const trustMetadata = evidenceTrustToContextMetadata(row.trust_level);
  return {
    item: {
      id: row.id,
      title: row.title,
      content_excerpt: row.content_excerpt,
      evidence_type: row.evidence_type,
      trust_level: row.trust_level,
      source_uri: row.source_uri,
      artifact_id: row.artifact_id,
      link_id: row.link_id,
      target_type: row.target_type,
      target_id: row.target_id,
    },
    ref: {
      source_type: "evidence",
      source_id: row.id,
      evidence_type: row.evidence_type,
      source_item_id: row.source_item_id,
      source_snapshot_id: row.source_snapshot_id,
      artifact_id: row.artifact_id,
      link_id: row.link_id,
      link_type: row.link_type,
      target_type: row.target_type,
      target_id: row.target_id,
      trust_level: row.trust_level,
      ...trustMetadata,
      section: "dynamic_tail",
    },
  };
}

export function numeric(value: number | string | null | undefined): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  return 0;
}

export function addArrayFilter(
  where: string[],
  params: unknown[],
  column: string,
  value: unknown,
): void {
  const items = arrayOfStrings(value);
  if (items.length === 0) return;
  params.push(items);
  where.push(`${column} = ANY($${params.length})`);
}

export function clampMaxItems(value: unknown): number {
  if (typeof value !== "number" && typeof value !== "string") return 10;
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n <= 0) return 10;
  return Math.min(n, 20);
}

export function generatePersonalSummary(memories: readonly ContextMemoryRow[]): string {
  if (memories.length === 0) {
    return "No personal memory entries are available for this context.";
  }
  const kinds = [
    ...new Set(
      memories
        .map((m) => m.memory_type)
        .filter((type): type is string => typeof type === "string" && type.length > 0),
    ),
  ].sort();
  const timestamps = memories
    .map((m) => isoTime(m.updated_at) ?? isoTime(m.created_at))
    .filter((v): v is string => v !== null)
    .sort();
  const mostRecent = timestamps.at(-1);
  const parts = [
    `The user has ${memories.length} relevant personal memory ${
      memories.length === 1 ? "entry" : "entries"
    } available for this context.`,
  ];
  if (kinds.length > 0) parts.push(`Categories: ${kinds.join(", ")}.`);
  if (mostRecent) parts.push(`Most recently updated: ${mostRecent.slice(0, 10)}.`);
  parts.push(
    "Raw memory content is not included in this summary; only aggregate metadata is provided.",
  );
  return parts.join(" ");
}

function evidenceTrustToContextMetadata(value: string | null): Record<string, string> {
  const trust = value || "normal";
  if (!["trusted", "normal", "untrusted"].includes(trust)) {
    throw new Error(`Unsupported evidence trust level for context metadata: ${trust}`);
  }
  return { provenance_trust: trust };
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && v.length > 0)
    : [];
}

function isoTime(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.trim()) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}
