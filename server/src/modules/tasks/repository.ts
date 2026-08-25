import { randomUUID } from "node:crypto";
import type { Pool } from "../../db/pool";
import {
  HttpError,
  countFromRow,
  numberValue,
  objectValue,
  optionalObject,
  optionalString,
  page,
  requiredString,
  toDbDate,
  withDbTransaction,
  type SpaceUserIdentity,
  type Queryable,
} from "../routeUtils/common";
import { PgRunRepository } from "../runs/repository";
import { PgJobQueueRepository } from "../jobs/repository";
import { assertBudgetSourcesAvailable } from "../runs/budgetEnforcement";
import { contractRouteHints, budgetSourcesFromPolicy, type RunBudgetSource } from "../runs/contractSnapshot";
import { runToOut } from "../runs/runReadModel";
import { resolveRunRemoteness } from "../runs/runRemoteness";
import { PgUsageRepository } from "../usage/repository";
import { contentReadSql } from "../access/contentAccessSql";
import { recordDetailRead } from "../contentAccess/audit";
import { isContentVisibility } from "../access/contentAccessTypes";
import { assertProjectWriterForMutation, lockActiveProjectForMutation } from "../projects/access";
import { getLocalCliRuntimeAdapterSpec } from "../runtimeAdapters";
import { PgWorkspaceLocationRepository } from "../projectFolders/workspaceLocations";
import { PgHostTaskThreadRepository } from "../hosts/taskThreadRepository";
import { PgHostThreadMessageRepository } from "../hosts/threadMessageRepository";
import { advanceThreadQueue } from "../hosts/queueAdvance";
import {
  resolveHostProviderBinding,
  type ProviderLookupPort,
} from "../hosts/runtimeProviderBindingResolution";
import {
  lockTaskQueueForTerminalMutation,
  withdrawQueuedTaskMessages,
} from "./taskRunStatusProjection";
import {
  bounded01,
  boardColumnOut,
  boardOut,
  defaultTaskInstruction,
  taskArtifactOut,
  taskEvaluationOut,
  taskOut,
  taskProposalOut,
  taskRunOutFromList,
} from "./taskRepositoryMappers";

const DEFAULT_TASK_LIMITS = {
  maxRuns: 3,
  maxCost: 10,
  maxDurationSeconds: 3600,
} as const;
const TASK_STATUSES = new Set(["inbox", "ready", "in_progress", "blocked", "done", "cancelled"]);
const TASK_EXECUTION_TERMINAL_STATUSES = new Set(["blocked", "done", "cancelled"]);
import {
  BOARD_COLUMNS,
  BOARD_COLUMN_COLUMNS,
  DEFAULT_COLUMNS,
  TASK_COLUMNS,
  type BoardColumnRow,
  type BoardRow,
  type TaskArtifactRow,
  type TaskEvaluationRow,
  type TaskProposalRow,
  type TaskRow,
  type TaskRunListRow,
} from "./taskRepositoryRows";

export class PgTaskRepository {
  /**
   * `providers` is only consulted when a remote dispatch actually resolves a
   * ModelProvider binding, so callers that never dispatch remotely (Decision
   * cases, for one) may leave it unset.
   */
  constructor(
    private readonly pool: Pool,
    private readonly providers: ProviderLookupPort | null = null,
  ) {}

  async listBoards(identity: SpaceUserIdentity, filters: { projectFolderId: string | null; projectId: string | null; status: string | null; limit: number; offset: number }) {
    const params: unknown[] = [identity.spaceId];
    const clauses = ["space_id = $1"];
    const add = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    if (filters.projectFolderId) clauses.push(`project_folder_id = ${add(filters.projectFolderId)}`);
    if (filters.projectId) clauses.push(`project_id = ${add(filters.projectId)}`);
    if (filters.status) clauses.push(`status = ${add(filters.status)}`);
    else clauses.push("deleted_at IS NULL");
    const where = `WHERE ${clauses.join(" AND ")}`;
    const total = await this.pool.query<{ total: string }>(`SELECT count(*)::text AS total FROM boards ${where}`, params);
    const rows = await this.pool.query<BoardRow>(
      `SELECT ${BOARD_COLUMNS} FROM boards ${where}
       ORDER BY COALESCE(sort_order, 2147483647), updated_at DESC, id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, filters.limit, filters.offset],
    );
    return page(rows.rows.map(boardOut), countFromRow(total.rows[0]), filters.limit, filters.offset);
  }

  async createBoard(identity: SpaceUserIdentity, body: Record<string, unknown>) {
    return withDbTransaction(this.pool, async (client) => {
      const now = new Date().toISOString();
      const boardId = randomUUID();
      await client.query(
        `INSERT INTO boards (
           id, space_id, project_folder_id, project_id, name, description, board_type, status,
           default_view, sort_order, metadata_json, created_by_user_id,
           created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::int, $11::jsonb, $12, $13, $13)`,
        [
          boardId,
          identity.spaceId,
          optionalString(body.project_folder_id),
          optionalString(body.project_id),
          requiredString(body.name, "name"),
          optionalString(body.description),
          optionalString(body.board_type) ?? "project_folder",
          optionalString(body.status) ?? "active",
          optionalString(body.default_view),
          numberValue(body.sort_order),
          JSON.stringify(optionalObject(body.metadata_json)),
          identity.userId,
          now,
        ],
      );
      if (body.create_default_columns !== false) {
        for (const column of DEFAULT_COLUMNS) {
          await client.query(
            `INSERT INTO board_columns (
               id, space_id, board_id, name, status_key, position,
               is_done_column, is_default_column, metadata_json, created_at, updated_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '{}'::jsonb, $9, $9)`,
            [
              randomUUID(),
              identity.spaceId,
              boardId,
              column.name,
              column.status_key,
              column.position,
              column.isDone,
              column.isDefault,
              now,
            ],
          );
        }
      }
      return (await this.getBoardFrom(client, identity, boardId))!;
    });
  }

  async getBoard(identity: SpaceUserIdentity, boardId: string) {
    return this.getBoardFrom(this.pool, identity, boardId);
  }

  async updateBoard(identity: SpaceUserIdentity, boardId: string, body: Record<string, unknown>) {
    if (!(await this.getBoard(identity, boardId))) throw new HttpError(404, "Board not found");
    const now = new Date().toISOString();
    await this.pool.query(
      `UPDATE boards SET
         name = COALESCE($3, name),
         description = CASE WHEN $4::boolean THEN $5 ELSE description END,
         project_folder_id = CASE WHEN $6::boolean THEN $7 ELSE project_folder_id END,
         project_id = CASE WHEN $8::boolean THEN $9 ELSE project_id END,
         board_type = COALESCE($10, board_type),
         status = COALESCE($11, status),
         default_view = CASE WHEN $12::boolean THEN $13 ELSE default_view END,
         sort_order = CASE WHEN $14::boolean THEN $15::int ELSE sort_order END,
         metadata_json = CASE WHEN $16::boolean THEN $17::jsonb ELSE metadata_json END,
         deleted_at = CASE WHEN $18::boolean THEN $19::timestamptz ELSE deleted_at END,
         updated_at = $20
       WHERE space_id = $1 AND id = $2`,
      [
        identity.spaceId,
        boardId,
        optionalString(body.name),
        Object.hasOwn(body, "description"),
        optionalString(body.description),
        Object.hasOwn(body, "project_folder_id"),
        optionalString(body.project_folder_id),
        Object.hasOwn(body, "project_id"),
        optionalString(body.project_id),
        optionalString(body.board_type),
        optionalString(body.status),
        Object.hasOwn(body, "default_view"),
        optionalString(body.default_view),
        Object.hasOwn(body, "sort_order"),
        numberValue(body.sort_order),
        Object.hasOwn(body, "metadata_json"),
        JSON.stringify(optionalObject(body.metadata_json)),
        Object.hasOwn(body, "deleted_at"),
        toDbDate(body.deleted_at),
        now,
      ],
    );
    return (await this.getBoard(identity, boardId))!;
  }

  async listBoardTasks(identity: SpaceUserIdentity, boardId: string, limit: number, offset: number) {
    if (!(await this.getBoard(identity, boardId))) throw new HttpError(404, "Board not found");
    return this.listTasks(identity, { boardId, projectFolderId: null, projectId: null, status: null, assignedToMe: false, q: null, limit, offset });
  }

  async listTasks(identity: SpaceUserIdentity, filters: {
    boardId: string | null;
    projectFolderId: string | null;
    projectId: string | null;
    status: string | null;
    assignedToMe: boolean;
    q: string | null;
    limit: number;
    offset: number;
  }) {
    const built = buildTaskWhere(identity, filters);
    const total = await this.pool.query<{ total: string }>(`SELECT count(*)::text AS total FROM tasks t ${built.where}`, built.params);
    const rows = await this.pool.query<TaskRow>(
      `SELECT ${TASK_COLUMNS} FROM tasks t ${built.where}
       ORDER BY t.updated_at DESC, t.id DESC
       LIMIT $${built.params.length + 1} OFFSET $${built.params.length + 2}`,
      [...built.params, filters.limit, filters.offset],
    );
    return page(rows.rows.map(taskOut), countFromRow(total.rows[0]), filters.limit, filters.offset);
  }

  async listMyTasks(identity: SpaceUserIdentity, filters: { status: string | null; limit: number; offset: number }) {
    const params: unknown[] = [identity.userId];
    const clauses = [
      "sm.user_id = $1",
      "sm.status = 'active'",
      "t.deleted_at IS NULL",
      contentReadSql("task", "t", "$1"),
      "(t.assigned_user_id = $1 OR t.claimed_by_user_id = $1 OR t.created_by_user_id = $1)",
    ];
    if (filters.status) {
      params.push(filters.status);
      clauses.push(`t.status = $${params.length}`);
    }
    const where = `WHERE ${clauses.join(" AND ")}`;
    const total = await this.pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM tasks t JOIN space_memberships sm ON sm.space_id = t.space_id ${where}`,
      params,
    );
    const rows = await this.pool.query<TaskRow>(
      `SELECT t.${TASK_COLUMNS.trim().replace(/,\s*/g, ", t.")}
         FROM tasks t
         JOIN space_memberships sm ON sm.space_id = t.space_id
        ${where}
        ORDER BY t.updated_at DESC, t.id DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, filters.limit, filters.offset],
    );
    return page(rows.rows.map(taskOut), countFromRow(total.rows[0]), filters.limit, filters.offset);
  }

  async createTask(identity: SpaceUserIdentity, body: Record<string, unknown>, db: Queryable = this.pool) {
    const now = new Date().toISOString();
    const visibility = optionalString(body.visibility) ?? "private";
    if (!isContentVisibility(visibility)) throw new HttpError(422, "Invalid visibility");
    const taskRole = optionalString(body.task_role) ?? "source";
    if (taskRole !== "source" && taskRole !== "subtask") throw new HttpError(422, "task_role must be 'source' or 'subtask'");
    const parentTaskId = optionalString(body.parent_task_id);
    if (taskRole === "source" && parentTaskId) throw new HttpError(422, "Source tasks cannot have a parent task");
    if (taskRole === "subtask") {
      if (!parentTaskId) throw new HttpError(422, "Subtasks require a parent task");
      const parent = await db.query<{ id: string }>(
        `SELECT id FROM tasks WHERE id = $1 AND space_id = $2 AND deleted_at IS NULL`,
        [parentTaskId, identity.spaceId],
      );
      if (!parent.rows[0]) throw new HttpError(404, "Parent task not found");
    }
    const result = await db.query<TaskRow>(
      `INSERT INTO tasks (
         id, space_id, project_folder_id, project_id, board_id, column_id, parent_task_id,
         task_role, title, description, task_type, status, priority, risk_level, visibility,
         owner_user_id, created_by_user_id, assigned_user_id, assigned_agent_id,
         source_activity_id, source_run_id, source_proposal_id, source_artifact_id,
         acceptance_criteria_json, definition_of_done, required_outputs_json,
         due_at, start_after, max_runs, max_cost, max_duration_seconds,
         policy_json, metadata_json, tags, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         $8, $9, $10, $11, $12, $13, $14, $15,
         $16, $16, $17, $18,
         $19, $20, $21, $22,
         $23::jsonb, $24, $25::jsonb,
         $26::timestamptz, $27::timestamptz, $28::int, $29::float, $30::int,
         $31::jsonb, $32::jsonb, $33::jsonb, $34, $34
       ) RETURNING ${TASK_COLUMNS}`,
      [
        randomUUID(),
        identity.spaceId,
        optionalString(body.project_folder_id),
        optionalString(body.project_id),
        optionalString(body.board_id),
        optionalString(body.column_id),
        parentTaskId,
        taskRole,
        requiredString(body.title, "title"),
        optionalString(body.description),
        optionalString(body.task_type) ?? "general",
        taskStatus(body.status) ?? "inbox",
        optionalString(body.priority) ?? "normal",
        optionalString(body.risk_level) ?? "low",
        visibility,
        identity.userId,
        optionalString(body.assigned_user_id),
        optionalString(body.assigned_agent_id),
        optionalString(body.source_activity_id),
        optionalString(body.source_run_id),
        optionalString(body.source_proposal_id),
        optionalString(body.source_artifact_id),
        JSON.stringify(optionalObject(body.acceptance_criteria_json)),
        optionalString(body.definition_of_done),
        JSON.stringify(Array.isArray(body.required_outputs_json) ? body.required_outputs_json : null),
        toDbDate(body.due_at),
        toDbDate(body.start_after),
        defaultNumber(body.max_runs, DEFAULT_TASK_LIMITS.maxRuns),
        defaultNumber(body.max_cost, DEFAULT_TASK_LIMITS.maxCost),
        defaultNumber(body.max_duration_seconds, DEFAULT_TASK_LIMITS.maxDurationSeconds),
        JSON.stringify(optionalObject(body.policy_json)),
        JSON.stringify(optionalObject(body.metadata_json)),
        JSON.stringify(Array.isArray(body.tags) ? body.tags : null),
        now,
      ],
    );
    return taskOut(result.rows[0]!);
  }

  /** Creates the smallest durable Task needed when a composer has no task id. */
  async createLightweightTaskAndRun(identity: SpaceUserIdentity, body: Record<string, unknown>) {
    const prompt = optionalString(body.prompt);
    if (!prompt) throw new HttpError(422, "prompt is required");
    const admission = await withDbTransaction(this.pool, async (client) => {
      const projectFolderId = optionalString(body.project_folder_id);
      let projectId = optionalString(body.project_id);
      let admissionBody = body;
      if (projectFolderId) {
        const folder = await client.query<{ project_id: string }>(
          `SELECT project_id FROM project_folders WHERE id = $1 AND space_id = $2 LIMIT 1`,
          [projectFolderId, identity.spaceId],
        );
        if (!folder.rows[0]) throw new HttpError(404, "Project Folder not found");
        if (projectId && folder.rows[0].project_id !== projectId) {
          throw new HttpError(409, "Project Folder does not belong to the selected Project");
        }
        projectId = folder.rows[0].project_id;
      }
      // The route performs a fast preflight, but the durable Task + Run write
      // must re-check authority while holding the Project aggregate lock. This
      // closes the revoke/archive race between authorization and admission.
      if (projectId) {
        await lockActiveProjectForMutation(client, identity.spaceId, projectId);
        await assertProjectWriterForMutation(client, identity.spaceId, projectId, identity.userId);
        admissionBody = { ...body, project_id: projectId, visibility: "space_shared" };
      }
      const title = optionalString(body.task_title) ?? prompt.slice(0, 120);
      const task = await this.createTask(identity, {
        title: title || "Workspace task",
        description: optionalString(body.task_description),
        project_folder_id: projectFolderId,
        project_id: projectId,
        task_type: "coding",
        status: "ready",
        visibility: "space_shared",
        assigned_agent_id: optionalString(body.agent_id),
      }, client);
      return this.createTaskRunAdmission(identity, task.id, admissionBody, client);
    });
    return this.finishTaskRunAdmission(admission);
  }

  async getTask(identity: SpaceUserIdentity, taskId: string) {
    const row = await getVisibleTaskRow(this.pool, identity, taskId);
    if (!row) return null;
    await recordDetailRead(this.pool, {
      spaceId: identity.spaceId,
      viewerUserId: identity.userId,
      resourceType: "task",
      resourceId: taskId,
    });
    return taskOut(row);
  }

  async updateTask(identity: SpaceUserIdentity, taskId: string, body: Record<string, unknown>) {
    const currentTask = await getVisibleTaskRow(this.pool, identity, taskId);
    if (!currentTask) throw new HttpError(404, "Task not found");
    if (Object.hasOwn(body, "parent_task_id")) {
      const parentTaskId = optionalString(body.parent_task_id);
      if (parentTaskId && parentTaskId === taskId) throw new HttpError(422, "A task cannot be its own parent");
      if (parentTaskId) {
        const parent = await this.pool.query<{ id: string }>(
          `SELECT id FROM tasks WHERE id = $1 AND space_id = $2 AND deleted_at IS NULL`,
          [parentTaskId, identity.spaceId],
        );
        if (!parent.rows[0]) throw new HttpError(404, "Parent task not found");
      }
      if (currentTask.task_role === "source" && parentTaskId) throw new HttpError(422, "Source tasks cannot have a parent task");
    }
    const now = new Date().toISOString();
    const requestedStatus = taskStatus(body.status);
    await withDbTransaction(this.pool, async (client) => {
      if (requestedStatus && TASK_EXECUTION_TERMINAL_STATUSES.has(requestedStatus)) {
        await lockTaskQueueForTerminalMutation(client, identity.spaceId, [taskId]);
      }
      await client.query(
      `UPDATE tasks SET
         title = COALESCE($3, title),
         description = CASE WHEN $4::boolean THEN $5 ELSE description END,
         project_folder_id = CASE WHEN $6::boolean THEN $7 ELSE project_folder_id END,
         project_id = CASE WHEN $8::boolean THEN $9 ELSE project_id END,
         board_id = CASE WHEN $10::boolean THEN $11 ELSE board_id END,
         column_id = CASE WHEN $12::boolean THEN $13 ELSE column_id END,
         parent_task_id = CASE WHEN $14::boolean THEN $15 ELSE parent_task_id END,
         task_type = COALESCE($16, task_type),
         status = COALESCE($17, status),
         priority = COALESCE($18, priority),
         risk_level = COALESCE($19, risk_level),
         assigned_user_id = CASE WHEN $20::boolean THEN $21 ELSE assigned_user_id END,
         assigned_agent_id = CASE WHEN $22::boolean THEN $23 ELSE assigned_agent_id END,
         claimed_by_user_id = CASE WHEN $24::boolean THEN $25 ELSE claimed_by_user_id END,
         claimed_by_agent_id = CASE WHEN $26::boolean THEN $27 ELSE claimed_by_agent_id END,
         completed_at = CASE WHEN $28::boolean THEN $29::timestamptz ELSE completed_at END,
         cancelled_at = CASE WHEN $30::boolean THEN $31::timestamptz ELSE cancelled_at END,
         blocked_reason = CASE WHEN $32::boolean THEN $33 ELSE blocked_reason END,
         acceptance_criteria_json = CASE WHEN $34::boolean THEN $35::jsonb ELSE acceptance_criteria_json END,
         definition_of_done = CASE WHEN $36::boolean THEN $37 ELSE definition_of_done END,
         required_outputs_json = CASE WHEN $38::boolean THEN $39::jsonb ELSE required_outputs_json END,
         due_at = CASE WHEN $40::boolean THEN $41::timestamptz ELSE due_at END,
         start_after = CASE WHEN $42::boolean THEN $43::timestamptz ELSE start_after END,
         estimated_effort = CASE WHEN $44::boolean THEN $45 ELSE estimated_effort END,
         actual_effort = CASE WHEN $46::boolean THEN $47 ELSE actual_effort END,
         max_runs = CASE WHEN $48::boolean THEN $49::int ELSE max_runs END,
         max_cost = CASE WHEN $50::boolean THEN $51::float ELSE max_cost END,
         max_duration_seconds = CASE WHEN $52::boolean THEN $53::int ELSE max_duration_seconds END,
         policy_json = CASE WHEN $54::boolean THEN $55::jsonb ELSE policy_json END,
         metadata_json = CASE WHEN $56::boolean THEN $57::jsonb ELSE metadata_json END,
         tags = CASE WHEN $58::boolean THEN $59::jsonb ELSE tags END,
         deleted_at = CASE WHEN $60::boolean THEN $61::timestamptz ELSE deleted_at END,
         updated_at = $62
       WHERE space_id = $1 AND id = $2`,
      [
        identity.spaceId,
        taskId,
        optionalString(body.title),
        Object.hasOwn(body, "description"),
        optionalString(body.description),
        Object.hasOwn(body, "project_folder_id"),
        optionalString(body.project_folder_id),
        Object.hasOwn(body, "project_id"),
        optionalString(body.project_id),
        Object.hasOwn(body, "board_id"),
        optionalString(body.board_id),
        Object.hasOwn(body, "column_id"),
        optionalString(body.column_id),
        Object.hasOwn(body, "parent_task_id"),
        optionalString(body.parent_task_id),
        optionalString(body.task_type),
        requestedStatus,
        optionalString(body.priority),
        optionalString(body.risk_level),
        Object.hasOwn(body, "assigned_user_id"),
        optionalString(body.assigned_user_id),
        Object.hasOwn(body, "assigned_agent_id"),
        optionalString(body.assigned_agent_id),
        Object.hasOwn(body, "claimed_by_user_id"),
        optionalString(body.claimed_by_user_id),
        Object.hasOwn(body, "claimed_by_agent_id"),
        optionalString(body.claimed_by_agent_id),
        Object.hasOwn(body, "completed_at"),
        toDbDate(body.completed_at),
        Object.hasOwn(body, "cancelled_at"),
        toDbDate(body.cancelled_at),
        Object.hasOwn(body, "blocked_reason"),
        optionalString(body.blocked_reason),
        Object.hasOwn(body, "acceptance_criteria_json"),
        JSON.stringify(optionalObject(body.acceptance_criteria_json)),
        Object.hasOwn(body, "definition_of_done"),
        optionalString(body.definition_of_done),
        Object.hasOwn(body, "required_outputs_json"),
        JSON.stringify(Array.isArray(body.required_outputs_json) ? body.required_outputs_json : null),
        Object.hasOwn(body, "due_at"),
        toDbDate(body.due_at),
        Object.hasOwn(body, "start_after"),
        toDbDate(body.start_after),
        Object.hasOwn(body, "estimated_effort"),
        optionalString(body.estimated_effort),
        Object.hasOwn(body, "actual_effort"),
        optionalString(body.actual_effort),
        Object.hasOwn(body, "max_runs"),
        numberValue(body.max_runs),
        Object.hasOwn(body, "max_cost"),
        numberValue(body.max_cost),
        Object.hasOwn(body, "max_duration_seconds"),
        numberValue(body.max_duration_seconds),
        Object.hasOwn(body, "policy_json"),
        JSON.stringify(optionalObject(body.policy_json)),
        Object.hasOwn(body, "metadata_json"),
        JSON.stringify(optionalObject(body.metadata_json)),
        Object.hasOwn(body, "tags"),
        JSON.stringify(Array.isArray(body.tags) ? body.tags : null),
        Object.hasOwn(body, "deleted_at"),
        toDbDate(body.deleted_at),
        now,
        ],
      );
      if (requestedStatus && TASK_EXECUTION_TERMINAL_STATUSES.has(requestedStatus)) {
        await withdrawQueuedTaskMessages(client, identity.spaceId, [taskId]);
      }
    });
    return (await this.getTask(identity, taskId))!;
  }

  async createTaskRun(identity: SpaceUserIdentity, taskId: string, body: Record<string, unknown>) {
    const admission = await this.createTaskRunAdmission(identity, taskId, body);
    return this.finishTaskRunAdmission(admission);
  }

  private async createTaskRunAdmission(
    identity: SpaceUserIdentity,
    taskId: string,
    body: Record<string, unknown>,
    transactionClient?: Queryable,
  ) {
    const execute = async (client: Queryable) => {
      const task = await getVisibleTaskRow(client, identity, taskId);
      if (!task) throw new HttpError(404, "Task not found");
      if (task.project_id) {
        // Every Task-owned Run, regardless of whether its adapter is server
        // or remote, is a Project mutation. Recheck the writer after the
        // request-level read gate and hold the Project lock through admission.
        await lockActiveProjectForMutation(client, identity.spaceId, task.project_id);
        await assertProjectWriterForMutation(client, identity.spaceId, task.project_id, identity.userId);
      }
      // Serialize admissions for this task. The max_runs check and the
      // task_runs insert must observe one state, otherwise two concurrent
      // requests can both pass the preflight check.
      const lockedTask = await client.query<{ max_runs: number | null; status: string }>(
        `SELECT max_runs, status FROM tasks WHERE space_id = $1 AND id = $2 FOR UPDATE`,
        [identity.spaceId, taskId],
      );
      const currentTask = lockedTask.rows[0];
      if (!currentTask) throw new HttpError(404, "Task not found");
      if (TASK_EXECUTION_TERMINAL_STATUSES.has(currentTask.status)) {
        throw new HttpError(409, `Task is ${currentTask.status} and cannot be dispatched`);
      }
      const maxRuns = currentTask.max_runs;
      const taskPolicy = objectValue(task.policy_json);
      const budgetSources: RunBudgetSource[] = [
        {
          source: { kind: "task", id: task.id },
          precedence: numberValue(taskPolicy.budget_precedence),
          max_runs: maxRuns,
          max_attempts: positiveIntegerOrNull(taskPolicy.max_attempts),
          max_cost: typeof task.max_cost === "number" ? task.max_cost : null,
          max_duration_seconds: typeof task.max_duration_seconds === "number" ? task.max_duration_seconds : null,
        },
        ...budgetSourcesFromPolicy(taskPolicy.budget_sources),
      ];
      // Resolve and enforce every effective inherited source before creating
      // either the Run or its task_runs link. Dispatch must never be the first
      // place that discovers an Automation/Workflow cap.
      await assertBudgetSourcesAvailable(client, identity.spaceId, budgetSources);

      const locations = new PgWorkspaceLocationRepository(client);
      const namedLocationId = optionalString(body.workspace_location_id);
      const preferred = !namedLocationId && task.project_folder_id
        ? await locations.getPreferred(task.project_folder_id)
        : null;
      const target = namedLocationId
        ? await locations.resolveDispatchTarget(namedLocationId)
        : preferred
          ? await locations.resolveDispatchTarget(preferred.id)
          : null;
      if (namedLocationId && !target) throw new HttpError(404, "Workspace Location not found");
      if (task.project_folder_id && !target) {
        throw new HttpError(409, "Task Project Folder has no active preferred Workspace Location");
      }
      if (target && (target.space_id !== identity.spaceId || target.project_folder_id !== task.project_folder_id || target.project_id !== task.project_id)) {
        throw new HttpError(409, "Workspace Location does not belong to this Task's Project Folder");
      }
      if (target?.execution_host_kind === "remote") {
        const remote = await this.prepareRemoteTaskRun(client, identity, task, target, body);
        return { kind: "remote" as const, remote };
      }
      if (target && !target.execution_ready) {
        throw new HttpError(409, "Workspace Location is not execution-ready");
      }
      // A host×adapter binding is a remote-host concept: a server-host run
      // picks its provider through routing. Accepting either override here and
      // ignoring it would run on a backend the caller did not ask for, which
      // is the substitution this whole path exists to prevent.
      for (const key of ["model_provider_id", "model"]) {
        if (Object.hasOwn(body, key)) {
          throw new HttpError(422, `${key} applies only to a remote Workspace Location`);
        }
      }
      const agentId = optionalString(body.agent_id) ?? task.assigned_agent_id;
      if (!agentId) throw new HttpError(422, "agent_id is required when task has no assigned_agent_id");
      await assertRunnableAgent(client, identity.spaceId, agentId);
      const run = await new PgRunRepository(client).createQueuedRun({
        agent_id: agentId,
        space_id: identity.spaceId,
        user_id: identity.userId,
        mode: optionalString(body.mode) ?? "live",
        run_type: optionalString(body.run_type) ?? "agent",
        trigger_origin: optionalString(body.trigger_origin) ?? "manual",
        session_id: optionalString(body.session_id),
        project_folder_id: task.project_folder_id,
        workspace_location_id: target?.location_id ?? null,
        trust_mode: target ? "sandboxed" : null,
        project_id: task.project_id,
        prompt: optionalString(body.prompt),
        instruction: optionalString(body.instruction) ?? defaultTaskInstruction(task),
        scheduled_at: toDbDate(body.scheduled_at),
        parent_run_id: optionalString(body.parent_run_id),
        contract_snapshot: {
          source: { kind: "task", id: task.id },
          project_id: task.project_id,
          project_folder_id: task.project_folder_id,
          acceptance_criteria_json: task.acceptance_criteria_json,
          definition_of_done: task.definition_of_done,
          required_outputs_json: task.required_outputs_json,
          risk_level: task.risk_level,
          max_runs: maxRuns,
          max_attempts: positiveIntegerOrNull(body.max_attempts) ?? positiveIntegerOrNull(taskPolicy.max_attempts),
          max_cost: task.max_cost,
          max_duration_seconds: task.max_duration_seconds,
          budget_precedence: numberValue(taskPolicy.budget_precedence),
          budget_sources: budgetSourcesFromPolicy(taskPolicy.budget_sources),
          route_hints_json: contractRouteHints(task.policy_json),
        },
      });
      const now = new Date().toISOString();
      await client.query(
        `INSERT INTO task_runs (id, space_id, task_id, run_id, role, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (task_id, run_id) DO NOTHING`,
        [randomUUID(), identity.spaceId, taskId, run.id, optionalString(body.role) ?? "primary", now],
      );
      await new PgJobQueueRepository(client).ensureAgentRunJob({
        job_type: "agent_run",
        space_id: identity.spaceId,
        user_id: identity.userId,
        agent_id: agentId,
        project_folder_id: task.project_folder_id,
        payload: { run_id: run.id },
      });
      if (body.set_task_in_progress !== false) {
        await client.query(`UPDATE tasks SET status = 'in_progress', updated_at = $3 WHERE space_id = $1 AND id = $2`, [identity.spaceId, taskId, now]);
      }
      return {
        kind: "server" as const,
        run: runToOut(run, null, {
          executes_remotely: (await resolveRunRemoteness(client, [run])).has(run.id),
        }),
      };
    };
    return transactionClient ? execute(transactionClient) : withDbTransaction(this.pool, execute);
  }

  private async finishTaskRunAdmission(
    admission: Awaited<ReturnType<PgTaskRepository["createTaskRunAdmission"]>>,
  ) {
    if (admission.kind === "server") return admission.run;
    const advance = await advanceThreadQueue(this.pool, admission.remote.threadId, {
      messageId: admission.remote.messageId,
      timeoutMs: admission.remote.timeoutMs,
    });
    if (!advance.advanced && advance.reason === "task_authority_lost") {
      throw new HttpError(409, "Project authority changed before dispatch; queued Task message was withdrawn");
    }
    const dispatched = advance.advanced && advance.message_id === admission.remote.messageId;
    return {
      message_id: admission.remote.messageId,
      thread_id: admission.remote.threadId,
      run_id: dispatched ? advance.run_id : null,
      status: dispatched ? "dispatched" : "queued",
    };
  }

  /**
   * The remote-host half of the merged dispatch endpoint (D5) — what used
   * to be the former host-dispatch route. Unlike the server-host branch
   * above, this never creates a Run synchronously: it enqueues a message on
   * the Task's HostTaskThread for `target.location_id` and lets
   * `advanceThreadQueue` create the Run (and this Task's `task_runs` link)
   * once nothing blocks it, exactly as the old route did — merging the
   * routes did not merge the two adapters' execution shape (D5), only where
   * a caller reaches them from.
   */
  private async prepareRemoteTaskRun(
    client: Queryable,
    identity: SpaceUserIdentity,
    task: TaskRow,
    target: NonNullable<Awaited<ReturnType<PgWorkspaceLocationRepository["resolveDispatchTarget"]>>>,
    body: Record<string, unknown>,
  ) {
    // The merged task-run admission gate above already locked the active
    // Project and verified the caller's writer access before either adapter
    // branch was selected. Keep this method focused on remote topology and
    // runtime validation.
    if (!task.project_id) throw new HttpError(409, "Remote dispatch requires a Task Project");
    if (target.host_owner_user_id !== identity.userId) {
      throw new HttpError(403, "This workspace's host does not belong to you");
    }
    if (!target.host_online) throw new HttpError(409, "Host is offline");
    if (!target.execution_ready) throw new HttpError(409, "Workspace Location is not execution-ready");

    const adapterType = optionalString(body.adapter_type);
    if (!adapterType) throw new HttpError(422, "adapter_type is required for a remote Workspace Location");
    const spec = getLocalCliRuntimeAdapterSpec(adapterType);
    if (!spec) throw new HttpError(422, `Unknown runtime adapter '${adapterType}'`);
    if (spec.implementation_status !== "implemented" || spec.invocation.protocol !== "acp") {
      throw new HttpError(422, `Runtime adapter '${adapterType}' is not supported for remote dispatch`);
    }
    const reportedRuntimes = Array.isArray((target.capabilities_json as { runtimes?: unknown })?.runtimes)
      ? ((target.capabilities_json as { runtimes: unknown[] }).runtimes as unknown[])
      : [];
    const capabilityProbeCommand = spec.invocation.remote_capability_probe ?? spec.executable.command;
    if (!reportedRuntimes.includes(capabilityProbeCommand)) {
      throw new HttpError(422, `Host does not report '${capabilityProbeCommand}' as an installed runtime`);
    }
    const prompt = optionalString(body.prompt);
    if (!prompt) throw new HttpError(422, "prompt is required");

    const threads = new PgHostTaskThreadRepository(client);
    const threadId = optionalString(body.thread_id);
    let thread = threadId ? await threads.getForLocation(threadId, target.location_id) : null;
    if (threadId && !thread) throw new HttpError(404, "Task thread not found for this Workspace Location");
    if (thread && thread.adapter_type !== adapterType) {
      throw new HttpError(409, "Task thread is pinned to a different runtime adapter");
    }
    if (!thread) {
      thread = await threads.create({
        workspaceLocationId: target.location_id,
        adapterType,
        createdByUserId: identity.userId,
      });
    }

    const messages = new PgHostThreadMessageRepository(client);
    // A thread keeps the backend it last ran against. Without this, resolution
    // re-reads the Host × adapter default every dispatch, so changing that
    // default moves every existing thread on the host onto a new backend —
    // and since the vendor session lives inside the new provider's profile,
    // each of them silently loses its conversation too. The Host default
    // decides a thread's first backend; after that the thread is explicit.
    //
    // An explicit override still wins and becomes what the thread inherits
    // next time, which is how a user changes a thread's backend.
    const inherited = Object.hasOwn(body, "model_provider_id")
      ? null
      : await messages.currentBinding(thread.id);

    // Resolve and validate the model backend before the message is queued, so
    // an unusable provider fails this request rather than a run on someone's
    // laptop minutes later.
    const binding = await resolveHostProviderBinding({
      db: client,
      providers: this.providers,
      spaceId: identity.spaceId,
      hostId: target.host_id,
      adapterType,
      override: inherited
        ? {
            model_provider_id: inherited.provider_id,
            // Key presence again, for the same reason it governs the provider:
            // `{ model: null }` is "drop the pinned model and let the endpoint
            // choose", and coalescing it into the inherited value would make
            // that request unexpressible.
            model: Object.hasOwn(body, "model") ? optionalString(body.model) : inherited.model,
            provenance: "thread",
          }
        : {
            // Raw, not `optionalString`: that maps an empty or malformed value
            // to null, which resolution must be able to tell apart from the
            // explicit null that means "ambient login for this dispatch".
            model_provider_id: body.model_provider_id,
            model: optionalString(body.model),
          },
      overrideProvided: Object.hasOwn(body, "model_provider_id") || inherited !== null,
      // Only read on the non-override branch, which inheritance never takes;
      // the inherited model travels in `override.model` above.
      modelOverrideProvided: Object.hasOwn(body, "model"),
    });

    const message = await messages.enqueue(thread.id, task.id, prompt, identity.userId, binding);
    if (body.set_task_in_progress !== false) {
      await client.query(
        `UPDATE tasks SET status = 'in_progress', updated_at = now() WHERE space_id = $1 AND id = $2`,
        [identity.spaceId, task.id],
      );
    }
    return {
      messageId: message.id,
      threadId: thread.id,
      timeoutMs: numberValue(body.timeout_ms) ?? null,
    };
  }

  async requestPlanningRun(identity: SpaceUserIdentity, taskId: string, body: Record<string, unknown>) {
    return withDbTransaction(this.pool, async (client) => {
      const taskResult = await client.query<TaskRow>(
        `SELECT ${TASK_COLUMNS} FROM tasks t WHERE t.space_id = $1 AND t.id = $2 AND t.deleted_at IS NULL FOR UPDATE`,
        [identity.spaceId, taskId],
      );
      const task = taskResult.rows[0];
      if (!task) throw new HttpError(404, "Task not found");
      if (task.task_role !== "source") throw new HttpError(409, "Only source tasks can request Agent planning");
      const agentId = optionalString(body.agent_id) ?? task.assigned_agent_id;
      if (!agentId) throw new HttpError(422, "agent_id is required when the Task has no assigned agent");
      await assertRunnableAgent(client, identity.spaceId, agentId, "Planning Agent not found or inactive in this Space");
      const referenceWorkflowVersionId = optionalString(body.reference_workflow_version_id);
      if (referenceWorkflowVersionId) {
        const reference = await client.query<{ id: string }>(
          `SELECT v.id
             FROM evolvable_asset_versions v
             JOIN evolvable_assets a ON a.id = v.asset_id
            WHERE v.id = $1
              AND a.asset_type = 'workflow_template'
              AND v.status = 'approved'
              AND (v.space_id IS NULL OR v.space_id = $2)
              AND (
                v.scope_type = 'system'
                OR (v.scope_type = 'space' AND v.scope_id = $2)
                OR (v.scope_type = 'project' AND v.scope_id IS NOT DISTINCT FROM $3)
              )`,
          [referenceWorkflowVersionId, identity.spaceId, task.project_id],
        );
        if (!reference.rows[0]) throw new HttpError(404, "Reference Workflow Version not found or not visible in this Space");
      }
      const budgetSources: RunBudgetSource[] = [{
        source: { kind: "task", id: task.id },
        max_runs: task.max_runs,
        max_cost: typeof task.max_cost === "number" ? task.max_cost : null,
        max_duration_seconds: typeof task.max_duration_seconds === "number" ? task.max_duration_seconds : null,
      }];
      await assertBudgetSourcesAvailable(client, identity.spaceId, budgetSources);
      const run = await new PgRunRepository(client).createQueuedRun({
        agent_id: agentId,
        space_id: identity.spaceId,
        user_id: identity.userId,
        mode: "live",
        run_type: "planning",
        trigger_origin: "manual",
        project_folder_id: task.project_folder_id,
        project_id: task.project_id,
        prompt: optionalString(body.prompt) ?? `Plan Task: ${task.title}`,
        instruction: optionalString(body.instruction) ?? planningInstruction(task, referenceWorkflowVersionId),
        workflow_version_id: referenceWorkflowVersionId,
        capabilities_json: ["task.plan.propose"],
        contract_snapshot: {
          source: { kind: "task", id: task.id },
          project_id: task.project_id,
          project_folder_id: task.project_folder_id,
          acceptance_criteria_json: task.acceptance_criteria_json,
          definition_of_done: task.definition_of_done,
          required_outputs_json: task.required_outputs_json,
          risk_level: task.risk_level,
          max_runs: task.max_runs,
          max_cost: task.max_cost,
          max_duration_seconds: task.max_duration_seconds,
          budget_sources: budgetSources,
          route_hints_json: { planning_task_id: task.id, reference_workflow_version_id: referenceWorkflowVersionId },
        },
      });
      const now = new Date().toISOString();
      await client.query(
        `INSERT INTO task_runs (id, space_id, task_id, run_id, role, created_at)
         VALUES ($1, $2, $3, $4, 'planning', $5) ON CONFLICT (task_id, run_id) DO NOTHING`,
        [randomUUID(), identity.spaceId, task.id, run.id, now],
      );
      await new PgJobQueueRepository(client).enqueue({
        job_type: "agent_run",
        space_id: identity.spaceId,
        user_id: identity.userId,
        agent_id: agentId,
        project_folder_id: task.project_folder_id,
        payload: { run_id: run.id, task_id: task.id, planning: true },
      });
      return runToOut(run, null, {
        executes_remotely: (await resolveRunRemoteness(this.pool, [run])).has(run.id),
      });
    });
  }

  async listTaskRuns(identity: SpaceUserIdentity, taskId: string, limit: number, offset: number) {
    if (!(await getVisibleTaskRow(this.pool, identity, taskId))) throw new HttpError(404, "Task not found");
    const total = await this.pool.query<{ total: string }>(
      `SELECT count(*)::text AS total
         FROM task_runs tr
         JOIN runs r ON r.id = tr.run_id AND r.space_id = tr.space_id
        WHERE tr.space_id = $1 AND tr.task_id = $2
          AND ${contentReadSql("run", "r", "$3")}`,
      [identity.spaceId, taskId, identity.userId],
    );
    const rows = await this.pool.query<TaskRunListRow>(
      `SELECT tr.id AS task_run_id, tr.space_id AS task_run_space_id, tr.task_id AS task_run_task_id,
              tr.run_id AS task_run_run_id, tr.role AS task_run_role, tr.created_at AS task_run_created_at,
              r.id, r.space_id, r.agent_id, r.agent_version_id, r.run_type,
              r.status, r.mode, r.prompt, r.instruction, r.project_folder_id, r.workspace_location_id, r.trust_mode, r.session_id,
              r.parent_run_id, r.project_id, r.scheduled_at, r.adapter_type, r.capability_id,
              r.model_provider_id, r.model_override_json, r.required_sandbox_level,
              r.contract_snapshot_json, r.workflow_version_id, r.trigger_origin,
              r.instructed_by_user_id, r.error_message, r.error_json, r.output_json,
              r.started_at, r.ended_at, r.created_at, r.updated_at,
              r.owner_user_id, r.visibility, r.access_level
        FROM task_runs tr
         JOIN runs r ON r.id = tr.run_id AND r.space_id = tr.space_id
        WHERE tr.space_id = $1 AND tr.task_id = $2
          AND ${contentReadSql("run", "r", "$3")}
        ORDER BY tr.created_at DESC, tr.id DESC
        LIMIT $4 OFFSET $5`,
      [identity.spaceId, taskId, identity.userId, limit, offset],
    );
    const [usageByRun, remoteRuns] = await Promise.all([
      new PgUsageRepository(this.pool).summarizeRunUsageByRunIds(
        identity.spaceId,
        rows.rows.map((row) => row.id),
      ),
      // One query for the page, and only for rows that recorded a provider or
      // model — for anything else remoteness cannot change how it renders.
      resolveRunRemoteness(this.pool, rows.rows),
    ]);
    return page(
      rows.rows.map((row) => ({
        link: taskRunOutFromList(row),
        run: runToOut({ ...row, usage: usageByRun.get(row.id) ?? null }, null, {
          executes_remotely: remoteRuns.has(row.id),
        }),
      })),
      countFromRow(total.rows[0]),
      limit,
      offset,
    );
  }

  async listTaskArtifacts(identity: SpaceUserIdentity, taskId: string, limit: number, offset: number) {
    if (!(await getVisibleTaskRow(this.pool, identity, taskId))) throw new HttpError(404, "Task not found");
    const total = await this.pool.query<{ total: string }>(
      `SELECT count(*)::text AS total
         FROM task_artifacts ta
         JOIN tasks t ON t.id = ta.task_id AND t.space_id = ta.space_id
         JOIN artifacts a ON a.id = ta.artifact_id AND a.space_id = ta.space_id
        WHERE ta.space_id = $1 AND ta.task_id = $2
          AND ${contentReadSql("artifact", "a", "$3")}`,
      [identity.spaceId, taskId, identity.userId],
    );
    const rows = await this.pool.query<TaskArtifactRow>(
      `SELECT ta.id, ta.space_id, ta.task_id, ta.artifact_id, ta.run_id AS task_artifact_run_id,
              ta.role, ta.created_at,
              a.space_id AS artifact_space_id, a.run_id AS artifact_run_id, a.proposal_id, a.artifact_type,
              a.title, a.mime_type, a.visibility, a.created_at AS artifact_created_at
         FROM task_artifacts ta
         JOIN tasks t ON t.id = ta.task_id AND t.space_id = ta.space_id
         JOIN artifacts a ON a.id = ta.artifact_id AND a.space_id = ta.space_id
       WHERE ta.space_id = $1 AND ta.task_id = $2
          AND ${contentReadSql("artifact", "a", "$3")}
        ORDER BY ta.created_at DESC, ta.id DESC
        LIMIT $4 OFFSET $5`,
      [identity.spaceId, taskId, identity.userId, limit, offset],
    );
    return page(rows.rows.map(taskArtifactOut), countFromRow(total.rows[0]), limit, offset);
  }

  async listTaskProposals(identity: SpaceUserIdentity, taskId: string, limit: number, offset: number) {
    if (!(await getVisibleTaskRow(this.pool, identity, taskId))) throw new HttpError(404, "Task not found");
    const total = await this.pool.query<{ total: string }>(
      `SELECT count(*)::text AS total
         FROM task_proposals tp
         JOIN proposals p ON p.id = tp.proposal_id AND p.space_id = tp.space_id
         LEFT JOIN runs r ON r.id = p.created_by_run_id AND r.space_id = p.space_id
        WHERE tp.space_id = $1 AND tp.task_id = $2
          AND ${contentReadSql("proposal", "p", "$3")}`,
      [identity.spaceId, taskId, identity.userId],
    );
    const rows = await this.pool.query<TaskProposalRow>(
      `SELECT tp.id, tp.space_id, tp.task_id, tp.proposal_id, tp.role, tp.created_at,
              p.space_id AS proposal_space_id, p.proposal_type, p.status, p.title,
              p.visibility, p.created_at AS proposal_created_at, p.preview, p.urgency,
              p.review_deadline, p.expires_at, p.created_by_run_id
         FROM task_proposals tp
         JOIN proposals p ON p.id = tp.proposal_id AND p.space_id = tp.space_id
         LEFT JOIN runs r ON r.id = p.created_by_run_id AND r.space_id = p.space_id
        WHERE tp.space_id = $1 AND tp.task_id = $2
          AND ${contentReadSql("proposal", "p", "$3")}
        ORDER BY tp.created_at DESC, tp.id DESC
        LIMIT $4 OFFSET $5`,
      [identity.spaceId, taskId, identity.userId, limit, offset],
    );
    return page(rows.rows.map(taskProposalOut), countFromRow(total.rows[0]), limit, offset);
  }

  async listTaskEvaluations(identity: SpaceUserIdentity, taskId: string, limit: number, offset: number) {
    if (!(await getVisibleTaskRow(this.pool, identity, taskId))) throw new HttpError(404, "Task not found");
    const total = await this.pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM task_evaluations WHERE space_id = $1 AND task_id = $2`,
      [identity.spaceId, taskId],
    );
    const rows = await this.pool.query<TaskEvaluationRow>(
      `SELECT id, space_id, task_id, run_id, run_evaluation_id, evaluator_type,
              evaluator_user_id, evaluator_agent_id, score, confidence, summary,
              checklist_json, known_issues_json, evidence_artifact_ids,
              recommendation, created_at
         FROM task_evaluations
        WHERE space_id = $1 AND task_id = $2
        ORDER BY created_at DESC, id DESC
        LIMIT $3 OFFSET $4`,
      [identity.spaceId, taskId, limit, offset],
    );
    return page(rows.rows.map(taskEvaluationOut), countFromRow(total.rows[0]), limit, offset);
  }

  async createTaskEvaluation(identity: SpaceUserIdentity, taskId: string, body: Record<string, unknown>) {
    if (!(await getVisibleTaskRow(this.pool, identity, taskId))) throw new HttpError(404, "Task not found");
    const score = bounded01(body.score, "score");
    const confidence = bounded01(body.confidence, "confidence");
    const runId = optionalString(body.run_id);
    if (runId) {
      const link = await this.pool.query<{ id: string }>(
        `SELECT id FROM task_runs WHERE space_id = $1 AND task_id = $2 AND run_id = $3`,
        [identity.spaceId, taskId, runId],
      );
      if (!link.rows[0]) throw new HttpError(422, "run_id must be linked to the task through TaskRun");
    }
    const evidenceArtifactIds = Array.isArray(body.evidence_artifact_ids)
      ? body.evidence_artifact_ids.filter((value): value is string => typeof value === "string")
      : null;
    if (evidenceArtifactIds?.length) {
      const distinct = [...new Set(evidenceArtifactIds)];
      const linked = await this.pool.query<{ total: string }>(
        `SELECT count(DISTINCT ta.artifact_id)::text AS total
           FROM task_artifacts ta
           JOIN artifacts a ON a.id = ta.artifact_id AND a.space_id = ta.space_id
          WHERE ta.space_id = $1 AND ta.task_id = $2 AND ta.artifact_id::text = ANY($3::text[])
            AND ($4::varchar IS NULL OR ta.run_id = $4)`,
        [identity.spaceId, taskId, distinct, runId],
      );
      if (countFromRow(linked.rows[0]) !== distinct.length) {
        throw new HttpError(422, "evidence_artifact_ids must be linked to the task through TaskArtifact");
      }
    }
    const now = new Date().toISOString();
    const result = await this.pool.query<TaskEvaluationRow>(
      `INSERT INTO task_evaluations (
         id, space_id, task_id, run_id, evaluator_type, evaluator_user_id,
         score, confidence, summary, checklist_json, known_issues_json,
         evidence_artifact_ids, recommendation, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::float, $8::float, $9, $10::jsonb, $11::jsonb, $12::jsonb, $13, $14)
       RETURNING id, space_id, task_id, run_id, run_evaluation_id, evaluator_type,
                 evaluator_user_id, evaluator_agent_id, score, confidence, summary,
                 checklist_json, known_issues_json, evidence_artifact_ids,
                 recommendation, created_at`,
      [
        randomUUID(),
        identity.spaceId,
        taskId,
        runId,
        requiredString(body.evaluator_type, "evaluator_type"),
        identity.userId,
        score,
        confidence,
        optionalString(body.summary),
        JSON.stringify(optionalObject(body.checklist_json)),
        JSON.stringify(Array.isArray(body.known_issues_json) ? body.known_issues_json : null),
        JSON.stringify(evidenceArtifactIds),
        optionalString(body.recommendation),
        now,
      ],
    );
    return taskEvaluationOut(result.rows[0]!);
  }

  private async getBoardFrom(db: Queryable, identity: SpaceUserIdentity, boardId: string) {
    const row = await db.query<BoardRow>(`SELECT ${BOARD_COLUMNS} FROM boards WHERE space_id = $1 AND id = $2 AND deleted_at IS NULL`, [identity.spaceId, boardId]);
    const board = row.rows[0];
    if (!board) return null;
    const columns = await db.query<BoardColumnRow>(
      `SELECT ${BOARD_COLUMN_COLUMNS} FROM board_columns WHERE space_id = $1 AND board_id = $2 AND deleted_at IS NULL ORDER BY position, id`,
      [identity.spaceId, boardId],
    );
    return { ...boardOut(board), columns: columns.rows.map(boardColumnOut) };
  }
}

async function getVisibleTaskRow(db: Queryable, identity: SpaceUserIdentity, taskId: string): Promise<TaskRow | null> {
  const result = await db.query<TaskRow>(
    `SELECT ${TASK_COLUMNS} FROM tasks t
      WHERE t.space_id = $1 AND t.id = $2 AND t.deleted_at IS NULL
        AND ${contentReadSql("task", "t", "$3")}`,
    [identity.spaceId, taskId, identity.userId],
  );
  return result.rows[0] ?? null;
}

async function assertRunnableAgent(
  db: Queryable,
  spaceId: string,
  agentId: string,
  message = "Agent not found or inactive in this Space",
): Promise<void> {
  const result = await db.query<{ id: string }>(
    `SELECT id
       FROM agents
      WHERE space_id = $1
        AND id = $2
        AND status = 'active'
        AND agent_kind <> 'system_assistant'
      LIMIT 1`,
    [spaceId, agentId],
  );
  if (!result.rows[0]) throw new HttpError(404, message);
}

function buildTaskWhere(identity: SpaceUserIdentity, filters: { boardId: string | null; projectFolderId: string | null; projectId: string | null; status: string | null; assignedToMe: boolean; q: string | null }) {
  const params: unknown[] = [identity.spaceId, identity.userId];
  const clauses = [
    "t.space_id = $1",
    "t.deleted_at IS NULL",
    contentReadSql("task", "t", "$2"),
  ];
  const add = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  if (filters.boardId) clauses.push(`t.board_id = ${add(filters.boardId)}`);
  if (filters.projectFolderId) clauses.push(`t.project_folder_id = ${add(filters.projectFolderId)}`);
  if (filters.projectId) clauses.push(`t.project_id = ${add(filters.projectId)}`);
  if (filters.status) clauses.push(`t.status = ${add(filters.status)}`);
  if (filters.assignedToMe) clauses.push("(t.assigned_user_id = $2 OR t.claimed_by_user_id = $2)");
  if (filters.q) clauses.push(`(t.title ILIKE ${add(`%${filters.q}%`)} OR t.description ILIKE $${params.length})`);
  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

function positiveIntegerOrNull(value: unknown): number | null {
  const parsed = numberValue(value);
  return parsed !== null && Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function taskStatus(value: unknown): string | null {
  const status = optionalString(value);
  if (status !== null && !TASK_STATUSES.has(status)) {
    throw new HttpError(422, "task status must be inbox, ready, in_progress, blocked, done, or cancelled");
  }
  return status;
}

function defaultNumber(value: unknown, fallback: number): number | null {
  return value === undefined ? fallback : numberValue(value);
}

function planningInstruction(task: TaskRow, referenceWorkflowVersionId: string | null): string {
  return [
    `Create a structured execution Plan for source Task '${task.title}'.`,
    task.description ? `Goal: ${task.description}` : null,
    `Task contract: ${JSON.stringify({ acceptance_criteria_json: task.acceptance_criteria_json ?? null, definition_of_done: task.definition_of_done ?? null, required_outputs_json: task.required_outputs_json ?? null, risk_level: task.risk_level, max_runs: task.max_runs, max_cost: task.max_cost, max_duration_seconds: task.max_duration_seconds })}`,
    referenceWorkflowVersionId ? `Use workflow version '${referenceWorkflowVersionId}' as an optional reference only; do not treat it as the execution source.` : null,
    "Use the task.plan.propose tool with a validated workflow_definition.v1 object. For every downstream node that consumes an upstream result, declare input_bindings from its direct depends_on nodes; do not rely on dependency order alone. Do not claim that any node has already executed.",
  ].filter(Boolean).join("\n\n");
}
