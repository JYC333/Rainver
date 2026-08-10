import { randomUUID } from "node:crypto";
import type { Queryable } from "../routeUtils/common";
import type { SpaceUserIdentity } from "../routeUtils/common";
import { TRUST_BY_SOURCE_TYPE } from "./repository";
import { assessActivityMemoryDuplicate } from "./memoryDedup";
import { insertProposalRow } from "../proposals/reviewPackets";
import { contentOwnerFilterSql, contentReadSql } from "../access/contentAccessSql";

interface ActivityRow {
  id: string;
  space_id: string;
  user_id: string | null;
  owner_user_id: string | null;
  subject_user_id: string | null;
  project_folder_id: string | null;
  project_id: string | null;
  activity_type: string;
  title: string | null;
  content: string | null;
  source_trust: string | null;
  source_url: string | null;
  status: string;
  aggregate_key: string | null;
  visibility: string;
}

const ACTIVITY_COLUMNS = `
  id, space_id, user_id, owner_user_id, subject_user_id, project_folder_id, project_id,
  activity_type, title, content, source_trust, source_url, status, aggregate_key, visibility
`;

interface DedupedActivity {
  activity_id: string;
  create_safety: string;
  match_ids: string[];
}

export class PgActivityConsolidationRepository {
  constructor(private readonly db: Queryable) {}

  async runPending(input: {
    spaceId: string;
    actingUserId: string;
    batchLimit: number;
    activityIds: string[] | null;
  }): Promise<Record<string, unknown>> {
    const runId = randomUUID();
    const proposalsCreated: string[] = [];
    const activitiesProcessed: string[] = [];
    const activitiesSkipped: string[] = [];
    const activitiesDeduped: DedupedActivity[] = [];
    const activitiesFailed: string[] = [];

    const params: unknown[] = [input.spaceId];
    let idFilter = "";
    if (input.activityIds?.length) {
      params.push(input.activityIds);
      idFilter = `AND ar.id::text = ANY($${params.length}::text[])`;
    }
    params.push(input.actingUserId);
    const userExpr = `$${params.length}`;
    params.push(input.batchLimit);
    const result = await this.db.query<ActivityRow>(
      `SELECT ${ACTIVITY_COLUMNS}
         FROM activity_records ar
        WHERE ar.space_id = $1
          AND ar.status = 'raw'
          AND ar.aggregate_key IS NULL
          AND ${contentReadSql("activity", "ar", userExpr)}
          AND ${contentOwnerFilterSql("activity", "ar", userExpr)}
          ${idFilter}
        ORDER BY ar.created_at ASC
        LIMIT $${params.length}`,
      params,
    );

    const identity: SpaceUserIdentity = {
      spaceId: input.spaceId,
      userId: input.actingUserId,
    };

    for (const activity of result.rows) {
      try {
        const content = (activity.content ?? "").trim();
        if (!content) {
          await this.markActivityStatus(activity.id, input.spaceId, "processed");
          activitiesSkipped.push(activity.id);
          continue;
        }
        const duplicate = await assessActivityMemoryDuplicate(this.db, {
          spaceId: input.spaceId,
          viewerUserId: input.actingUserId,
          title: activity.title,
          content: activity.content,
        });
        if (duplicate.duplicate) {
          await this.markActivityStatus(activity.id, input.spaceId, "processed");
          activitiesDeduped.push({
            activity_id: activity.id,
            create_safety: duplicate.createSafety,
            match_ids: duplicate.matchIds,
          });
          continue;
        }
        const proposalId = await this.insertMemoryProposal(identity, activity);
        await this.markActivityStatus(activity.id, input.spaceId, "proposals_generated");
        proposalsCreated.push(proposalId);
        activitiesProcessed.push(activity.id);
      } catch {
        activitiesFailed.push(activity.id);
        await this.markActivityStatus(activity.id, input.spaceId, "failed");
      }
    }

    return {
      consolidation_run_id: runId,
      proposals_created: proposalsCreated,
      activities_processed: activitiesProcessed,
      activities_skipped: activitiesSkipped,
      activities_deduped: activitiesDeduped,
      activities_failed: activitiesFailed,
    };
  }

  private async markActivityStatus(
    activityId: string,
    spaceId: string,
    status: "processed" | "proposals_generated" | "failed",
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.db.query(
      `UPDATE activity_records
          SET status = $3::varchar,
              processed_at = CASE WHEN $3::varchar IN ('processed', 'proposals_generated') THEN $4::timestamptz ELSE processed_at END,
              updated_at = $4
        WHERE id = $1 AND space_id = $2`,
      [activityId, spaceId, status, now],
    );
  }

  private async insertMemoryProposal(
    identity: SpaceUserIdentity,
    activity: ActivityRow,
  ): Promise<string> {
    const row = await insertProposalRow(this.db, {
      spaceId: identity.spaceId,
      proposalType: "memory_create",
      title: activity.title || `Activity: ${(activity.content ?? "").slice(0, 80)}`,
      rationale: "Activity consolidation generated a memory proposal.",
      payload: {
        operation: "create",
        proposed_content: activity.content ?? "",
        memory_type: "experience",
        target_scope: "user",
        target_namespace: "activity.consolidation",
        owner_user_id: activity.owner_user_id ?? activity.user_id ?? identity.userId,
        subject_user_id: activity.subject_user_id ?? activity.user_id ?? identity.userId,
        source_activity_id: activity.id,
        activity_source_trust:
          activity.source_trust ?? TRUST_BY_SOURCE_TYPE[activity.activity_type] ?? "untrusted_external",
        provenance_entries: [
          {
            source_type: "activity",
            source_id: activity.id,
            source_trust:
              activity.source_trust ?? TRUST_BY_SOURCE_TYPE[activity.activity_type] ?? "untrusted_external",
            evidence_json: {
              activity_type: activity.activity_type,
              source_url: activity.source_url,
            },
          },
        ],
      },
      createdByUserId: identity.userId,
      projectFolderId: activity.project_folder_id,
      projectId: activity.project_id,
      visibility: activity.visibility,
      riskLevel: "low",
    });
    return row.id;
  }
}
