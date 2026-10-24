import type { Queryable } from "../routeUtils/common.js";
import { PgSessionRepository } from "../sessions/repository.js";

export function defaultRoomDelegationBudget(delegatableAgents: number) {
  const soft = 5 * Math.max(1, delegatableAgents);
  return { max_depth: 1, max_fanout: soft, soft_max_fanout: soft, hard_max_fanout: soft * 2 };
}

export function roomBudgetLimits(budget: Record<string, unknown> | null) {
  const value = (key: string, fallback: number) => {
    const n = budget?.[key];
    return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : fallback;
  };
  // An explicit max_fanout is a hard bound, unless a soft/hard pair was declared.
  const soft = value("soft_max_fanout", value("max_fanout", 5));
  const hard = budget?.max_fanout === 0 ? 0 : value("hard_max_fanout", value("max_fanout", 5));
  return { soft, hard, softTurns: soft * 2, hardTurns: hard * 2 };
}

/** The row lock serializes admission, charging and the once-only visible notice. */
export async function roomBudgetContainer(db: Queryable, spaceId: string, groupId: string) {
  return (await db.query<{ id: string; budget_json: Record<string, unknown>; session_id: string | null }>(
    `SELECT container.id, container.budget_json, container.session_id
       FROM agent_run_groups grp
       JOIN agent_run_groups container ON container.space_id=grp.space_id
        AND container.id=COALESCE(grp.budget_json->>'container_group_id',grp.id)
        AND container.room_id=grp.room_id AND container.session_id IS NOT DISTINCT FROM grp.session_id
        AND container.project_id IS NOT DISTINCT FROM grp.project_id AND container.manager_user_id=grp.manager_user_id
      WHERE grp.space_id=$1 AND grp.id=$2 FOR UPDATE OF container`, [spaceId, groupId],
  )).rows[0];
}

export async function warnRoomSoftBudget(db: Queryable, spaceId: string, groupId: string): Promise<void> {
  const container = await roomBudgetContainer(db, spaceId, groupId);
  if (!container || container.budget_json.collaboration || !container.session_id || container.budget_json.soft_budget_notified) return;
  const limits = roomBudgetLimits(container.budget_json);
  const count = await countContainerDelegations(db, spaceId, container.id);
  if (count <= limits.soft && Number(container.budget_json.container_turns_used ?? 0) <= limits.softTurns) return;
  const notice = await new PgSessionRepository(db).addRoomConversationNotice(spaceId, container.session_id, {
    content: `Room delegation has exceeded its soft budget (${limits.soft} delegations / ${limits.softTurns} Agent turns). Work continues within the hard limit (${limits.hard} delegations / ${limits.hardTurns} turns).`,
    metadata: { execution_event: "delegation_soft_budget_exceeded", execution_event_key: `${container.id}:soft_budget`,
      execution_details: { container_group_id: container.id, soft_limit: limits.soft, hard_limit: limits.hard } },
  });
  if (notice) await db.query(`UPDATE agent_run_groups SET budget_json=budget_json || '{"soft_budget_notified":true}'::jsonb
    WHERE space_id=$1 AND id=$2`, [spaceId, container.id]);
}

export async function countContainerDelegations(db: Queryable, spaceId: string, containerId: string): Promise<number> {
  return Number((await db.query<{ count: string }>(`SELECT count(*)::text AS count FROM run_delegations d
    JOIN agent_run_groups g ON g.space_id=d.space_id AND g.id=d.group_id
    WHERE d.space_id=$1 AND (g.id=$2 OR g.budget_json->>'container_group_id'=$2) AND d.status<>'policy_denied'`,
  [spaceId, containerId])).rows[0]?.count ?? 0);
}
