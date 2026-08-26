import type { MemoryMaintenanceFinding, MemoryMaintenanceReport } from "@rainver/protocol";
import {
  canReadMemory,
  shouldRedactMemoryContent,
} from "./memoryReadAuth.js";
import { accessibleProjectIds } from "./projectAccess.js";
import { MEMORY_COLUMNS, type MemoryRow, type Queryable } from "./repository.js";
import { contentResourceDefinition } from "../access/contentAccessRegistry.js";
import { contentAccessLevelSql, contentReadSql } from "../access/contentAccessSql.js";
import { resolveOversightLevel } from "../access/oversightResolver.js";
import { memorySensitivityReadSql } from "./memorySensitivitySql.js";

const MEMORY_DEFINITION = contentResourceDefinition("memory")!;

export interface MemoryMaintenanceScanInput {
  spaceId: string;
  userId: string;
  limit: number;
  staleAfterDays: number;
  thinContentChars: number;
  maxFindings: number;
  projectId?: string | null;
  scanMode?: "recent" | "full";
  cursor?: string | null;
  /**
   * When true (space_ops review scope), exclude private and restricted memories
   * so the caller's personal memory titles do not appear in space-shared reports.
   */
  excludePersonalVisibility?: boolean;
}

export interface MemoryMaintenanceScanResult {
  report: MemoryMaintenanceReport;
  contributingMemoryIds: string[];
}

interface VisibleMemory {
  row: MemoryRow;
  fullContentReadable: boolean;
}

const FINDING_KINDS = [
  "duplicate",
  "stale",
  "thin",
  "lifecycle_drift",
  "archived_state_drift",
  "project_drift",
  "source_policy_drift",
  "contradiction",
] as const;

export class MemoryMaintenanceService {
  constructor(private readonly db: Queryable) {}

  async scan(input: MemoryMaintenanceScanInput): Promise<MemoryMaintenanceScanResult> {
    const scanMode = input.scanMode ?? "recent";
    const cursor = scanMode === "full" ? decodeCursor(input.cursor ?? null) : null;
    const { candidates, visible } = await this.loadVisibleWindow(input, cursor, scanMode);
    const summaryAccessFullContentUsed = usesSummaryAccessFullContent(visible);

    const findings = [
      ...duplicateFindings(visible),
      ...staleFindings(visible, input.staleAfterDays),
      ...thinFindings(visible, input.thinContentChars),
      ...lifecycleFindings(visible),
      ...archivedStateFindings(visible),
      ...projectDriftFindings(visible),
      ...sourcePolicyDriftFindings(visible),
      ...contradictionFindings(visible),
    ];
    const truncated = findings.length > input.maxFindings;
    const capped = findings.slice(0, input.maxFindings);
    const counts = countsFor(capped);
    const contributingMemoryIds = uniqueMemoryIds(capped);

    return {
      report: {
        findings: capped,
        counts,
        candidate_limit: input.limit,
        candidates_examined: visible.length,
        scanned: visible.length,
        truncated,
        scan_mode: scanMode,
        next_cursor: scanMode === "full" ? nextCursor(candidates, visible, input.limit) : null,
        access_safety: {
          owner_private: true,
          raw_content_included: false,
          snippets_included: false,
          hidden_row_counts_included: false,
          filtered_rows_logged: false,
          summary_access_full_content_used: summaryAccessFullContentUsed,
          cursor_uses_visible_boundary: true,
        },
      },
      contributingMemoryIds,
    };
  }

  private async loadCandidates(
    spaceId: string,
    userId: string,
    limit: number,
    projectId: string | null,
    cursor: MemoryMaintenanceCursor | null,
  ): Promise<MemoryRow[]> {
    const result = await this.db.query<MemoryRow>(
      `SELECT ${MEMORY_COLUMNS},
              ${contentAccessLevelSql({ definition: MEMORY_DEFINITION, alias: "me", userExpr: "$7" })} AS effective_access_level
         FROM memory_entries me
        WHERE space_id = $1
          AND deleted_at IS NULL
          AND status = ANY($2::varchar[])
          AND ($4::varchar IS NULL OR project_id = $4)
          AND (
            $5::timestamptz IS NULL
            OR updated_at < $5::timestamptz
            OR (updated_at = $5::timestamptz AND id < $6::varchar)
          )
          AND ${contentReadSql("memory", "me", "$7")}
          AND ${memorySensitivityReadSql("me", "$7")}
        ORDER BY updated_at DESC, id DESC
        LIMIT $3`,
      [spaceId, ["active", "superseded", "archived"], limit, projectId, cursor?.updatedAt ?? null, cursor?.id ?? null, userId],
    );
    return result.rows;
  }

  private async loadVisibleWindow(
    input: MemoryMaintenanceScanInput,
    initialCursor: MemoryMaintenanceCursor | null,
    scanMode: "recent" | "full",
  ): Promise<{ candidates: MemoryRow[]; visible: VisibleMemory[] }> {
    const oversightLevel = await resolveOversightLevel(this.db, input.spaceId, input.userId);
    let cursor = initialCursor;
    while (true) {
      const candidates = await this.loadCandidates(input.spaceId, input.userId, input.limit, input.projectId ?? null, cursor);
      const visible = await this.visibleCandidates(input, candidates, oversightLevel);
      if (scanMode !== "full" || visible.length > 0 || candidates.length < input.limit) {
        return { candidates, visible };
      }
      const next = physicalCursor(candidates);
      if (!next) return { candidates, visible };
      cursor = next;
    }
  }

  private async visibleCandidates(
    input: MemoryMaintenanceScanInput,
    candidates: readonly MemoryRow[],
    oversightLevel: Parameters<typeof canReadMemory>[1]["oversightLevel"],
  ): Promise<VisibleMemory[]> {
    const readable = candidates.filter((row) => {
      if (isExcludedMaintenanceRow(row)) return false;
      if (input.excludePersonalVisibility) {
        const vis = (row.visibility ?? "private").toLowerCase();
        if (vis === "private" || vis === "selected_users") return false;
      }
      return canReadMemory(row, {
        userId: input.userId,
        spaceId: input.spaceId,
        oversightLevel,
      });
    });
    const projectAccessible = await accessibleProjectIds(
      this.db,
      input.spaceId,
      input.userId,
      readable.map((row) => row.project_id),
    );
    return readable
      .filter((row) => !row.project_id || projectAccessible.has(row.project_id))
      .map((row) => ({
        row,
        fullContentReadable: !shouldRedactMemoryContent(row, input.userId),
      }));
  }
}

function duplicateFindings(memories: VisibleMemory[]): MemoryMaintenanceFinding[] {
  const groups = new Map<string, VisibleMemory[]>();
  for (const memory of memories) {
    if (memory.row.status !== "active") continue;
    const key = duplicateKey(memory);
    if (!key) continue;
    const items = groups.get(key) ?? [];
    items.push(memory);
    groups.set(key, items);
  }
  const findings: MemoryMaintenanceFinding[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    findings.push({
      kind: "duplicate",
      objects: group.slice(0, 6).map((memory) => memoryObject(memory.row)),
      reason: "Multiple visible active memories share the same normalized title or readable content prefix.",
      cluster_key: `duplicate:${duplicateKey(group[0]!) ?? "unknown"}`,
      cluster_label: "Duplicate memories",
      confidence_tier: "high",
      proposed_action: {
        proposal_type: "memory_archive",
        target_memory_ids: group.slice(1, 6).map((memory) => memory.row.id),
      },
    });
  }
  return findings;
}

function staleFindings(memories: VisibleMemory[], staleAfterDays: number): MemoryMaintenanceFinding[] {
  const threshold = Date.now() - staleAfterDays * 24 * 60 * 60 * 1000;
  const findings: MemoryMaintenanceFinding[] = [];
  for (const memory of memories) {
    if (memory.row.status !== "active") continue;
    const timestamp = timestampMs(memory.row.last_confirmed_at) ?? timestampMs(memory.row.updated_at);
    if (timestamp === null || timestamp >= threshold) continue;
    findings.push({
      kind: "stale",
      objects: [memoryObject(memory.row)],
      reason: `Memory has not been confirmed or updated in at least ${staleAfterDays} days.`,
      cluster_key: "stale:unconfirmed",
      cluster_label: "Stale memories",
      confidence_tier: "medium",
      proposed_action: {
        proposal_type: "memory_update",
        target_memory_id: memory.row.id,
        maintenance_action: "reconfirm_stale_memory",
      },
    });
  }
  return findings;
}

function thinFindings(memories: VisibleMemory[], thinContentChars: number): MemoryMaintenanceFinding[] {
  const findings: MemoryMaintenanceFinding[] = [];
  for (const memory of memories) {
    if (memory.row.status !== "active" || !memory.fullContentReadable) continue;
    const content = memory.row.content?.trim() ?? "";
    if (content.length >= thinContentChars) continue;
    findings.push({
      kind: "thin",
      objects: [memoryObject(memory.row)],
      reason: `Readable content is shorter than ${thinContentChars} characters.`,
      cluster_key: "thin:short_readable_content",
      cluster_label: "Thin memories",
      confidence_tier: "medium",
      proposed_action: {
        proposal_type: "memory_update",
        target_memory_id: memory.row.id,
        maintenance_action: "enrich_thin_memory",
      },
    });
  }
  return findings;
}

function lifecycleFindings(memories: VisibleMemory[]): MemoryMaintenanceFinding[] {
  const findings: MemoryMaintenanceFinding[] = [];
  for (const memory of memories) {
    if (memory.row.status === "superseded" && !memory.row.supersedes_memory_id) {
      findings.push({
        kind: "lifecycle_drift",
        objects: [memoryObject(memory.row)],
        reason: "Memory is marked superseded but does not point at the superseding memory.",
        cluster_key: "lifecycle:superseded_without_pointer",
        cluster_label: "Lifecycle drift",
        confidence_tier: "low",
        proposed_action: {
          proposal_type: "memory_update",
          target_memory_id: memory.row.id,
          maintenance_action: "review_missing_superseding_memory",
          requires_operator_edit: true,
        },
      });
    }
    if (memory.row.status === "active" && memory.row.supersedes_memory_id) {
      findings.push({
        kind: "lifecycle_drift",
        objects: [memoryObject(memory.row)],
        reason: "Active memory still carries a supersedes pointer and may need lifecycle review.",
        cluster_key: "lifecycle:active_with_supersedes_pointer",
        cluster_label: "Lifecycle drift",
        confidence_tier: "medium",
        proposed_action: {
          proposal_type: "memory_update",
          target_memory_id: memory.row.id,
          maintenance_action: "clear_active_supersedes_pointer",
        },
      });
    }
  }
  return findings;
}

function archivedStateFindings(memories: VisibleMemory[]): MemoryMaintenanceFinding[] {
  const findings: MemoryMaintenanceFinding[] = [];
  for (const memory of memories) {
    if (memory.row.status !== "archived") continue;
    if (!memory.row.supersedes_memory_id && !memory.row.root_memory_id) continue;
    findings.push({
      kind: "archived_state_drift",
      objects: [memoryObject(memory.row)],
      reason: "Archived memory still carries lifecycle pointers and should be reviewed for stale state.",
      cluster_key: "archived_state:lifecycle_pointer",
      cluster_label: "Archived state drift",
      confidence_tier: "low",
      proposed_action: {
        proposal_type: "memory_update",
        target_memory_id: memory.row.id,
        maintenance_action: "review_archived_lifecycle_state",
        requires_operator_edit: true,
      },
    });
  }
  return findings;
}

function projectDriftFindings(memories: VisibleMemory[]): MemoryMaintenanceFinding[] {
  const findings: MemoryMaintenanceFinding[] = [];
  for (const memory of memories) {
    if (memory.row.status !== "active" || !memory.row.project_id) continue;
    if ((memory.row.scope_type ?? "").toLowerCase() === "project") continue;
    findings.push({
      kind: "project_drift",
      objects: [memoryObject(memory.row)],
      reason: "Memory is linked to a Project but is not scoped as project memory.",
      cluster_key: `project_drift:${memory.row.project_id}`,
      cluster_label: "Project scope drift",
      confidence_tier: "medium",
      proposed_action: {
        proposal_type: "memory_update",
        target_memory_id: memory.row.id,
        maintenance_action: "align_project_scope",
        target_scope: "project",
        project_id: memory.row.project_id,
      },
    });
  }
  return findings;
}

function sourcePolicyDriftFindings(memories: VisibleMemory[]): MemoryMaintenanceFinding[] {
  const findings: MemoryMaintenanceFinding[] = [];
  for (const memory of memories) {
    if (memory.row.status !== "active") continue;
    const trust = (memory.row.source_trust ?? "").toLowerCase();
    if (!trust.includes("external") || memory.row.source_id) continue;
    findings.push({
      kind: "source_policy_drift",
      objects: [memoryObject(memory.row)],
      reason: "External-trust memory has no source reference available for source-policy review.",
      cluster_key: "source_policy:external_without_source",
      cluster_label: "Source policy drift",
      confidence_tier: "low",
      proposed_action: {
        proposal_type: "memory_update",
        target_memory_id: memory.row.id,
        maintenance_action: "attach_or_review_external_source",
        requires_operator_edit: true,
      },
    });
  }
  return findings;
}

function contradictionFindings(memories: VisibleMemory[]): MemoryMaintenanceFinding[] {
  const groups = new Map<string, VisibleMemory[]>();
  for (const memory of memories) {
    if (memory.row.status !== "active" || !memory.fullContentReadable) continue;
    const title = normalizeText(memory.row.title);
    const content = normalizeText(memory.row.content);
    if (!title || !content) continue;
    const items = groups.get(title) ?? [];
    items.push(memory);
    groups.set(title, items);
  }
  const findings: MemoryMaintenanceFinding[] = [];
  for (const group of groups.values()) {
    const affirmative = group.find((memory) => !hasNegation(memory.row.content));
    const negative = group.find((memory) => hasNegation(memory.row.content));
    if (!affirmative || !negative || affirmative.row.id === negative.row.id) continue;
    findings.push({
      kind: "contradiction",
      objects: [memoryObject(affirmative.row), memoryObject(negative.row)],
      reason: "Visible memories with the same normalized title appear to disagree by deterministic negation signal.",
      cluster_key: `contradiction:${normalizeText(affirmative.row.title) ?? "untitled"}`,
      cluster_label: "Memory contradictions",
      confidence_tier: "low",
      proposed_action: {
        proposal_type: "memory_update",
        target_memory_id: affirmative.row.id,
        maintenance_action: "review_contradiction",
        related_memory_ids: [negative.row.id],
        requires_operator_edit: true,
      },
    });
  }
  return findings;
}

function usesSummaryAccessFullContent(memories: readonly VisibleMemory[]): boolean {
  return memories.some(
    (memory) =>
      memory.row.status === "active" &&
      memory.fullContentReadable &&
      (memory.row.access_level ?? "full").toLowerCase() === "summary",
  );
}

function duplicateKey(memory: VisibleMemory): string | null {
  const title = normalizeText(memory.row.title);
  if (title) return `title:${title}`;
  if (!memory.fullContentReadable) return null;
  const content = normalizeText(memory.row.content);
  return content && content.length >= 24 ? `content:${content.slice(0, 120)}` : null;
}

function countsFor(findings: readonly MemoryMaintenanceFinding[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const kind of FINDING_KINDS) counts[kind] = 0;
  for (const finding of findings) counts[finding.kind] = (counts[finding.kind] ?? 0) + 1;
  return counts;
}

function uniqueMemoryIds(findings: readonly MemoryMaintenanceFinding[]): string[] {
  const ids: string[] = [];
  for (const finding of findings) {
    for (const object of finding.objects) {
      if (!ids.includes(object.object_id)) ids.push(object.object_id);
    }
  }
  return ids;
}

function memoryObject(row: MemoryRow): { object_type: "memory_entry"; object_id: string; title: string | null } {
  return {
    object_type: "memory_entry",
    object_id: row.id,
    title: row.title ?? null,
  };
}

function isExcludedMaintenanceRow(row: MemoryRow): boolean {
  if ((row.sensitivity_level ?? "normal").toLowerCase() === "highly_restricted") return true;
  return false;
}

function normalizeText(value: string | null): string | null {
  const normalized = value?.toLowerCase().replace(/\s+/g, " ").trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function timestampMs(value: unknown): number | null {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isNaN(time) ? null : time;
  }
  if (typeof value === "string" && value.trim()) {
    const time = new Date(value).getTime();
    return Number.isNaN(time) ? null : time;
  }
  return null;
}

interface MemoryMaintenanceCursor {
  updatedAt: string;
  id: string;
}

function nextCursor(
  candidates: readonly MemoryRow[],
  visible: readonly VisibleMemory[],
  limit: number,
): string | null {
  if (candidates.length < limit || visible.length === 0) return null;
  const boundary = visible[visible.length - 1]!.row;
  const updatedAt = isoString(boundary.updated_at);
  if (!updatedAt || !boundary.id) return null;
  return Buffer.from(JSON.stringify({ updated_at: updatedAt, id: boundary.id }), "utf8").toString("base64url");
}

function physicalCursor(candidates: readonly MemoryRow[]): MemoryMaintenanceCursor | null {
  const boundary = candidates[candidates.length - 1];
  if (!boundary) return null;
  const updatedAt = isoString(boundary.updated_at);
  if (!updatedAt || !boundary.id) return null;
  return { updatedAt, id: boundary.id };
}

function decodeCursor(value: string | null): MemoryMaintenanceCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    const updatedAt = typeof parsed.updated_at === "string" ? parsed.updated_at : "";
    const id = typeof parsed.id === "string" ? parsed.id : "";
    if (!updatedAt || !id || Number.isNaN(Date.parse(updatedAt))) return null;
    return { updatedAt, id };
  } catch {
    return null;
  }
}

function isoString(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return null;
}

function hasNegation(value: string | null): boolean {
  const normalized = ` ${normalizeText(value) ?? ""} `;
  return /\b(no|not|never|without|cannot|can't|won't|isn't|aren't|doesn't|don't)\b/.test(normalized);
}
