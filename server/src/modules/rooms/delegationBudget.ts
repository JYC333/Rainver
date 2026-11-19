import type { Queryable } from "../routeUtils/common.js";
import { PgSessionRepository } from "../sessions/repository.js";
import { postWorkReminder } from "../agentGroups/collaborationReminder.js";

const DEFAULT_DELEGATIONS_PER_AGENT = 10;

/**
 * A Room group's stored delegation bounds. In a person-authorized container
 * (one rooted in a person's own Room turn) `hard_max_fanout` bounds only one
 * turn's fan-out (its children outstanding at once); there is no total. For
 * every other container and for discussions, soft/hard are also cumulative
 * delegation bounds and twice them the Agent-turn bounds.
 */
export function defaultRoomDelegationBudget(delegatableAgents: number) {
  const soft = DEFAULT_DELEGATIONS_PER_AGENT * Math.max(1, delegatableAgents);
  return { max_depth: 1, max_fanout: soft, soft_max_fanout: soft, hard_max_fanout: soft * 2 };
}

export function roomBudgetLimits(budget: Record<string, unknown> | null) {
  const value = (key: string, fallback: number) => {
    const n = budget?.[key];
    return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : fallback;
  };
  // An explicit max_fanout is a hard bound, unless a soft/hard pair was declared.
  const soft = value("soft_max_fanout", value("max_fanout", DEFAULT_DELEGATIONS_PER_AGENT));
  const hard = budget?.max_fanout === 0 ? 0 : value("hard_max_fanout", value("max_fanout", DEFAULT_DELEGATIONS_PER_AGENT));
  return { soft, hard, softTurns: soft * 2, hardTurns: hard * 2 };
}

/** Only the bound fields of a stored budget, for a completion turn's own group. */
export function roomBudgetBounds(budget: Record<string, unknown> | null | undefined): Record<string, number> {
  const bounds: Record<string, number> = {};
  for (const key of ["max_depth", "max_fanout", "soft_max_fanout", "hard_max_fanout"]) {
    const n = budget?.[key];
    if (typeof n === "number" && Number.isInteger(n) && n >= 0) bounds[key] = n;
  }
  return bounds;
}

/**
 * A container's root is a person's own Room turn (manual, not a child): the
 * work it starts is counted and reminded, never stopped on a total.
 * Continuation, automation and scheduled roots are never upgraded to it.
 */
export async function personAuthorizedRoot(db: Queryable, spaceId: string, rootRunId: string | null | undefined) {
  if (!rootRunId) return null;
  return (await db.query<{ agent_id: string }>(
    `SELECT agent_id FROM runs WHERE space_id=$1 AND id=$2 AND trigger_origin='manual' AND parent_run_id IS NULL`,
    [spaceId, rootRunId],
  )).rows[0] ?? null;
}

/**
 * The row lock serializes admission, charging and the once-only visible notices.
 * `person_authorized` is the one classification admission and notices share:
 * the container's root is a person's own Room turn and the group judged is
 * not in a discussion (a discussion, explicit or emergent, keeps its own
 * soft/hard bounds and its soft-budget notice).
 */
export async function roomBudgetContainer(db: Queryable, spaceId: string, groupId: string) {
  return (await db.query<{ id: string; space_id: string; budget_json: Record<string, unknown>; session_id: string | null; person_authorized: boolean }>(
    `SELECT container.id, container.space_id, container.budget_json, container.session_id,
            grp.discussion_id IS NULL AND EXISTS (SELECT 1 FROM runs root WHERE root.space_id=container.space_id AND root.id=container.root_run_id
              AND root.trigger_origin='manual' AND root.parent_run_id IS NULL) AS person_authorized
       FROM agent_run_groups grp
       JOIN agent_run_groups container ON container.space_id=grp.space_id
        AND container.id=COALESCE(grp.budget_json->>'container_group_id',grp.id)
        AND container.room_id=grp.room_id AND container.session_id IS NOT DISTINCT FROM grp.session_id
        AND container.project_id IS NOT DISTINCT FROM grp.project_id AND container.manager_user_id=grp.manager_user_id
      WHERE grp.space_id=$1 AND grp.id=$2 FOR UPDATE OF container`, [spaceId, groupId],
  )).rows[0];
}

/**
 * What a person sees about a Room container's temporary delegation after an
 * admission or a charged turn. Person-authorized work (see
 * `roomBudgetContainer`) gets the shared threshold reminder (no total limit);
 * a discussion and any other container keep their one soft-budget notice
 * inside the hard bound admission still applies. A task collaboration (any stored
 * key, an invalid one included) has its own reminder and is skipped here.
 */
export async function noteRoomDelegationUsage(db: Queryable, spaceId: string, groupId: string): Promise<void> {
  const container = await roomBudgetContainer(db, spaceId, groupId);
  if (!container || Object.hasOwn(container.budget_json ?? {}, "collaboration") || !container.session_id) return;
  if (container.person_authorized) {
    const results = await containerResults(db, spaceId, container.id);
    const notified = container.budget_json.reminder_notified_through;
    const through = await postWorkReminder(db, container, {
      kind: "delegation", key: `${container.id}:delegation`, count: results.length,
      notifiedThrough: typeof notified === "number" ? notified : 0, results, since: null, turnsOffset: 0,
    });
    if (through !== null) await db.query(`UPDATE agent_run_groups SET budget_json=budget_json || jsonb_build_object('reminder_notified_through', $3::int)
      WHERE space_id=$1 AND id=$2`, [spaceId, container.id, through]);
    return;
  }
  if (container.budget_json.soft_budget_notified) return;
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

/** Admitted delegations of a container since `offset`, newest first; policy refusals cost nothing. */
export async function containerResults(db: Queryable, spaceId: string, containerId: string, offset = 0) {
  const all = (await db.query<{ status: string; run_status: string | null; target_agent_id: string; updated_at: string }>(
    `SELECT d.status, r.status AS run_status, d.target_agent_id, to_json(d.updated_at)#>>'{}' AS updated_at
       FROM run_delegations d JOIN agent_run_groups g ON g.space_id = d.space_id AND g.id = d.group_id
       LEFT JOIN runs r ON r.space_id = d.space_id AND r.id = d.child_run_id
       WHERE d.space_id = $1 AND (g.id = $2 OR g.budget_json->>'container_group_id' = $2)
         AND d.status <> 'policy_denied' ORDER BY d.created_at DESC, d.id DESC`,
    [spaceId, containerId],
  )).rows;
  return all.slice(0, Math.max(0, all.length - offset));
}
export type ContainerResult = Awaited<ReturnType<typeof containerResults>>[number];

/** Failed/cancelled children with no result, newest first, before the first one that produced something. */
export function consecutiveFailures(results: ReadonlyArray<{ status: string; run_status: string | null }>): number {
  let n = 0;
  for (const r of results) {
    // A degraded child replied and is recorded as failed only because a
    // governed call of its own was refused; the coordinator has its result to judge.
    if (!["failed", "cancelled"].includes(r.status) || r.run_status === "degraded") break;
    n += 1;
  }
  return n;
}
