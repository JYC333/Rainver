import {
  workLoopStageLabel,
  WORK_LOOP_STAGE_KEYS,
  type ProjectBoardCard,
  type ProjectBoardResponse,
  type TaskWorkViewResponse,
  type WorkLoopStageKey,
} from "@rainver/protocol";
import { dateIso, HttpError, type Queryable, type SpaceUserIdentity } from "../routeUtils/common.js";
import { contentReadSql } from "../access/contentAccessSql.js";
import { assertProjectReadable, canWriteProject } from "../projects/access.js";
import { completionFrom, taskCompletionState } from "./completion.js";
import { declaredRequiredOutputs } from "./settlement.js";
import { PERSON_ONLY_STATUSES, responsibleActorOf, responsibleAgentSql, responsibleUserSql } from "./responsibility.js";
import { DEFAULT_COLUMNS } from "../tasks/taskRepositoryRows.js";

/**
 * The Board and the Task work view.
 *
 * Both answer questions the client cannot answer from the domain rows alone —
 * which stage a Task is in, who is on the hook, why it cannot close — and both
 * are read models over facts that already exist. Reconstructing any of it in
 * the browser would put a second copy of the rules where nothing can test it
 * against the write path.
 */

interface BoardCardRow {
  id: string;
  title: string;
  status: string;
  priority: string;
  risk_level: string;
  due_at: string | null;
  updated_at: string;
  blocked_reason: string | null;
  required_outputs_json: unknown;
  loop_stage: WorkLoopStageKey | null;
  responsible_user_id: string | null;
  responsible_agent_id: string | null;
  responsible_user_name: string | null;
  responsible_agent_name: string | null;
  active_run_count: string | number;
  latest_run_status: string | null;
  evaluation_recommendation: string | null;
  present_outputs: string[] | null;
}

/** Statuses whose cards the Board does not show. */
export const ARCHIVED_CARD_STATUSES = ["cancelled"];

/**
 * Where a card is drawn when its status is not itself a column.
 *
 * `blocked` is an overlay, not a lane — but it is still a status, so without
 * this a held-up Task would be fetched, counted, and then drawn nowhere:
 * invisible and unreachable by drag, which is the opposite of what a Board is
 * for. It is drawn where the work sits, wearing its red edge.
 */
export const COLUMN_FOR_STATUS: Record<string, string> = { blocked: "in_progress" };

const CARD_SELECT = `
  SELECT t.id, t.title, t.status, t.priority, t.risk_level, t.due_at, t.updated_at,
         t.blocked_reason, t.required_outputs_json,
         ls.current_stage_key AS loop_stage,
         ${responsibleUserSql("t", "p")} AS responsible_user_id,
         ${responsibleAgentSql("t")} AS responsible_agent_id,
         ru.display_name AS responsible_user_name,
         ra.name AS responsible_agent_name,
         COALESCE(active.total, 0) AS active_run_count,
         latest.status AS latest_run_status,
         ev.recommendation AS evaluation_recommendation,
         COALESCE(outputs.present, '{}') AS present_outputs
    FROM tasks t
    JOIN projects p ON p.id = t.project_id AND p.space_id = t.space_id
    LEFT JOIN task_loop_states ls ON ls.task_id = t.id AND ls.space_id = t.space_id
    LEFT JOIN users ru ON ru.id = ${responsibleUserSql("t", "p")}
    LEFT JOIN agents ra ON ra.id = ${responsibleAgentSql("t")}
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS total
        FROM task_runs tr
        JOIN runs r ON r.id = tr.run_id AND r.space_id = tr.space_id
       WHERE tr.task_id = t.id AND tr.space_id = t.space_id
         AND r.status NOT IN ('succeeded', 'failed', 'degraded', 'cancelled', 'orphaned', 'waiting_for_review')
    ) active ON true
    LEFT JOIN LATERAL (
      SELECT r.id, r.status
        FROM task_runs tr
        JOIN runs r ON r.id = tr.run_id AND r.space_id = tr.space_id
       WHERE tr.task_id = t.id AND tr.space_id = t.space_id
         AND tr.role NOT IN ('planning', 'review')
       ORDER BY r.created_at DESC, r.id DESC
       LIMIT 1
    ) latest ON true
    LEFT JOIN LATERAL (
      SELECT e.recommendation
        FROM task_evaluations e
       WHERE e.space_id = t.space_id AND e.task_id = t.id AND e.run_id = latest.id
       ORDER BY e.created_at DESC, e.id DESC
       LIMIT 1
    ) ev ON true
    LEFT JOIN LATERAL (
      SELECT array_agg(DISTINCT lower(a.artifact_type)) AS present
        FROM task_artifacts ta
        JOIN artifacts a ON a.id = ta.artifact_id AND a.space_id = ta.space_id
       WHERE ta.space_id = t.space_id AND ta.task_id = t.id AND ta.role = 'output'
    ) outputs ON true
`;

export async function getProjectBoard(
  db: Queryable,
  identity: SpaceUserIdentity,
  projectId: string,
): Promise<ProjectBoardResponse> {
  await assertProjectReadable(db, identity.spaceId, projectId, identity.userId);
  const project = await db.query<{ id: string; name: string }>(
    `SELECT id, name FROM projects WHERE id = $1 AND space_id = $2`,
    [projectId, identity.spaceId],
  );
  const projectRow = project.rows[0];
  if (!projectRow) throw new HttpError(404, "Project not found");

  const cardRows = await db.query<BoardCardRow>(
    `${CARD_SELECT}
      WHERE t.space_id = $1 AND t.project_id = $2 AND t.deleted_at IS NULL
        AND t.status <> ALL ($4::text[])
        AND ${contentReadSql("task", "t", "$3")}
      ORDER BY t.updated_at DESC, t.id DESC`,
    [identity.spaceId, projectId, identity.userId, ARCHIVED_CARD_STATUSES],
  );

  // Attached outputs come back with the card, so the completion answer costs
  // no extra round trip. Asking per card turned one Board load into one query
  // per Task that declared anything.
  const cards: ProjectBoardCard[] = cardRows.rows.map((row) => {
    const declared = declaredRequiredOutputs(row.required_outputs_json);
    const present = new Set(row.present_outputs ?? []);
    const missingOutputs = declared.filter((token) => !present.has(token));
    return ({
      id: row.id,
      title: row.title,
      status: row.status,
      column_key: COLUMN_FOR_STATUS[row.status] ?? row.status,
      priority: row.priority,
      risk_level: row.risk_level,
      due_at: dateIso(row.due_at),
      updated_at: dateIso(row.updated_at)!,
      loop_stage: row.loop_stage,
      loop_stage_label: row.loop_stage
        ? workLoopStageLabel(row.loop_stage)
        : null,
      responsible: responsibleActorOf(row),
      active_run_count: Number(row.active_run_count) || 0,
      latest_run_status: row.latest_run_status,
      evaluation_recommendation: row.evaluation_recommendation,
      blocked_reason: row.blocked_reason,
      completion: completionFrom(
        row.evaluation_recommendation,
        row.evaluation_recommendation !== null,
        missingOutputs,
      ),
    });
  });

  const columns = await boardColumns(db, identity, projectId, cards);
  return {
    project: { id: projectRow.id, name: projectRow.name },
    columns,
    cards,
    viewer_user_id: identity.userId,
    viewer_can_write: await canWriteProject(db, identity.spaceId, projectId, identity.userId),
    filters: {
      all: cards.length,
      mine: cards.filter((card) => card.responsible.kind === "user" && card.responsible.id === identity.userId).length,
      agent_held: cards.filter((card) => card.responsible.kind === "agent").length,
      // The statuses the responsibility chain hands back, and the same set the
      // Board's own filter lists — a badge that disagreed with the list it
      // opens sends someone to look for a card that is not there. The
      // attention adapter additionally interrupts on *overdue*, which is a
      // date rather than a status and deliberately not badged here.
      needs_me: cards.filter((card) =>
        (PERSON_ONLY_STATUSES as readonly string[]).includes(card.status)
        && card.responsible.kind === "user"
        && card.responsible.id === identity.userId).length,
    },
  };
}

/**
 * A Project's own Board columns when it has one, the defaults otherwise.
 *
 * A Project with no Board row is the ordinary case today — Boards are created
 * explicitly — and showing nothing would make the Board look broken rather than
 * empty.
 */
async function boardColumns(
  db: Queryable,
  identity: SpaceUserIdentity,
  projectId: string,
  cards: readonly ProjectBoardCard[],
): Promise<ProjectBoardResponse["columns"]> {
  // One Board's columns. Nothing stops a Project having two Board rows, and
  // concatenating them produced duplicate lanes with every card drawn twice.
  const configured = await db.query<{ status_key: string; name: string; wip_limit: number | null }>(
    `SELECT c.status_key, c.name, c.wip_limit
       FROM board_columns c
      WHERE c.space_id = $1 AND c.deleted_at IS NULL
        AND c.board_id = (
          SELECT b.id FROM boards b
           WHERE b.space_id = $1 AND b.project_id = $2
             AND b.deleted_at IS NULL AND b.status = 'active'
           ORDER BY b.sort_order NULLS LAST, b.created_at ASC, b.id ASC
           LIMIT 1
        )
      ORDER BY c.position ASC, c.id ASC`,
    [identity.spaceId, projectId],
  );
  const source = configured.rows.length > 0
    ? configured.rows.map((row) => ({ status_key: row.status_key, label: row.name, wip_limit: row.wip_limit }))
    : DEFAULT_COLUMNS.map((column) => ({ status_key: column.status_key, label: column.name, wip_limit: null }));
  return source.map((column) => ({
    ...column,
    count: cards.filter((card) => card.column_key === column.status_key).length,
  }));
}

const WORK_VIEW_EVENT_LIMIT = 50;
const WORK_VIEW_RUN_LIMIT = 5;

export async function getTaskWorkView(
  db: Queryable,
  identity: SpaceUserIdentity,
  taskId: string,
): Promise<TaskWorkViewResponse> {
  const taskResult = await db.query<{
    id: string;
    project_id: string | null;
    title: string;
    status: string;
    definition_of_done: string | null;
    required_outputs_json: unknown;
    completed_at: string | null;
    responsible_user_id: string | null;
    responsible_agent_id: string | null;
    responsible_user_name: string | null;
    responsible_agent_name: string | null;
  }>(
    `SELECT t.id, t.project_id, t.title, t.status, t.definition_of_done,
            t.required_outputs_json, t.completed_at,
            ${responsibleUserSql("t", "p")} AS responsible_user_id,
            ${responsibleAgentSql("t")} AS responsible_agent_id,
            ru.display_name AS responsible_user_name,
            ra.name AS responsible_agent_name
       FROM tasks t
       LEFT JOIN projects p ON p.id = t.project_id AND p.space_id = t.space_id
       LEFT JOIN users ru ON ru.id = ${responsibleUserSql("t", "p")}
       LEFT JOIN agents ra ON ra.id = ${responsibleAgentSql("t")}
      WHERE t.space_id = $1 AND t.id = $2 AND t.deleted_at IS NULL
        AND ${contentReadSql("task", "t", "$3")}`,
    [identity.spaceId, taskId, identity.userId],
  );
  const task = taskResult.rows[0];
  if (!task) throw new HttpError(404, "Task not found");

  const declared = declaredRequiredOutputs(task.required_outputs_json);

  const [loop, evaluation, events, runs, presentOutputs, completion, links, visited] = await Promise.all([
    db.query<{ current_stage_key: WorkLoopStageKey; stage_entered_at: string; revision: number }>(
      `SELECT current_stage_key, stage_entered_at, revision
         FROM task_loop_states WHERE space_id = $1 AND task_id = $2`,
      [identity.spaceId, taskId],
    ),
    // The evaluation of the latest **execution** Run — the same one completion
    // is judged against. Showing the Task's newest evaluation instead let a
    // planning Run's verdict render as "accept" directly above "no evaluation
    // has accepted the result".
    db.query<{ id: string; recommendation: string | null; summary: string | null; created_at: string }>(
      `SELECT e.id, e.recommendation, e.summary, e.created_at
         FROM task_evaluations e
        WHERE e.space_id = $1 AND e.task_id = $2
          AND e.run_id = (
            SELECT tr.run_id
              FROM task_runs tr
              JOIN runs r ON r.id = tr.run_id AND r.space_id = tr.space_id
             WHERE tr.task_id = $2 AND tr.space_id = $1
               AND tr.role NOT IN ('planning', 'review')
             ORDER BY r.created_at DESC, r.id DESC
             LIMIT 1
          )
        ORDER BY e.created_at DESC, e.id DESC LIMIT 1`,
      [identity.spaceId, taskId],
    ),
    db.query<{
      id: string; event_kind: string; occurred_at: string; data_json: Record<string, unknown>;
      actor_user_id: string | null; actor_agent_id: string | null;
      actor_user_name: string | null; actor_agent_name: string | null; actor_service: string | null;
    }>(
      `SELECT e.id, e.event_kind, e.occurred_at, e.data_json,
              a.user_id AS actor_user_id, a.agent_id AS actor_agent_id,
              au.display_name AS actor_user_name, ag.name AS actor_agent_name,
              a.service_name AS actor_service
         FROM project_work_events e
         JOIN actors a ON a.id = e.actor_id
         LEFT JOIN users au ON au.id = a.user_id
         LEFT JOIN agents ag ON ag.id = a.agent_id
        WHERE e.space_id = $1 AND e.subject_type = 'task' AND e.subject_id = $2
        ORDER BY e.occurred_at DESC, e.id DESC
        LIMIT ${WORK_VIEW_EVENT_LIMIT}`,
      [identity.spaceId, taskId],
    ),
    db.query<{ id: string; status: string; role: string; created_at: string }>(
      `SELECT r.id, r.status, tr.role, r.created_at
         FROM task_runs tr
         JOIN runs r ON r.id = tr.run_id AND r.space_id = tr.space_id
        WHERE tr.space_id = $1 AND tr.task_id = $2
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT ${WORK_VIEW_RUN_LIMIT}`,
      [identity.spaceId, taskId],
    ),
    db.query<{ artifact_type: string }>(
      `SELECT DISTINCT lower(a.artifact_type) AS artifact_type
         FROM task_artifacts ta
         JOIN artifacts a ON a.id = ta.artifact_id AND a.space_id = ta.space_id
        WHERE ta.space_id = $1 AND ta.task_id = $2 AND ta.role = 'output'`,
      [identity.spaceId, taskId],
    ),
    // The same rule the Board card and the manual-close gate use. Asking a
    // different question here is what let the tab say a Task was ready while
    // the write path refused to close it.
    taskCompletionState(db, identity.spaceId, taskId, task.required_outputs_json),
    db.query<{ entity_type: string; entity_id: string; role: string }>(
      `SELECT entity_type, entity_id, role
         FROM task_entity_links
        WHERE space_id = $1 AND task_id = $2
        ORDER BY created_at ASC, id ASC`,
      [identity.spaceId, taskId],
    ),
    // Which stages this Task has actually been in, over the whole stream
    // rather than the capped event list above: a Task with more history than
    // the cap would otherwise read as never having framed or planned, and the
    // rail would call that "not started" rather than "done".
    db.query<{ stage_key: string }>(
      `SELECT DISTINCT e.data_json->>'to_stage' AS stage_key
         FROM project_work_events e
        WHERE e.space_id = $1 AND e.subject_type = 'task' AND e.subject_id = $2
          AND e.event_kind = 'task.stage_changed'
          AND e.data_json->>'to_stage' IS NOT NULL`,
      [identity.spaceId, taskId],
    ),
  ]);

  const visitedStages = WORK_LOOP_STAGE_KEYS.filter((key) =>
    visited.rows.some((row) => row.stage_key === key));

  const evaluationRow = evaluation.rows[0];
  const loopRow = loop.rows[0];
  return {
    task: {
      id: task.id,
      project_id: task.project_id,
      title: task.title,
      status: task.status,
      definition_of_done: task.definition_of_done,
      required_outputs: declared,
      completed_at: dateIso(task.completed_at),
    },
    loop: loopRow
      ? {
        current_stage_key: loopRow.current_stage_key,
        stage_entered_at: dateIso(loopRow.stage_entered_at)!,
        revision: Number(loopRow.revision),
      }
      : null,
    visited_stage_keys: visitedStages,
    stages: WORK_LOOP_STAGE_KEYS.map((key) => ({ key, label: workLoopStageLabel(key) })),
    responsible: responsibleActorOf(task),
    completion,
    evaluation: evaluationRow
      ? {
        id: evaluationRow.id,
        recommendation: evaluationRow.recommendation,
        summary: evaluationRow.summary,
        created_at: dateIso(evaluationRow.created_at)!,
      }
      : null,
    present_outputs: presentOutputs.rows.map((row) => row.artifact_type),
    links: links.rows.map((row) => ({
      entity_type: row.entity_type,
      entity_id: row.entity_id,
      role: row.role,
    })),
    events: events.rows.map((row) => ({
      id: row.id,
      event_kind: row.event_kind,
      occurred_at: dateIso(row.occurred_at)!,
      actor: row.actor_user_id
        ? { kind: "user" as const, id: row.actor_user_id, display_name: row.actor_user_name }
        : row.actor_agent_id
          ? { kind: "agent" as const, id: row.actor_agent_id, display_name: row.actor_agent_name }
          : { kind: null, id: null, display_name: row.actor_service },
      data_json: row.data_json ?? {},
    })),
    runs: runs.rows.map((row) => ({
      id: row.id,
      status: row.status,
      role: row.role,
      created_at: dateIso(row.created_at)!,
    })),
  };
}
