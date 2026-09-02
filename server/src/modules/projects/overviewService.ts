import type { ServerConfig } from "../../config.js";
import { HttpError, type Queryable, type SpaceUserIdentity } from "../routeUtils/common.js";
import { getDbPool } from "../../db/pool.js";
import { assertProjectReadable } from "./access.js";
import { ProjectAttentionService } from "./attentionService.js";
import { ProjectKernelService } from "./kernelService.js";
import { listRunningProjectOperations } from "./runningOperations.js";

interface ProjectSummaryRow {
  id: string;
  name: string;
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
      `SELECT id, name, status
         FROM projects
        WHERE id = $1 AND space_id = $2 AND deleted_at IS NULL`,
      [projectId, identity.spaceId],
    );
    const project = projectRow.rows[0];
    if (!project) throw new HttpError(404, "Project not found");

    // What the front page, the shell and the Assistant all read: the goal,
    // whether there is one, and what needs attention. There used to be a
    // per-Mode "projection" (a state summary and next-action links that all
    // pointed at Areas the sidebar lists) and a per-entity summary row set
    // (the Areas list again, with counts). Nothing consumed either once the
    // front page stopped duplicating the sidebar, so they are gone.
    const [brief, attention, inProgress, folders] = await Promise.all([
      this.kernel.getActiveBriefVersion(identity, projectId),
      this.attention.listAttentionItems(identity, projectId),
      listRunningProjectOperations(this.db, identity.spaceId, projectId),
      this.db.query(
        `SELECT 1 FROM project_folders WHERE space_id = $1 AND project_id = $2 AND status = 'active' LIMIT 1`,
        [identity.spaceId, projectId],
      ),
    ]);
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
    // No readiness checklist. It listed a Space-level Provider, "an Agent"
    // (which every Project now has by itself), a Source only research work
    // wants, and a Folder it called optional — configuration state dressed as
    // a to-do, shown from every Area. The one Project-level fact it carried,
    // whether a goal is defined, is `definition_status`, and Pulse says so.

    return {
      project: {
        id: project.id,
        name: project.name,
        status: project.status,
      },
      brief,
      definition_status: projectDefinition,
      has_project_folder: (folders.rowCount ?? 0) > 0,
      attention: attention.slice(0, 20),
      // Attention answers "what needs me". This answers "what is happening",
      // which the front page could not answer at all.
      in_progress: inProgress,
    };
  }
}
