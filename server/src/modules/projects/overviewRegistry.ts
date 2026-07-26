import type { Queryable, SpaceUserIdentity } from "../routeUtils/common";
import type { ProjectPrimaryMode } from "../projectTemplates/types";

export interface ModeOverviewProjection {
  mode: ProjectPrimaryMode;
  current_state_summary: string;
  progress_indicators: Array<{ metric: string; value: number; trend?: "up" | "down" | "flat" }>;
  focus_set: Array<{ id: string; label: string; href: string }>;
  next_actions: Array<{ id: string; label: string; href: string; kind: string }>;
}

export interface ProjectAreaSummary {
  count: number;
  status: "ok" | "attention" | "blocked";
}

/**
 * One Mode's Overview adapter. Registered by the owning Mode module; the
 * Project module aggregates through this contract and never queries
 * Inquiry/Decision/Experiment/etc. tables directly (ADR 0011 decision 5).
 */
export interface ProjectModeAreaAdapter {
  mode: ProjectPrimaryMode;
  getOverviewProjection(
    db: Queryable,
    identity: SpaceUserIdentity,
    projectId: string,
  ): Promise<ModeOverviewProjection>;
  getAreaSummary(
    db: Queryable,
    identity: SpaceUserIdentity,
    projectId: string,
  ): Promise<ProjectAreaSummary>;
}

class ProjectModeProjectionRegistry {
  private readonly adapters = new Map<ProjectPrimaryMode, ProjectModeAreaAdapter>();

  register(adapter: ProjectModeAreaAdapter): void {
    this.adapters.set(adapter.mode, adapter);
  }

  get(mode: ProjectPrimaryMode): ProjectModeAreaAdapter | null {
    return this.adapters.get(mode) ?? null;
  }

  list(): ProjectModeAreaAdapter[] {
    return [...this.adapters.values()];
  }

  /** Test-only: reset registrations between test files. */
  __resetForTests(): void {
    this.adapters.clear();
  }
}

export const projectModeProjectionRegistry = new ProjectModeProjectionRegistry();

// Used only for a Primary Mode that has no registered adapter. It is
// explicitly a placeholder, not a real progress model.
export function fallbackModeProjection(mode: ProjectPrimaryMode): ModeOverviewProjection {
  return {
    mode,
    current_state_summary: `${mode} Mode has no Overview adapter yet.`,
    progress_indicators: [],
    focus_set: [],
    next_actions: [],
  };
}
