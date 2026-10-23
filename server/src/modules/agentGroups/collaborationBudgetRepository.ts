import { z } from "zod";
import { contentReadSql } from "../access/contentAccessSql.js";
import { assertProjectWriter, canWriteProject } from "../projects/access.js";
import { HttpError, type Queryable } from "../routeUtils/common.js";
import type { AgentRunGroupRecord } from "./repository.js";

// A collaboration is an explicit, task-scoped exception to ad-hoc fan-out.
// It never renews itself on a completion turn or expands its participant set.
export const CollaborationBudgetSchema = z.object({
  task_id: z.string().min(1),
  participant_agent_ids: z.array(z.string().min(1)).min(1).max(2)
    .refine((ids) => new Set(ids).size === ids.length, "Participants must be distinct"),
  max_delegations: z.number().int().min(1).max(128),
}).strict();

type Collaboration = z.infer<typeof CollaborationBudgetSchema> & { coordinator_agent_id: string };
interface Container extends AgentRunGroupRecord { collaboration?: Collaboration }
interface Request {
  parent_run_id: string;
  requesting_agent_id: string;
  target_agent_id: string;
  manager_user_id: string;
  budget_json?: Record<string, unknown> | null;
}

export async function collaborationContainer(db: Queryable, group: AgentRunGroupRecord): Promise<Container | null> {
  const pointer = group.budget_json?.container_group_id;
  const id = typeof pointer === "string" ? pointer : group.id;
  const container = (await db.query<Container>(
    `SELECT * FROM agent_run_groups WHERE space_id = $1 AND id = $2 FOR UPDATE`,
    [group.space_id, id],
  )).rows[0];
  if (!container || container.room_id !== group.room_id || container.session_id !== group.session_id
    || container.project_id !== group.project_id || container.manager_user_id !== group.manager_user_id) return null;
  const value = container.budget_json?.collaboration;
  if (!value || typeof value !== "object") return null;
  const { coordinator_agent_id, ...settings } = value as Record<string, unknown>;
  const parsed = CollaborationBudgetSchema.safeParse(settings);
  if (!parsed.success || typeof coordinator_agent_id !== "string") return null;
  return { ...container, collaboration: { ...parsed.data, coordinator_agent_id } };
}

async function taskOpen(db: Queryable, container: Container, taskId: string): Promise<boolean> {
  const result = await db.query(
    `SELECT t.id FROM tasks t WHERE t.space_id = $1 AND t.id = $2 AND t.project_id = $3
       AND t.deleted_at IS NULL AND t.status NOT IN ('done', 'cancelled', 'blocked', 'waiting_for_review')
       AND ${contentReadSql("task", "t", "$4")}
       AND EXISTS (SELECT 1 FROM projects p WHERE p.space_id = t.space_id AND p.id = t.project_id AND p.status = 'active' AND p.deleted_at IS NULL)
       AND NOT EXISTS (
         SELECT 1 FROM runs r JOIN agent_run_groups g ON g.space_id = r.space_id AND g.id = r.run_group_id
          WHERE r.space_id = $1 AND r.agent_id = $6 AND r.status IN ('cancelling', 'cancelled')
            AND (g.id = $5 OR g.budget_json->>'container_group_id' = $5)
       ) FOR SHARE OF t`,
    [container.space_id, taskId, container.project_id, container.manager_user_id, container.id, container.collaboration?.coordinator_agent_id],
  );
  return result.rows.length > 0;
}

/**
 * The container turns a collaboration may consume. Every admitted child turn
 * and the coordinator's completion turn for it each charge the container
 * once, so each declared delegation costs two turns.
 */
export function collaborationTurnCeiling(config: Pick<Collaboration, "max_delegations">): number {
  return config.max_delegations * 2;
}

/**
 * Whether the collaboration may still delegate. `turnsUsed` is the
 * container's charged turn count; a caller that has just charged the
 * container passes the post-charge count, since `container` was read before
 * that charge.
 */
export async function collaborationActive(
  db: Queryable,
  container: Container,
  turnsUsed = Number(container.budget_json?.container_turns_used ?? 0),
): Promise<boolean> {
  return Boolean(container.collaboration && !["paused", "cancelled", "failed"].includes(container.status)
    && turnsUsed <= collaborationTurnCeiling(container.collaboration)
    && container.project_id && await canWriteProject(db, container.space_id, container.project_id, container.manager_user_id)
    && await taskOpen(db, container, container.collaboration.task_id));
}

export async function collaborationLimits(db: Queryable, group: AgentRunGroupRecord, input: Request, persist = false) {
  const requested = input.budget_json?.collaboration;
  let container = group.room_id && !group.discussion_id ? await collaborationContainer(db, group) : null;
  if (requested !== undefined) {
    const parsed = CollaborationBudgetSchema.safeParse(requested);
    if (!parsed.success) throw new HttpError(422, parsed.error.message);
    if (container) {
      const { coordinator_agent_id: _, ...settings } = container.collaboration!;
      if (JSON.stringify(settings) !== JSON.stringify(parsed.data)) throw new HttpError(409, "A collaboration budget cannot be reset or widened");
    } else {
      const parent = (await db.query<{ trigger_origin: string; parent_run_id: string | null }>(
        `SELECT trigger_origin, parent_run_id FROM runs WHERE space_id = $1 AND id = $2`,
        [group.space_id, input.parent_run_id],
      )).rows[0];
      if (!group.room_id || !group.project_id || group.discussion_id || group.budget_json?.container_group_id
        || parent?.trigger_origin !== "manual" || parent.parent_run_id || input.parent_run_id !== group.root_run_id) {
        throw new HttpError(403, "Only a person's original Room turn can start a task collaboration");
      }
      await assertProjectWriter(db, group.space_id, group.project_id, input.manager_user_id);
      const participants = parsed.data.participant_agent_ids;
      const members = await db.query<{ agent_id: string }>(
        `SELECT agent_id FROM agent_run_group_members WHERE space_id = $1 AND group_id = $2 AND status = 'active' AND agent_id = ANY($3::text[])`,
        [group.space_id, group.id, participants],
      );
      if (participants.includes(input.requesting_agent_id) || members.rows.length !== participants.length) {
        throw new HttpError(422, "Collaboration participants must be other active Room members");
      }
      const used = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM run_delegations WHERE space_id = $1 AND group_id = $2 AND status <> 'policy_denied'`,
        [group.space_id, group.id],
      );
      if (Number(used.rows[0]?.count) > 0) throw new HttpError(409, "Declare collaboration bounds before the first delegation");
      container = { ...group, collaboration: { ...parsed.data, coordinator_agent_id: input.requesting_agent_id } };
      if (!await taskOpen(db, container, parsed.data.task_id)) throw new HttpError(404, "An open Task in this Room's Project is required");
    }
  }
  if (!container?.collaboration) return null;
  const config = container.collaboration;
  const results = (await db.query<{ status: string; run_status: string | null }>(
    `SELECT d.status, r.status AS run_status
       FROM run_delegations d JOIN agent_run_groups g ON g.space_id = d.space_id AND g.id = d.group_id
       LEFT JOIN runs r ON r.space_id = d.space_id AND r.id = d.child_run_id
       WHERE d.space_id = $1 AND (g.id = $2 OR g.budget_json->>'container_group_id' = $2)
         AND d.status <> 'policy_denied' ORDER BY d.created_at DESC, d.id DESC`,
    [group.space_id, container.id],
  )).rows;
  // Failed/cancelled attempts still cost budget; policy refusals do not.
  // The stop is for children that produced nothing. A degraded child replied
  // and is recorded as a failed delegation only because a governed call of
  // its own was refused; the coordinator has its result to judge.
  const repeatedFailure = results.length >= 3
    && results.slice(0, 3).every((r) => ["failed", "cancelled"].includes(r.status) && r.run_status !== "degraded");
  const permitted = input.requesting_agent_id === config.coordinator_agent_id
    && config.participant_agent_ids.includes(input.target_agent_id)
    && !repeatedFailure && await collaborationActive(db, container);
  if (persist && permitted) {
    await db.query(
      `UPDATE agent_run_groups SET budget_json = COALESCE(budget_json, '{}'::jsonb) || jsonb_build_object('collaboration', $3::jsonb) WHERE space_id = $1 AND id = $2`,
      [group.space_id, container.id, JSON.stringify(config)],
    );
  }
  return { fanout_count: results.length + 1, max_fanout: permitted ? config.max_delegations : 0 };
}
