import type { ServerConfig } from "../../config";
import { HttpError, type Queryable, type SpaceUserIdentity } from "../routeUtils/common";
import { getDbPool } from "../../db/pool";
import { assertProjectReadable } from "./access";
import { projectModeProjectionRegistry, fallbackModeProjection } from "./overviewRegistry";
import { ProjectAttentionService } from "./attentionService";
import { ProjectKernelService } from "./kernelService";
import type { ProjectPrimaryMode } from "../projectTemplates/types";
import { getBuiltInProjectTemplate } from "../projectTemplates/registry";

interface ProjectSummaryRow {
  id: string;
  name: string;
  primary_mode: string;
  template_key: string;
  status: string;
}

export class ProjectOverviewService {
  private readonly attention: ProjectAttentionService;
  private readonly kernel: ProjectKernelService;

  constructor(private readonly db: Queryable) {
    this.attention = new ProjectAttentionService(db);
    this.kernel = new ProjectKernelService(db);
  }

  static fromConfig(config: ServerConfig): ProjectOverviewService {
    if (!config.databaseUrl) throw new HttpError(502, "SERVER_DATABASE_URL is required");
    return new ProjectOverviewService(getDbPool(config.databaseUrl));
  }

  async getOverview(identity: SpaceUserIdentity, projectId: string): Promise<Record<string, unknown>> {
    await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    const projectRow = await this.db.query<ProjectSummaryRow>(
      `SELECT id, name, primary_mode, template_key, status
         FROM projects
        WHERE id = $1 AND space_id = $2 AND deleted_at IS NULL`,
      [projectId, identity.spaceId],
    );
    const project = projectRow.rows[0];
    if (!project) throw new HttpError(404, "Project not found");

    const mode = project.primary_mode as ProjectPrimaryMode;
    const adapter = projectModeProjectionRegistry.get(mode);
    const availableModes = projectModeProjectionRegistry.list().map((item) => item.mode);
    const [modeProjection, brief, attention, areaSummaries, readiness] = await Promise.all([
      adapter ? adapter.getOverviewProjection(this.db, identity, projectId) : Promise.resolve(fallbackModeProjection(mode)),
      this.kernel.getActiveBriefVersion(identity, projectId),
      this.attention.listAttentionItems(identity, projectId),
      Promise.all(
        projectModeProjectionRegistry.list().map(async (a) => {
          const summary = await a.getAreaSummary(this.db, identity, projectId);
          return { mode: a.mode, summary };
        }),
      ),
      this.db.query<{
        provider_count: number;
        agent_count: number;
        source_count: number;
        folder_count: number;
      }>(
        `SELECT
           (SELECT count(*)::int FROM model_providers WHERE space_id = $1 AND enabled = true) AS provider_count,
           (SELECT count(*)::int FROM agents WHERE space_id = $1 AND status = 'active' AND current_version_id IS NOT NULL) AS agent_count,
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
    const template = getBuiltInProjectTemplate(project.template_key);
    const workflowSetupRequired = (template?.starter_workflow_template_keys.length ?? 0) > 0;
    const setupChecklist = [
      {
        id: "brief",
        label: "Project Brief goal",
        status: brief?.goal ? "ready" : "missing",
        required: true,
        href: `/projects/${projectId}/inquiry?setup=goal`,
        detail: brief?.goal ? "Goal recorded" : "Add the intended outcome from the Inquiry Area",
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
        required: template?.key === "academic_research",
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

    return {
      project: {
        id: project.id,
        name: project.name,
        primary_mode: project.primary_mode,
        template_key: project.template_key,
        status: project.status,
      },
      brief,
      mode_projection: modeProjection,
      available_modes: availableModes,
      attention: attention.slice(0, 20),
      template: template ? {
        key: template.key,
        name: template.name,
        description: template.description,
        starter_workflow_template_keys: template.starter_workflow_template_keys,
      } : null,
      setup_checklist: setupChecklist,
      // All installed Project Areas are always reachable, independent of
      // primary_mode or Template origin — every registered Area's summary is
      // returned, including empty ones (they show a setup/empty state).
      area_summaries: areaSummaries,
    };
  }
}
