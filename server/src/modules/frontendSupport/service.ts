import type { ServerConfig } from "../../config";
import { dbPool, type Queryable, type SpaceUserIdentity } from "../routeUtils/common";
import {
  ACTIVE_RUN_STATUSES,
  DONE_TASK_STATUSES,
  REVIEW_TASK_STATUSES,
  artifactReadSql,
  boundedQueryInt,
  iso,
  isoOrNull,
  numeric,
  proposalVisibleSelect,
  proposalReadSql,
  runReadSql,
  suggestedActions,
  taskReadSql,
} from "./frontendSupportReadModel";
import type {
  HomeActiveTaskItem,
  HomeArtifactSummaryItem,
  HomeRunSummaryItem,
  HomeSummaryOut,
  MePendingProposalItem,
  MeRecentParticipationItem,
  MeRecentRunItem,
  MeSpaceRollup,
  MeSummaryOut,
  MeTimelineEntry,
  QueryParams,
} from "./frontendSupportTypes";
export type {
  HomeSummaryOut,
  MePendingProposalItem,
  MeSummaryOut,
  MeTimelineEntry,
} from "./frontendSupportTypes";

export class PgFrontendSupportService {
  constructor(private readonly db: Queryable) {}

  static fromConfig(config: ServerConfig): PgFrontendSupportService {
    return new PgFrontendSupportService(dbPool(config));
  }

  async homeSummary(
    identity: SpaceUserIdentity,
    query: QueryParams,
  ): Promise<HomeSummaryOut> {
    const recentRunsLimit = boundedQueryInt(query.recent_runs_limit, 10, 1, 50);
    const activeTasksLimit = boundedQueryInt(query.active_tasks_limit, 10, 1, 50);
    const pendingPreviewLimit = boundedQueryInt(query.pending_preview_limit, 5, 0, 50);

    const [
      recentRuns,
      activeRuns,
      pending,
      artifacts,
      taskSummary,
      activeTasks,
      activity,
      runStats,
      jobStatus,
      runtimeStatus,
      modelProviderStatus,
      sourceSummary,
      operationsInProgress,
    ] = await Promise.all([
      this.listHomeRuns(identity, recentRunsLimit, false),
      this.listHomeRuns(identity, 10, true),
      this.pendingProposals(identity, pendingPreviewLimit),
      this.recentArtifacts(identity, 10),
      this.taskSummary(identity),
      this.activeTasks(identity, activeTasksLimit),
      this.activitySummary(identity.spaceId),
      this.runStatsToday(identity.spaceId),
      this.jobQueueStatus(identity.spaceId),
      this.runtimeStatus(identity.spaceId),
      this.modelProviderStatus(identity.spaceId),
      this.sourceSummary(identity.spaceId),
      this.operationsInProgress(identity),
    ]);

    return {
      recent_runs: recentRuns,
      active_runs: activeRuns,
      pending_proposals: pending,
      recent_artifacts: artifacts,
      task_summary: taskSummary,
      active_tasks: activeTasks,
      activity_summary: activity,
      run_stats_today: runStats,
      job_queue_status: jobStatus,
      runtime_status: runtimeStatus,
      model_provider_status: modelProviderStatus,
      suggested_actions: suggestedActions({
        pendingCount: pending.count,
        retryableJobs: jobStatus.retryable,
        missingModelProvider: modelProviderStatus.missing_model_provider_config,
      }),
      source_summary: sourceSummary,
      operations_in_progress:operationsInProgress,
    };
  }

  private async operationsInProgress(identity:SpaceUserIdentity){const result=await this.db.query<any>(`SELECT po.id,po.project_id,p.name AS project_name,po.kind,po.title,po.status,po.progress_json,po.updated_at FROM project_operations po JOIN projects p ON p.id=po.project_id AND p.space_id=po.space_id AND p.deleted_at IS NULL WHERE po.space_id=$1 AND po.status IN ('draft','active','waiting_review') AND (p.owner_user_id=$2 OR EXISTS(SELECT 1 FROM spaces s WHERE s.id=$1 AND s.type='personal') OR EXISTS(SELECT 1 FROM project_members pm WHERE pm.space_id=$1 AND pm.project_id=p.id AND pm.user_id=$2 AND pm.status='active')) ORDER BY po.updated_at DESC LIMIT 10`,[identity.spaceId,identity.userId]);return result.rows.map(row=>({...row,progress_json:row.progress_json&&typeof row.progress_json==='object'?row.progress_json:{},updated_at:iso(row.updated_at)}));}

  async meSummary(userId: string, query: QueryParams): Promise<MeSummaryOut> {
    const recentRunsLimit = boundedQueryInt(query.recent_runs_limit, 10, 1, 50);
    const recentParticipationLimit = boundedQueryInt(
      query.recent_participation_limit,
      10,
      0,
      50,
    );
    const [spaces, counts, recentRuns, participation] = await Promise.all([
      this.meSpaces(userId),
      this.meCounts(userId),
      this.meRecentRuns(userId, recentRunsLimit),
      this.meRecentParticipation(userId, recentParticipationLimit),
    ]);

    return {
      pending_proposals_count: counts.pending_proposals_count,
      assigned_tasks_count: counts.assigned_tasks_count,
      recent_runs: recentRuns,
      recent_participation: participation,
      accessible_spaces_count: spaces.length,
      spaces,
    };
  }

  async meTimeline(userId: string, query: QueryParams): Promise<MeTimelineEntry[]> {
    const limit = boundedQueryInt(query.limit, 50, 1, 200);
    const offset = boundedQueryInt(query.offset, 0, 0, 10_000);
    const result = await this.db.query<{
      id: string;
      source_space_id: string;
      source_object_type: string;
      source_object_id: string;
      role: string;
      occurred_at: unknown;
      created_at: unknown;
    }>(
      `SELECT pr.id,
              pr.source_space_id,
              pr.source_object_type,
              pr.source_object_id,
              pr.role,
              pr.occurred_at,
              pr.created_at
         FROM participation_records pr
         JOIN space_memberships sm
           ON sm.space_id = pr.source_space_id
          AND sm.user_id = pr.user_id
          AND sm.status = 'active'
        WHERE pr.user_id = $1
        ORDER BY pr.occurred_at DESC, pr.created_at DESC, pr.id DESC
        LIMIT $2 OFFSET $3`,
      [userId, limit, offset],
    );
    return result.rows.map((row) => ({
      id: row.id,
      entry_type: "participation",
      source_space_id: row.source_space_id,
      source_object_type: row.source_object_type,
      source_object_id: row.source_object_id,
      role: row.role,
      occurred_at: iso(row.occurred_at),
      created_at: iso(row.created_at),
    }));
  }

  async mePending(userId: string, query: QueryParams): Promise<MePendingProposalItem[]> {
    const limit = boundedQueryInt(query.limit, 50, 1, 200);
    const offset = boundedQueryInt(query.offset, 0, 0, 10_000);
    const result = await this.db.query<{
      id: string;
      space_id: string;
      proposal_type: string;
      status: string;
      urgency: string;
      title: string;
      visibility: string;
      created_by_user_id: string | null;
      created_at: unknown;
      updated_at: unknown;
    }>(
      `${proposalVisibleSelect()}
        WHERE sm.user_id = $1
          AND p.status = 'pending'
          AND ${proposalReadSql("$1")}
        ORDER BY CASE
             WHEN p.urgency = 'critical' THEN 4
             WHEN p.urgency = 'high' THEN 3
             WHEN p.urgency = 'normal' THEN 2
             WHEN p.urgency = 'low' THEN 1
             ELSE 0
           END DESC,
           p.review_deadline ASC NULLS LAST,
           p.expires_at ASC NULLS LAST,
           p.created_at DESC,
           p.id DESC
        LIMIT $2 OFFSET $3`,
      [userId, limit, offset],
    );
    return result.rows.map((row) => ({
      id: row.id,
      space_id: row.space_id,
      proposal_type: row.proposal_type,
      status: row.status,
      urgency: row.urgency,
      title: row.title,
      visibility: row.visibility,
      created_by_user_id: row.created_by_user_id,
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
    }));
  }

  private async listHomeRuns(
    identity: SpaceUserIdentity,
    limit: number,
    activeOnly: boolean,
  ): Promise<HomeRunSummaryItem[]> {
    const activeFilter = activeOnly ? "AND r.status = ANY($4::text[])" : "";
    const params: unknown[] = [identity.spaceId, identity.userId, limit];
    if (activeOnly) params.push(ACTIVE_RUN_STATUSES);
    const result = await this.db.query<{
      id: string;
      status: string;
      mode: string;
      run_type: string;
      agent_id: string;
      task_id: string | null;
      created_at: unknown;
      started_at: unknown;
      ended_at: unknown;
      error_message: string | null;
      visibility: string;
    }>(
      `SELECT r.id, r.status, r.mode, r.run_type, r.agent_id, tr.task_id,
              r.created_at, r.started_at, r.ended_at, r.error_message,
              r.visibility
         FROM runs r
         LEFT JOIN task_runs tr ON tr.run_id = r.id AND tr.space_id = r.space_id AND tr.role = 'primary'
        WHERE r.space_id = $1
          AND r.run_role = 'execution'
          AND ${runReadSql("$2")}
          ${activeFilter}
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT $3`,
      params,
    );
    return result.rows.map((row) => ({
      id: row.id,
      status: row.status,
      mode: row.mode,
      run_type: row.run_type,
      agent_id: row.agent_id,
      task_id: row.task_id,
      created_at: iso(row.created_at),
      started_at: isoOrNull(row.started_at),
      completed_at: isoOrNull(row.ended_at),
      error_text: row.error_message,
      visibility: row.visibility,
    }));
  }

  private async pendingProposals(
    identity: SpaceUserIdentity,
    limit: number,
  ): Promise<HomeSummaryOut["pending_proposals"]> {
    const params = [identity.spaceId, identity.userId];
    const total = await this.db.query<{ total: string | number }>(
      `SELECT count(p.id)::text AS total
         FROM proposals p
         LEFT JOIN runs run_for_instructed
           ON run_for_instructed.id = p.created_by_run_id
          AND run_for_instructed.space_id = p.space_id
        WHERE p.space_id = $1
          AND p.status = 'pending'
          AND ${proposalReadSql("$2")}`,
      params,
    );
    const rows = limit === 0
      ? { rows: [] as Array<{
          id: string;
          title: string;
          proposal_type: string;
          status: string;
          risk_level: string;
          urgency: string;
          review_deadline: unknown;
          expires_at: unknown;
          preview: boolean;
          created_by_run_id: string | null;
          visibility: string;
        }> }
      : await this.db.query<{
          id: string;
          title: string;
          proposal_type: string;
          status: string;
          risk_level: string;
          urgency: string;
          review_deadline: unknown;
          expires_at: unknown;
          preview: boolean;
          created_by_run_id: string | null;
          visibility: string;
        }>(
          `SELECT p.id, p.title, p.proposal_type, p.status, p.risk_level,
                  p.urgency, p.review_deadline, p.expires_at, p.preview,
                  p.created_by_run_id, p.visibility
             FROM proposals p
             LEFT JOIN runs run_for_instructed
               ON run_for_instructed.id = p.created_by_run_id
              AND run_for_instructed.space_id = p.space_id
            WHERE p.space_id = $1
              AND p.status = 'pending'
              AND ${proposalReadSql("$2")}
            ORDER BY p.created_at DESC, p.id DESC
            LIMIT $3`,
          [...params, limit],
        );
    const now = Date.now();
    return {
      count: numeric(total.rows[0]?.total),
      items: rows.rows.map((row) => {
        const expiresAt = isoOrNull(row.expires_at);
        return {
          id: row.id,
          title: row.title,
          proposal_type: row.proposal_type,
          status: row.status,
          risk_level: row.risk_level,
          urgency: row.urgency,
          review_deadline: isoOrNull(row.review_deadline),
          expires_at: expiresAt,
          expired: expiresAt !== null && Date.parse(expiresAt) < now,
          preview: Boolean(row.preview),
          created_by_run_id: row.created_by_run_id,
          visibility: row.visibility,
        };
      }),
    };
  }

  private async recentArtifacts(
    identity: SpaceUserIdentity,
    limit: number,
  ): Promise<HomeArtifactSummaryItem[]> {
    const result = await this.db.query<{
      id: string;
      title: string;
      artifact_type: string;
      preview: boolean;
      run_id: string | null;
      created_at: unknown;
      visibility: string;
    }>(
      `SELECT a.id, a.title, a.artifact_type, a.preview, a.run_id,
              a.created_at, a.visibility
         FROM artifacts a
        WHERE a.space_id = $1
          AND ${artifactReadSql("$2")}
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT $3`,
      [identity.spaceId, identity.userId, limit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      title: row.title,
      artifact_type: row.artifact_type,
      preview: Boolean(row.preview),
      run_id: row.run_id,
      created_at: iso(row.created_at),
      visibility: row.visibility,
    }));
  }

  private async taskSummary(identity: SpaceUserIdentity): Promise<HomeSummaryOut["task_summary"]> {
    const result = await this.db.query<{ status: string; total: string | number }>(
      `SELECT t.status, count(t.id)::text AS total
         FROM tasks t
        WHERE t.space_id = $1
          AND t.deleted_at IS NULL
          AND ${taskReadSql("$2")}
        GROUP BY t.status`,
      [identity.spaceId, identity.userId],
    );
    const byStatus: Record<string, number> = {};
    for (const row of result.rows) byStatus[row.status] = numeric(row.total);
    const totalOpen = Object.entries(byStatus)
      .filter(([status]) => !DONE_TASK_STATUSES.includes(status))
      .reduce((sum, [, count]) => sum + count, 0);
    return {
      by_status: byStatus,
      total_open: totalOpen,
      needs_review_count: REVIEW_TASK_STATUSES.reduce((sum, status) => sum + (byStatus[status] ?? 0), 0),
      blocked_count: byStatus.blocked ?? 0,
      done_count: DONE_TASK_STATUSES.reduce((sum, status) => sum + (byStatus[status] ?? 0), 0),
    };
  }

  private async activeTasks(
    identity: SpaceUserIdentity,
    limit: number,
  ): Promise<HomeActiveTaskItem[]> {
    const result = await this.db.query<{
      id: string;
      title: string;
      status: string;
      priority: string;
      risk_level: string;
      task_type: string;
      assigned_user_id: string | null;
      assigned_agent_id: string | null;
      due_at: unknown;
      updated_at: unknown;
      visibility: string;
    }>(
      `SELECT t.id, t.title, t.status, t.priority, t.risk_level, t.task_type,
              t.assigned_user_id, t.assigned_agent_id, t.due_at,
              t.updated_at, t.visibility
         FROM tasks t
        WHERE t.space_id = $1
          AND t.deleted_at IS NULL
          AND t.status <> ALL($3::text[])
          AND ${taskReadSql("$2")}
        ORDER BY t.due_at ASC NULLS LAST, t.updated_at DESC, t.id DESC
        LIMIT $4`,
      [identity.spaceId, identity.userId, DONE_TASK_STATUSES, limit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      priority: row.priority,
      risk_level: row.risk_level,
      task_type: row.task_type,
      assigned_user_id: row.assigned_user_id,
      assigned_agent_id: row.assigned_agent_id,
      due_at: isoOrNull(row.due_at),
      updated_at: iso(row.updated_at),
      visibility: row.visibility,
    }));
  }

  private async activitySummary(spaceId: string): Promise<HomeSummaryOut["activity_summary"]> {
    const result = await this.db.query<{
      recent_count: string | number;
      raw_count: string | number;
      today_count: string | number;
    }>(
      `SELECT
         count(*) FILTER (WHERE ar.created_at >= now() - interval '7 days')::text AS recent_count,
         count(*) FILTER (WHERE ar.status = 'raw')::text AS raw_count,
         count(*) FILTER (WHERE ar.created_at >= date_trunc('day', now()))::text AS today_count
       FROM activity_records ar
       WHERE ar.space_id = $1 AND ar.status NOT IN ('archived', 'failed')`,
      [spaceId],
    );
    const row = result.rows[0];
    return {
      recent_count: numeric(row?.recent_count),
      raw_count: numeric(row?.raw_count),
      today_count: numeric(row?.today_count),
    };
  }

  private async runStatsToday(spaceId: string): Promise<HomeSummaryOut["run_stats_today"]> {
    const result = await this.db.query<{
      created: string | number;
      queued: string | number;
      running: string | number;
      succeeded: string | number;
      failed: string | number;
      cancelled: string | number;
      dry_run_count: string | number;
    }>(
      `SELECT
         count(*)::text AS created,
         count(*) FILTER (WHERE status = 'queued')::text AS queued,
         count(*) FILTER (WHERE status = 'running')::text AS running,
         count(*) FILTER (WHERE status = 'succeeded')::text AS succeeded,
         count(*) FILTER (WHERE status = 'failed')::text AS failed,
         count(*) FILTER (WHERE status = 'cancelled')::text AS cancelled,
         count(*) FILTER (WHERE mode = 'dry_run')::text AS dry_run_count
       FROM runs
       WHERE space_id = $1
         AND run_role = 'execution'
         AND created_at >= date_trunc('day', now())`,
      [spaceId],
    );
    const row = result.rows[0];
    return {
      created: numeric(row?.created),
      queued: numeric(row?.queued),
      running: numeric(row?.running),
      succeeded: numeric(row?.succeeded),
      failed: numeric(row?.failed),
      cancelled: numeric(row?.cancelled),
      dry_run_count: numeric(row?.dry_run_count),
    };
  }

  private async jobQueueStatus(spaceId: string): Promise<HomeSummaryOut["job_queue_status"]> {
    const result = await this.db.query<{
      queued: string | number;
      running: string | number;
      failed: string | number;
      retryable: string | number;
      recent_error_preview: string | null;
    }>(
      `SELECT
         count(*) FILTER (WHERE status = 'pending')::text AS queued,
         count(*) FILTER (WHERE status IN ('claimed', 'running'))::text AS running,
         count(*) FILTER (WHERE status = 'failed')::text AS failed,
         count(*) FILTER (WHERE status = 'failed' AND attempts < max_attempts)::text AS retryable,
         (SELECT error
            FROM jobs
           WHERE space_id = $1 AND status = 'failed' AND error IS NOT NULL
           ORDER BY updated_at DESC, id DESC
           LIMIT 1) AS recent_error_preview
       FROM jobs
       WHERE space_id = $1`,
      [spaceId],
    );
    const row = result.rows[0];
    return {
      queued: numeric(row?.queued),
      running: numeric(row?.running),
      failed: numeric(row?.failed),
      retryable: numeric(row?.retryable),
      recent_error_preview: row?.recent_error_preview ?? null,
    };
  }

  private async runtimeStatus(spaceId: string): Promise<HomeSummaryOut["runtime_status"]> {
    const result = await this.db.query<{ adapter_type: string }>(
      `SELECT DISTINCT runtime_adapter_type AS adapter_type
         FROM runtime_tool_bindings
        WHERE space_id = $1 AND enabled = true
        ORDER BY runtime_adapter_type ASC`,
      [spaceId],
    );
    const types = result.rows.map((row) => row.adapter_type);
    return {
      real_adapters_configured_count: types.length,
      configured_adapter_types: types,
      message: types.length > 0 ? "Runtime adapters configured." : "No runtime adapters configured.",
    };
  }

  private async modelProviderStatus(
    spaceId: string,
  ): Promise<HomeSummaryOut["model_provider_status"]> {
    const result = await this.db.query<{
      total: string | number;
      enabled: string | number;
    }>(
      `SELECT count(*)::text AS total,
              count(*) FILTER (WHERE enabled = true)::text AS enabled
         FROM model_providers
        WHERE space_id = $1`,
      [spaceId],
    );
    const total = numeric(result.rows[0]?.total);
    const enabled = numeric(result.rows[0]?.enabled);
    return {
      model_providers_count: total,
      enabled_model_providers_count: enabled,
      missing_model_provider_config: enabled === 0,
      message: enabled > 0 ? "Model providers configured." : "No enabled model providers configured.",
    };
  }

  private async sourceSummary(spaceId: string): Promise<HomeSummaryOut["source_summary"]> {
    const result = await this.db.query<{
      open_items: string | number;
      new_items_today: string | number;
      pending_extraction_jobs: string | number;
      failed_extraction_jobs: string | number;
      candidate_evidence: string | number;
      active_evidence: string | number;
      due_connections: string | number;
    }>(
      `SELECT
         -- Triage moved from source_items.status to per-user library_status, so
         -- there is no longer an item-level "open" flag. Home stays space-scoped:
         -- an item is open while nobody in the space has dismissed it, which is
         -- what the old status IN ('new','triaged','selected') meant.
         (SELECT count(*)::text FROM source_items si
           WHERE si.space_id = $1 AND si.deleted_at IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM source_item_user_states suis
                WHERE suis.space_id = si.space_id AND suis.source_item_id = si.id
                  AND suis.library_status IN ('ignored', 'archived'))) AS open_items,
         (SELECT count(*)::text FROM source_items
           WHERE space_id = $1 AND deleted_at IS NULL AND created_at >= date_trunc('day', now())) AS new_items_today,
         (SELECT count(*)::text FROM extraction_jobs
           WHERE space_id = $1 AND status = 'pending') AS pending_extraction_jobs,
         (SELECT count(*)::text FROM extraction_jobs
           WHERE space_id = $1 AND status = 'failed') AS failed_extraction_jobs,
         (SELECT count(*)::text FROM extracted_evidence
           WHERE space_id = $1 AND deleted_at IS NULL AND status = 'candidate') AS candidate_evidence,
         (SELECT count(*)::text FROM extracted_evidence
           WHERE space_id = $1 AND deleted_at IS NULL AND status = 'active') AS active_evidence,
         (SELECT count(*)::text FROM source_connections
           WHERE space_id = $1 AND deleted_at IS NULL AND status = 'active') AS due_connections`,
      [spaceId],
    );
    const row = result.rows[0];
    return {
      open_items: numeric(row?.open_items),
      new_items_today: numeric(row?.new_items_today),
      pending_extraction_jobs: numeric(row?.pending_extraction_jobs),
      failed_extraction_jobs: numeric(row?.failed_extraction_jobs),
      candidate_evidence: numeric(row?.candidate_evidence),
      active_evidence: numeric(row?.active_evidence),
      due_connections: numeric(row?.due_connections),
    };
  }

  private async meSpaces(userId: string): Promise<MeSpaceRollup[]> {
    const result = await this.db.query<{
      space_id: string;
      name: string;
      type: string;
      pending_proposals_count: string | number;
      assigned_tasks_count: string | number;
      recent_failed_runs_count: string | number;
    }>(
      `SELECT s.id AS space_id,
              s.name,
              s.type,
              count(DISTINCT p.id) FILTER (WHERE p.status = 'pending' AND ${proposalReadSql("$1")})::text AS pending_proposals_count,
              count(DISTINCT t.id) FILTER (WHERE t.deleted_at IS NULL AND t.assigned_user_id = $1)::text AS assigned_tasks_count,
              count(DISTINCT r.id) FILTER (
                WHERE r.status = 'failed'
                  AND r.created_at >= now() - interval '7 days'
                  AND ${runReadSql("$1")}
              )::text AS recent_failed_runs_count
         FROM space_memberships sm
         JOIN spaces s ON s.id = sm.space_id
         LEFT JOIN proposals p ON p.space_id = sm.space_id
         LEFT JOIN runs run_for_instructed
           ON run_for_instructed.id = p.created_by_run_id
          AND run_for_instructed.space_id = p.space_id
         LEFT JOIN tasks t ON t.space_id = sm.space_id
         LEFT JOIN runs r ON r.space_id = sm.space_id
        WHERE sm.user_id = $1
          AND sm.status = 'active'
        GROUP BY s.id, s.name, s.type
        ORDER BY s.type ASC, s.name ASC, s.id ASC`,
      [userId],
    );
    return result.rows.map((row) => ({
      space_id: row.space_id,
      name: row.name,
      type: row.type,
      pending_proposals_count: numeric(row.pending_proposals_count),
      assigned_tasks_count: numeric(row.assigned_tasks_count),
      recent_failed_runs_count: numeric(row.recent_failed_runs_count),
    }));
  }

  private async meCounts(
    userId: string,
  ): Promise<{ pending_proposals_count: number; assigned_tasks_count: number }> {
    const result = await this.db.query<{
      pending_proposals_count: string | number;
      assigned_tasks_count: string | number;
    }>(
      `SELECT
         (SELECT count(p.id)::text
            FROM proposals p
            JOIN space_memberships sm ON sm.space_id = p.space_id
            LEFT JOIN runs run_for_instructed
              ON run_for_instructed.id = p.created_by_run_id
             AND run_for_instructed.space_id = p.space_id
           WHERE sm.user_id = $1
             AND sm.status = 'active'
             AND p.status = 'pending'
             AND ${proposalReadSql("$1")}) AS pending_proposals_count,
         (SELECT count(t.id)::text
            FROM tasks t
            JOIN space_memberships sm ON sm.space_id = t.space_id
           WHERE sm.user_id = $1
             AND sm.status = 'active'
             AND t.deleted_at IS NULL
             AND t.assigned_user_id = $1) AS assigned_tasks_count`,
      [userId],
    );
    return {
      pending_proposals_count: numeric(result.rows[0]?.pending_proposals_count),
      assigned_tasks_count: numeric(result.rows[0]?.assigned_tasks_count),
    };
  }

  private async meRecentRuns(userId: string, limit: number): Promise<MeRecentRunItem[]> {
    const result = await this.db.query<{
      id: string;
      space_id: string;
      agent_id: string;
      status: string;
      mode: string;
      run_type: string;
      created_at: unknown;
      updated_at: unknown;
    }>(
      `SELECT r.id, r.space_id, r.agent_id, r.status, r.mode,
              r.run_type, r.created_at, r.updated_at
         FROM runs r
         JOIN space_memberships sm
           ON sm.space_id = r.space_id
          AND sm.user_id = $1
          AND sm.status = 'active'
        WHERE ${runReadSql("$1")}
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT $2`,
      [userId, limit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      space_id: row.space_id,
      agent_id: row.agent_id,
      status: row.status,
      mode: row.mode,
      run_type: row.run_type,
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
    }));
  }

  private async meRecentParticipation(
    userId: string,
    limit: number,
  ): Promise<MeRecentParticipationItem[]> {
    if (limit === 0) return [];
    const result = await this.db.query<{
      id: string;
      user_id: string;
      personal_space_id: string;
      source_space_id: string;
      source_object_type: string;
      source_object_id: string;
      role: string;
      occurred_at: unknown;
      created_at: unknown;
    }>(
      `SELECT pr.id, pr.user_id, pr.personal_space_id, pr.source_space_id,
              pr.source_object_type, pr.source_object_id, pr.role,
              pr.occurred_at, pr.created_at
         FROM participation_records pr
         JOIN space_memberships sm
           ON sm.space_id = pr.source_space_id
          AND sm.user_id = pr.user_id
          AND sm.status = 'active'
        WHERE pr.user_id = $1
        ORDER BY pr.occurred_at DESC, pr.created_at DESC, pr.id DESC
        LIMIT $2`,
      [userId, limit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      user_id: row.user_id,
      personal_space_id: row.personal_space_id,
      source_space_id: row.source_space_id,
      source_object_type: row.source_object_type,
      source_object_id: row.source_object_id,
      role: row.role,
      occurred_at: iso(row.occurred_at),
      created_at: iso(row.created_at),
    }));
  }
}
