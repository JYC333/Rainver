import type { Queryable } from "../routeUtils/common.js";

export class ProjectResearchReportStatusService {
  constructor(private readonly db: Queryable) {}
  async transitionForOperation(spaceId: string, operationId: string, status: "complete" | "rejected"): Promise<void> {
    await this.db.query(
      `UPDATE project_research_reports SET status=$3, updated_at=now()
        WHERE space_id=$1 AND operation_id=$2 AND status='awaiting_review'`,
      [spaceId, operationId, status],
    );
  }
}
