import type { Queryable, SpaceUserIdentity } from "../routeUtils/common.js";

export type ProjectAttentionSeverity = "low" | "normal" | "high" | "critical";

// Wire shape for `ProjectAttentionItem` (plan section 8). Computed on demand
// from registered domain adapters — never stored, never authoritative, and
// never a substitute for the owning Domain's own lifecycle/status.
export interface ProjectAttentionItem {
  id: string;
  project_id: string;
  area_kind: string;
  source_type: string;
  source_id: string;
  severity: ProjectAttentionSeverity;
  title: string;
  summary: string | null;
  reason: string | null;
  due_at: string | null;
  blocking_refs: string[];
  action_descriptors: Array<{ label: string; href: string }>;
  href: string;
}

export interface ProjectAttentionAdapter {
  areaKind: string;
  listAttentionItems(
    db: Queryable,
    identity: SpaceUserIdentity,
    projectId: string,
  ): Promise<ProjectAttentionItem[]>;
}

/**
 * Each Mode/Capability module registers its own attention adapter here at
 * module init. `modules/projects` aggregates through this registry and never
 * queries another domain's tables directly (ADR 0011 decision 5; B33).
 */
class ProjectAttentionRegistry {
  private readonly adapters: ProjectAttentionAdapter[] = [];

  // Deliberate replacement by areaKind: module init may re-run for each app
  // build, and tests may install a purpose-specific adapter for the same area.
  replace(adapter: ProjectAttentionAdapter): void {
    const index = this.adapters.findIndex((existing) => existing.areaKind === adapter.areaKind);
    if (index >= 0) {
      this.adapters[index] = adapter;
    } else {
      this.adapters.push(adapter);
    }
  }

  list(): ProjectAttentionAdapter[] {
    return [...this.adapters];
  }

  /** Test-only: reset registrations between test files. */
  __resetForTests(): void {
    this.adapters.length = 0;
  }
}

export const projectAttentionRegistry = new ProjectAttentionRegistry();

const SEVERITY_RANK: Record<ProjectAttentionSeverity, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
};

export function sortAttentionItems(items: ProjectAttentionItem[]): ProjectAttentionItem[] {
  return [...items].sort((a, b) => {
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (bySeverity !== 0) return bySeverity;
    const aDue = a.due_at ? Date.parse(a.due_at) : Number.POSITIVE_INFINITY;
    const bDue = b.due_at ? Date.parse(b.due_at) : Number.POSITIVE_INFINITY;
    if (aDue !== bDue) return aDue - bDue;
    return a.id.localeCompare(b.id);
  });
}
