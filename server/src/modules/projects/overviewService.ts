import type { ServerConfig } from "../../config";
import { HttpError, type Queryable, type SpaceUserIdentity } from "../routeUtils/common";
import { getDbPool } from "../../db/pool";
import { assertProjectReadable } from "./access";
import { PgProjectRepository } from "./repository";
import { ProjectCorpusRepository } from "./corpusRepository";
import {
  MODE_PLACEHOLDER_ENTITIES,
  fallbackModeProjection,
  projectEntitySummaryRegistry,
  projectModeProjectionRegistry,
} from "./overviewRegistry";
import { ProjectAttentionService } from "./attentionService";
import { ProjectKernelService } from "./kernelService";
import type { ProjectPrimaryMode } from "./primaryMode";

interface ProjectSummaryRow {
  id: string;
  name: string;
  primary_mode: string;
  status: string;
}

/**
 * The generic records a Project owns counts for directly. They are not
 * registered adapters: the entity registry exists so the Project module never
 * queries *another domain's* tables, and these are its own aggregate, already
 * computed with the same content-access predicates by `PgProjectRepository`
 * and `ProjectCorpusRepository`.
 */
export const PROJECT_OWNED_ENTITY_ROWS: ReadonlyArray<{
  entityType: string;
  label: string;
  detail: string;
  countKey: string;
  href: (projectId: string) => string;
}> = [
  { entityType: "source_item", label: "Collected material", detail: "Items gathered for screening", countKey: "source_item_count", href: (id) => `/projects/${id}/sources` },
  { entityType: "extracted_evidence", label: "Evidence", detail: "Extracted from screened material", countKey: "extracted_evidence_count", href: (id) => `/projects/${id}/research` },
  { entityType: "project_folder", label: "Project Folders", detail: "Files & Code", countKey: "project_folder_count", href: (id) => `/projects/${id}/files` },
  // These four open a Space-wide list, so the row must carry the Project
  // filter — without it the count and the page it opens disagree.
  { entityType: "run", label: "Active runs", detail: "Runs still executing", countKey: "active_run_count", href: (id) => `/runs?project_id=${id}` },
  { entityType: "proposal", label: "Pending proposals", detail: "Awaiting your approval", countKey: "pending_proposal_count", href: (id) => `/proposals?project_id=${id}` },
  { entityType: "artifact", label: "Artifacts", detail: "Produced by this project", countKey: "artifact_count", href: (id) => `/artifacts?project_id=${id}` },
  { entityType: "memory_entry", label: "Memory", detail: "Project-scoped entries", countKey: "memory_entry_count", href: (id) => `/memory?project_id=${id}` },
];

export const PROJECT_OWNED_ENTITY_TYPES: readonly string[] =
  PROJECT_OWNED_ENTITY_ROWS.map((row) => row.entityType);

export class ProjectOverviewService {
  private readonly attention: ProjectAttentionService;
  private readonly kernel: ProjectKernelService;
  private readonly projects: PgProjectRepository;
  private readonly corpus: ProjectCorpusRepository;

  constructor(private readonly db: Queryable) {
    this.attention = new ProjectAttentionService(db);
    this.kernel = new ProjectKernelService(db);
    this.projects = new PgProjectRepository(db);
    this.corpus = new ProjectCorpusRepository(db);
  }

  static fromConfig(config: ServerConfig): ProjectOverviewService {
    if (!config.databaseUrl) throw new HttpError(502, "SERVER_DATABASE_URL is required");
    return new ProjectOverviewService(getDbPool(config.databaseUrl));
  }

  async getOverview(identity: SpaceUserIdentity, projectId: string): Promise<Record<string, unknown>> {
    await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    const projectRow = await this.db.query<ProjectSummaryRow>(
      `SELECT id, name, primary_mode, status
         FROM projects
        WHERE id = $1 AND space_id = $2 AND deleted_at IS NULL`,
      [projectId, identity.spaceId],
    );
    const project = projectRow.rows[0];
    if (!project) throw new HttpError(404, "Project not found");

    const mode = project.primary_mode as ProjectPrimaryMode;
    const adapter = projectModeProjectionRegistry.get(mode);
    const availableModes = projectModeProjectionRegistry.list().map((item) => item.mode);
    const placeholderOrder = MODE_PLACEHOLDER_ENTITIES[mode] ?? [];
    const placeholders = new Set(placeholderOrder);
    const [modeProjection, brief, attention, registeredSummaries, projectCounts, corpusCounts, readiness] = await Promise.all([
      adapter ? adapter.getOverviewProjection(this.db, identity, projectId) : Promise.resolve(fallbackModeProjection(mode)),
      this.kernel.getActiveBriefVersion(identity, projectId),
      this.attention.listAttentionItems(identity, projectId),
      Promise.all(
        projectEntitySummaryRegistry.list().map(async (a) => {
          const summary = await a.getSummary(this.db, identity, projectId);
          return {
            entity_type: a.entityType,
            label: a.label,
            detail: a.detail,
            href: a.href(projectId),
            count: summary.count,
            status: summary.status,
          };
        }),
      ),
      this.projects.summary(identity, projectId),
      this.corpus.entityCounts(identity, projectId),
      this.db.query<{
        provider_count: number;
        agent_count: number;
        source_count: number;
        folder_count: number;
      }>(
        `SELECT
           (SELECT count(*)::int FROM model_providers WHERE space_id = $1 AND enabled = true) AS provider_count,
           (SELECT count(*)::int
              FROM agents
             WHERE space_id = $1
               AND status = 'active'
               AND agent_kind <> 'system_assistant'
               AND current_version_id IS NOT NULL) AS agent_count,
           (SELECT count(*)::int FROM project_source_bindings WHERE space_id = $1 AND project_id = $2 AND status = 'active') AS source_count,
           (SELECT count(*)::int FROM project_folders WHERE space_id = $1 AND project_id = $2 AND status = 'active' AND execution_enabled = true) AS folder_count`,
        [identity.spaceId, projectId],
      ).then((result) => result.rows[0] ?? {
        provider_count: 0,
        agent_count: 0,
        source_count: 0,
        folder_count: 0,
      }),
    ]);
    // Whether this Project needs a Provider, an Agent and a Source before it
    // can do anything, which is a question about how it advances. This used to
    // ask the creation-time Project Template instead — first through
    // `starter_workflow_template_keys`, whose members R1 deleted, then through
    // its recommended sources — and both readings put the question to a
    // provenance record that could not answer it.
    const workflowSetupRequired = mode === "research";
    // User-facing initialization means the Project has a formally published
    // goal/problem definition. Audit metadata and downstream work are separate.
    const goalOrProblem = typeof brief?.goal === "string" ? brief.goal.trim() : "";
    const projectDefinition = goalOrProblem
      ? {
          status: "initialized" as const,
          basis: "published_brief_goal" as const,
          goal_or_problem: goalOrProblem,
        }
      : {
          status: "needs_definition" as const,
          basis: "missing_published_brief_goal" as const,
          goal_or_problem: null,
        };
    const setupChecklist = [
      {
        id: "brief",
        label: "Project goal or problem",
        status: brief?.goal ? "ready" : "missing",
        required: true,
        href: `/projects/${projectId}/inquiry?setup=goal`,
        detail: brief?.goal ? "Project initialized" : "Define the Project's goal or core problem",
      },
      {
        id: "provider",
        label: "Model Provider",
        status: readiness.provider_count > 0 ? "ready" : "missing",
        required: workflowSetupRequired,
        href: "/providers",
        detail: readiness.provider_count > 0 ? `${readiness.provider_count} active` : "No active Provider",
      },
      {
        id: "agent",
        label: "Execution Agent",
        status: readiness.agent_count > 0 ? "ready" : "missing",
        required: workflowSetupRequired,
        href: "/agents",
        detail: readiness.agent_count > 0 ? `${readiness.agent_count} active` : "No configured Agent",
      },
      {
        id: "source",
        label: "Project Source",
        status: readiness.source_count > 0 ? "ready" : "missing",
        required: workflowSetupRequired,
        href: `/projects/${projectId}/sources`,
        detail: readiness.source_count > 0 ? `${readiness.source_count} linked` : "No Source linked",
      },
      {
        id: "folder",
        label: "Execution-enabled Folder",
        status: readiness.folder_count > 0 ? "ready" : "missing",
        required: false,
        href: `/projects/${projectId}/files`,
        detail: readiness.folder_count > 0 ? `${readiness.folder_count} available` : "Optional for file/code work",
      },
    ];

    const ownedCounts: Record<string, unknown> = { ...projectCounts, ...corpusCounts };
    const entitySummaries = [
      ...registeredSummaries,
      ...PROJECT_OWNED_ENTITY_ROWS.map((row) => ({
        entity_type: row.entityType,
        label: row.label,
        detail: row.detail,
        href: row.href(projectId),
        count: Number(ownedCounts[row.countKey] ?? 0),
        status: "ok" as const,
      })),
    ]
      .filter((row) => row.count > 0 || placeholders.has(row.entity_type))
      .sort((left, right) => {
        // The Mode's own shape leads, in its declared order — a placeholder
        // must not move as data arrives, or the Overview reorders itself
        // under the user. Everything else follows by weight.
        const leftRank = placeholderOrder.indexOf(left.entity_type);
        const rightRank = placeholderOrder.indexOf(right.entity_type);
        if (leftRank !== rightRank) {
          if (leftRank === -1) return 1;
          if (rightRank === -1) return -1;
          return leftRank - rightRank;
        }
        return right.count - left.count;
      });

    return {
      project: {
        id: project.id,
        name: project.name,
        primary_mode: project.primary_mode,
        status: project.status,
      },
      brief,
      definition_status: projectDefinition,
      mode_projection: modeProjection,
      available_modes: availableModes,
      attention: attention.slice(0, 20),
      setup_checklist: setupChecklist,
      // One row per kind of thing the Project holds. A row appears when the
      // Project has data of that kind, or when the current Mode declares it a
      // placeholder — a Project advancing by research should see where its
      // evidence work goes before any of it exists. Rows are never a Mode
      // list: every navigation Area stays reachable whatever is returned here.
      entity_summaries: entitySummaries,
    };
  }
}
