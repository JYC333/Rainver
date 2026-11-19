import { z } from "zod";
import { contentReadSql } from "../access/contentAccessSql.js";
import { assertProjectWriter, canWriteProject } from "../projects/access.js";
import { HttpError, type Queryable } from "../routeUtils/common.js";
import type { AgentRunGroupRecord } from "./repository.js";
import {
  consecutiveFailures, containerResults, countContainerDelegations, personAuthorizedRoot, type ContainerResult,
} from "../rooms/delegationBudget.js";
export { consecutiveFailures } from "../rooms/delegationBudget.js";
import { AgentGroupRefusal } from "./hostDispatchErrors.js";
import { postWorkReminder } from "./collaborationReminder.js";

// A collaboration binds the work a person's Room turn authorized to one open
// Task and fixed participants. It has no total: handoffs and charged turns
// are counted and reminded at protocol thresholds, never stopped on a count.
// An active Task keeps its declaration; a closed Task may be followed by a new one.
const participants = z.array(z.string().min(1)).min(1)
  .refine((ids) => new Set(ids).size === ids.length, "Participants must be distinct");

/** What an Agent declares through `agent.delegate`. A mode, cap or any other key is refused. */
export const CollaborationBudgetSchema = z.object({
  task_id: z.string().min(1),
  participant_agent_ids: participants,
}).strict();

/** The one stored shape (migration 0024 converted every earlier record to it). */
const StoredCollaborationSchema = z.object({
  task_id: z.string().min(1),
  participant_agent_ids: participants,
  coordinator_agent_id: z.string().min(1),
  delegations_offset: z.number().int().min(0),
  turns_offset: z.number().int().min(0),
  declared_at: z.string().datetime({ offset: true }),
  reminder_notified_through: z.number().int().min(0),
}).strict();

export type Collaboration = z.infer<typeof StoredCollaborationSchema>;
export interface Container extends AgentRunGroupRecord {
  collaboration?: Collaboration;
  /** Stored collaboration JSON exists but does not parse: fail closed, never fall back to ad hoc. */
  collaboration_invalid?: true;
}
interface Request {
  parent_run_id: string;
  requesting_agent_id: string;
  target_agent_id: string;
  manager_user_id: string;
  budget_json?: Record<string, unknown> | null;
}

export function parseStoredCollaboration(value: unknown): Collaboration | null {
  const parsed = StoredCollaborationSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export async function collaborationContainer(db: Queryable, group: AgentRunGroupRecord, includeUnconfigured = false): Promise<Container | null> {
  const pointer = group.budget_json?.container_group_id;
  const id = typeof pointer === "string" ? pointer : group.id;
  const container = (await db.query<Container>(
    `SELECT * FROM agent_run_groups WHERE space_id = $1 AND id = $2 FOR UPDATE`,
    [group.space_id, id],
  )).rows[0];
  if (!container || container.room_id !== group.room_id || container.session_id !== group.session_id
    || container.project_id !== group.project_id || container.manager_user_id !== group.manager_user_id) return null;
  // Only an absent key is "not configured"; a present key of any other
  // value (null included) that does not parse closes delegation.
  if (!hasStoredCollaboration(container.budget_json)) return includeUnconfigured ? container : null;
  const collaboration = parseStoredCollaboration(container.budget_json!.collaboration);
  return collaboration ? { ...container, collaboration } : { ...container, collaboration_invalid: true };
}

export function hasStoredCollaboration(budget: Record<string, unknown> | null | undefined): boolean {
  return Boolean(budget && typeof budget === "object" && Object.hasOwn(budget, "collaboration"));
}

export function collaborationInvalidRefusal(): AgentGroupRefusal {
  return new AgentGroupRefusal(409, "This Room's task collaboration record is invalid; delegation is closed until a person repairs it",
    { code: "collaboration_budget_invalid" });
}

/**
 * The collaboration's Task as `userId` may see it: same Project as the
 * container, readable Task content, active Project. Anything else is
 * `undefined` — no title, no status, no admission. `open` excludes closed or
 * held statuses; `coordinator_cancelled` is a coordinator Run of this
 * container cancelled since the current declaration (a terminal stop for
 * that declaration; an earlier declaration's cancellation does not block a
 * later one).
 */
export async function collaborationTask(db: Queryable, container: Container, taskId: string, userId = container.manager_user_id, lock = true) {
  return (await db.query<{ title: string; status: string; open: boolean; coordinator_cancelled: boolean }>(
    `SELECT t.title, t.status, t.status NOT IN ('done', 'cancelled', 'blocked', 'waiting_for_review') AS open,
       EXISTS (
         SELECT 1 FROM runs r JOIN agent_run_groups g ON g.space_id = r.space_id AND g.id = r.run_group_id
          WHERE r.space_id = $1 AND r.agent_id = $6 AND r.status IN ('cancelling', 'cancelled')
            AND (g.id = $5 OR g.budget_json->>'container_group_id' = $5)
            AND r.updated_at >= $7::timestamptz
       ) AS coordinator_cancelled
       FROM tasks t WHERE t.space_id = $1 AND t.id = $2 AND t.project_id = $3 AND t.deleted_at IS NULL
       AND ${contentReadSql("task", "t", "$4")}
       AND EXISTS (SELECT 1 FROM projects p WHERE p.space_id = t.space_id AND p.id = t.project_id AND p.status = 'active' AND p.deleted_at IS NULL)
       ${lock ? "FOR SHARE OF t" : ""}`,
    [container.space_id, taskId, container.project_id, userId, container.id,
      container.collaboration?.coordinator_agent_id ?? null, container.collaboration?.declared_at ?? null],
  )).rows[0];
}

/** An open Task the manager can still read, in an active Project, its declaration not cancelled. */
export async function taskOpen(db: Queryable, container: Container, taskId: string): Promise<boolean> {
  const task = await collaborationTask(db, container, taskId);
  return Boolean(task?.open && !task.coordinator_cancelled);
}

export type CollaborationStopReason = "paused" | "stopped" | "repeated_failures"
  | "project_access_lost" | "task_unavailable" | "task_closed" | "coordinator_cancelled";

/**
 * Why the collaboration admits no further delegation, or null while it does.
 * Admission, continuation and the human read view share this one projection.
 * No reason is a count: totals are reminded, never a stop. With `results`,
 * three children in a row without a result also stop it.
 */
export async function collaborationStopReason(
  db: Queryable,
  container: Container,
  results: ReadonlyArray<{ status: string; run_status: string | null }> | null = null,
  lock = true,
): Promise<CollaborationStopReason | null> {
  const config = container.collaboration;
  if (!config) return "stopped";
  if (container.status === "paused") return "paused";
  if (["cancelled", "failed"].includes(container.status)) return "stopped";
  if (results && consecutiveFailures(results) >= 3) return "repeated_failures";
  if (!container.project_id || !await canWriteProject(db, container.space_id, container.project_id, container.manager_user_id)) return "project_access_lost";
  const task = await collaborationTask(db, container, config.task_id, container.manager_user_id, lock);
  if (!task) return "task_unavailable";
  if (!task.open) return "task_closed";
  if (task.coordinator_cancelled) return "coordinator_cancelled";
  return null;
}

/**
 * A completion turn's standing, judged on the same facts as admission, the
 * declaration's outcomes included. Null keeps the person's original cause and
 * permits handing off again; any stop ends both (the report still runs,
 * unattributed, with no fan-out).
 */
export async function collaborationContinuation(db: Queryable, container: Container): Promise<CollaborationStopReason | null> {
  return collaborationStopReason(db, container, await collaborationResults(db, container));
}

export type CollaborationResult = ContainerResult;

/** This declaration's admitted delegations, newest first. */
export function collaborationResults(db: Queryable, container: Container) {
  return containerResults(db, container.space_id, container.id, container.collaboration?.delegations_offset ?? 0);
}

export async function collaborationLimits(db: Queryable, group: AgentRunGroupRecord, input: Request, persist = false) {
  const requested = input.budget_json?.collaboration;
  let container = group.room_id && !group.discussion_id ? await collaborationContainer(db, group, true) : null;
  if (container?.collaboration_invalid) throw collaborationInvalidRefusal();
  let newDeclaration = false;
  const previous = container?.collaboration;
  if (requested !== undefined) {
    const parsed = CollaborationBudgetSchema.safeParse(requested);
    if (!parsed.success) throw new HttpError(422, parsed.error.message);
    const same = Boolean(previous && previous.task_id === parsed.data.task_id
      && JSON.stringify([...previous.participant_agent_ids].sort()) === JSON.stringify([...parsed.data.participant_agent_ids].sort()));
    if (previous && !same) {
      const closed = (await db.query<{ status: string }>(`SELECT status FROM tasks t
        WHERE t.space_id=$1 AND t.id=$2 AND t.project_id=$3 AND t.deleted_at IS NULL
          AND ${contentReadSql("task", "t", "$4")} FOR SHARE`,
      [group.space_id, previous.task_id, group.project_id, input.manager_user_id])).rows[0];
      if (!closed || !["done", "cancelled"].includes(closed.status)) {
        throw new HttpError(409, "A task collaboration cannot be changed while its Task is open");
      }
    }
    if (!same) {
      const root = container ? await personAuthorizedRoot(db, group.space_id, container.root_run_id) : null;
      if (!container || !group.project_id || !root
        || input.requesting_agent_id !== (previous?.coordinator_agent_id ?? root.agent_id)) {
        throw new HttpError(403, "Only a person's original Room turn or its coordinator completion can start a task collaboration");
      }
      await assertProjectWriter(db, group.space_id, group.project_id, input.manager_user_id);
      const declared = parsed.data.participant_agent_ids;
      const members = await db.query<{ agent_id: string }>(
        `SELECT agent_id FROM agent_run_group_members WHERE space_id=$1 AND group_id=$2 AND status='active' AND agent_id=ANY($3::text[])`,
        [group.space_id, group.id, declared],
      );
      if (declared.includes(input.requesting_agent_id) || members.rows.length !== declared.length) {
        throw new HttpError(422, "Collaboration participants must be other active Room members");
      }
      const used = await countContainerDelegations(db, group.space_id, container.id);
      const now = (await db.query<{ now: string }>(`SELECT to_json(now())#>>'{}' AS now`)).rows[0]!.now;
      container = { ...container, collaboration: {
        task_id: parsed.data.task_id, participant_agent_ids: declared, coordinator_agent_id: input.requesting_agent_id,
        delegations_offset: used, turns_offset: Number(container.budget_json?.container_turns_used ?? 0), declared_at: now,
        reminder_notified_through: 0,
      } };
      if (!await taskOpen(db, container, parsed.data.task_id)) throw new HttpError(404, "An open Task in this Room's Project is required");
      newDeclaration = true;
    }
  }
  if (!container?.collaboration) return null;
  const config = container.collaboration;
  const results = await collaborationResults(db, container);
  const permitted = input.requesting_agent_id === config.coordinator_agent_id
    && config.participant_agent_ids.includes(input.target_agent_id)
    && await collaborationStopReason(db, container, results) === null;
  const delegations = results.length + 1;
  if (persist && permitted) {
    const history = container.budget_json?.collaboration_history;
    const epoch = (Array.isArray(history) ? history.length : 0) + (newDeclaration && previous ? 1 : 0);
    const through = await postWorkReminder(db, container, {
      kind: "collaboration", key: `${container.id}:collaboration:${epoch}`, count: delegations,
      notifiedThrough: config.reminder_notified_through, results, since: config.declared_at,
      turnsOffset: config.turns_offset, taskId: config.task_id,
    });
    const next: Collaboration = through === null ? config : { ...config, reminder_notified_through: through };
    await db.query(
      `UPDATE agent_run_groups SET budget_json = COALESCE(budget_json, '{}'::jsonb) || jsonb_build_object('collaboration', $3::jsonb)
        || CASE WHEN $4::boolean AND budget_json->'collaboration' IS NOT NULL THEN jsonb_build_object(
          'collaboration_history', COALESCE(budget_json->'collaboration_history','[]'::jsonb) || jsonb_build_array(budget_json->'collaboration')) ELSE '{}'::jsonb END
       WHERE space_id = $1 AND id = $2`,
      [group.space_id, container.id, JSON.stringify(next), newDeclaration],
    );
  }
  return { permitted, delegations, participants: config.participant_agent_ids.length, task_id: config.task_id };
}
