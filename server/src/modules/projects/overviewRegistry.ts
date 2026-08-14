import type { Queryable, SpaceUserIdentity } from "../routeUtils/common";
import type { ProjectPrimaryMode } from "./primaryMode";

export interface ModeOverviewProjection {
  mode: ProjectPrimaryMode;
  current_state_summary: string;
  progress_indicators: Array<{ metric: string; value: number; trend?: "up" | "down" | "flat" }>;
  focus_set: Array<{ id: string; label: string; href: string }>;
  next_actions: Array<{ id: string; label: string; href: string; kind: string }>;
}

/**
 * One Primary Mode's Overview projection: what a Project advancing this way
 * should do next.
 *
 * A Mode is a way of advancing work, not a place — the navigation Areas are
 * the same for every Project. The Project module aggregates through this
 * contract and never queries Inquiry/Decision/Experiment/etc. tables directly
 * (ADR 0011 decision 5).
 */
export interface ProjectModeProjectionAdapter {
  mode: ProjectPrimaryMode;
  getOverviewProjection(
    db: Queryable,
    identity: SpaceUserIdentity,
    projectId: string,
  ): Promise<ModeOverviewProjection>;
}

export interface ProjectEntitySummary {
  count: number;
  status: "ok" | "attention" | "blocked";
}

/**
 * One entity's Project summary row: how much of this kind of thing the
 * Project holds, and the way into the Area that owns it.
 *
 * This is deliberately not the Mode contract. `inquiry_thread` and
 * `decision_case` are entities a Project of any Mode can hold — asking is how
 * research starts and deciding is where it ends, and a delivery Project makes
 * decisions too — so they report a summary without claiming to be a way of
 * advancing work. Entities the Project module already owns counts for — its
 * Artifacts, Proposals, Runs, Folders, Memory, and its Corpus — are summarized
 * directly by `overviewService` and are not registered here.
 */
export interface ProjectEntitySummaryAdapter {
  /** Matches the ontology entity registry's `entityType`. */
  entityType: string;
  label: string;
  /** Where the row leads: the Area that owns this entity, or a Space-wide
   *  list already filtered to this Project. */
  href: (projectId: string) => string;
  /** One short line under the label. Static: it describes the kind, not the data. */
  detail: string;
  getSummary(
    db: Queryable,
    identity: SpaceUserIdentity,
    projectId: string,
  ): Promise<ProjectEntitySummary>;
}

class ProjectModeProjectionRegistry {
  private readonly adapters = new Map<ProjectPrimaryMode, { adapter: ProjectModeProjectionAdapter; owner: string }>();

  register(adapter: ProjectModeProjectionAdapter, owner: string): void {
    if (!owner.trim()) throw new Error("owner must be non-empty");
    const existing = this.adapters.get(adapter.mode);
    if (existing && existing.owner !== owner) {
      throw new Error(`${adapter.mode} is already registered by ${existing.owner}`);
    }
    this.adapters.set(adapter.mode, { adapter, owner });
  }

  get(mode: ProjectPrimaryMode): ProjectModeProjectionAdapter | null {
    return this.adapters.get(mode)?.adapter ?? null;
  }

  list(): ProjectModeProjectionAdapter[] {
    return [...this.adapters.values()].map(({ adapter }) => adapter);
  }

  /** Test-only: reset registrations between test files. */
  __resetForTests(): void {
    this.adapters.clear();
  }
}

class ProjectEntitySummaryRegistry {
  private readonly adapters = new Map<string, { adapter: ProjectEntitySummaryAdapter; owner: string }>();

  register(adapter: ProjectEntitySummaryAdapter, owner: string): void {
    if (!owner.trim()) throw new Error("owner must be non-empty");
    const existing = this.adapters.get(adapter.entityType);
    if (existing && existing.owner !== owner) {
      throw new Error(`${adapter.entityType} is already registered by ${existing.owner}`);
    }
    this.adapters.set(adapter.entityType, { adapter, owner });
  }

  get(entityType: string): ProjectEntitySummaryAdapter | null {
    return this.adapters.get(entityType)?.adapter ?? null;
  }

  list(): ProjectEntitySummaryAdapter[] {
    return [...this.adapters.values()].map(({ adapter }) => adapter);
  }

  /** Test-only: reset registrations between test files. */
  __resetForTests(): void {
    this.adapters.clear();
  }
}

export const projectModeProjectionRegistry = new ProjectModeProjectionRegistry();
export const projectEntitySummaryRegistry = new ProjectEntitySummaryRegistry();

/**
 * Which entities hold a row even at zero, per Mode.
 *
 * A Project that advances by research should see where its evidence work
 * would go before any of it exists; one that advances by delivery should not
 * have that row until there is something in it. Everything not listed here
 * appears once the Project has data of that kind. This is a static
 * declaration, not per-Project state: switching Mode changes the placeholders
 * immediately and there is nothing to migrate.
 */
export const MODE_PLACEHOLDER_ENTITIES: Record<ProjectPrimaryMode, readonly string[]> = {
  research: ["inquiry_thread", "research_workflow", "source_item", "extracted_evidence"],
  delivery: ["task", "artifact", "project_folder"],
  operations: ["automation", "run"],
  // Knowledge is Space-scoped — `knowledge_items` has no `project_id` — so a
  // knowledge placeholder here would name a row nothing can ever provide.
  learning: ["learning_item"],
};

/**
 * A placeholder naming an entity nothing provides is a row that silently never
 * appears, which is exactly the failure the entity registry exists to prevent.
 * Checked at startup, once every module has registered, rather than trusted.
 *
 * `projectOwnedEntityTypes` are the generic records the Project module counts
 * directly (see `overviewService`); the rest must come from a registered
 * adapter.
 */
export function assertPlaceholderEntitiesProvided(projectOwnedEntityTypes: readonly string[]): void {
  const provided = new Set([
    ...projectEntitySummaryRegistry.list().map((adapter) => adapter.entityType),
    ...projectOwnedEntityTypes,
  ]);
  for (const [mode, entityTypes] of Object.entries(MODE_PLACEHOLDER_ENTITIES)) {
    for (const entityType of entityTypes) {
      if (!provided.has(entityType)) {
        throw new Error(
          `Primary Mode ${mode} declares a placeholder for ${entityType}, which no entity summary provides`,
        );
      }
    }
  }
}

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
