import { collaborationReminderThresholdsBetween } from "@rainver/protocol";
import type { Queryable } from "../routeUtils/common.js";
import { PgSessionRepository } from "../sessions/repository.js";
import type { ContainerResult as CollaborationResult } from "../rooms/delegationBudget.js";

const UNFINISHED = new Set(["requested", "queued", "running"]);

interface ReminderContainer {
  id: string;
  space_id: string;
  session_id: string | null;
  budget_json: Record<string, unknown> | null;
}

/**
 * Facts a person needs beside a count: recent outcome and measurable spend.
 * Nothing estimated. A Room notice is read by every Room member, and the
 * manager reading the Task does not make it readable to them, so no Task
 * content (title, status, description) is ever part of it; the Task's
 * details stay behind each reader's own Task access in `room.collaboration.get`.
 */
async function workFacts(db: Queryable, container: ReminderContainer, results: readonly CollaborationResult[], since: string | null, turnsOffset: number) {
  const latest = results.find((r) => !UNFINISHED.has(r.status)) ?? null;
  const agent = latest ? (await db.query<{ name: string }>(`SELECT name FROM agents WHERE space_id=$1 AND id=$2`,
    [container.space_id, latest.target_agent_id])).rows[0] : null;
  let failures = 0;
  for (const r of results) {
    if (UNFINISHED.has(r.status)) continue;
    if (!["failed", "cancelled"].includes(r.status) || r.run_status === "degraded") break;
    failures += 1;
  }
  // Only catalog-priced usage is money; subscription Runs have no measured price here.
  const spend = (await db.query<{ priced: string | null; events: string }>(
    `SELECT sum(e.estimated_cost_usd) FILTER (WHERE e.cost_accuracy='catalog')::text AS priced,
            count(*) FILTER (WHERE e.cost_accuracy='catalog')::text AS events
       FROM token_usage_events e
       JOIN runs r ON r.space_id=e.space_id AND r.id=e.run_id
       JOIN agent_run_groups g ON g.space_id=r.space_id AND g.id=r.run_group_id
      WHERE e.space_id=$1 AND (g.id=$2 OR g.budget_json->>'container_group_id'=$2)
        AND ($3::timestamptz IS NULL OR e.occurred_at >= $3::timestamptz)`,
    [container.space_id, container.id, since])).rows[0];
  return {
    turns_used: Math.max(0, Number(container.budget_json?.container_turns_used ?? 0) - turnsOffset),
    latest_result: latest ? { agent_id: latest.target_agent_id, agent_name: agent?.name ?? null, status: latest.status, at: latest.updated_at } : null,
    consecutive_failures: failures,
    priced_spend_usd: Number(spend?.events ?? 0) > 0 ? Number(spend?.priced ?? 0) : null,
  };
}

/**
 * The one reminder for work a person's Room turn authorized — a task
 * collaboration or temporary delegation, neither of which has a total limit.
 * Called under the container row lock while admitting handoff number `count`.
 * Posts at most one Room notice for every threshold crossed since
 * `notifiedThrough` — a jump is summarised, never one notice per threshold —
 * under a stable `<key>:reminder:<threshold>` key that is never written
 * twice, and returns the new notified-through value, or null when nothing
 * was crossed. It informs and never stops work. A rolled-back admission
 * rolls back its notice too.
 */
export async function postWorkReminder(db: Queryable, container: ReminderContainer, input: {
  kind: "collaboration" | "delegation";
  key: string;
  count: number;
  notifiedThrough: number;
  results: readonly CollaborationResult[];
  since: string | null;
  turnsOffset: number;
  taskId?: string;
}): Promise<number | null> {
  const crossed = collaborationReminderThresholdsBetween(input.notifiedThrough, input.count);
  const threshold = crossed.at(-1);
  if (threshold === undefined) return null;
  if (!container.session_id) return threshold;
  const event = input.kind === "collaboration" ? "collaboration_reminder" : "delegation_reminder";
  const eventKey = `${input.key}:reminder:${threshold}`;
  const existing = await db.query(`SELECT 1 FROM messages WHERE space_id=$1 AND session_id=$2 AND role='system'
      AND metadata_json->>'execution_event'=$3 AND metadata_json->>'execution_event_key'=$4 LIMIT 1`,
  [container.space_id, container.session_id, event, eventKey]);
  if (existing.rows.length) return threshold;
  const facts = await workFacts(db, container, input.results, input.since, input.turnsOffset);
  const latest = facts.latest_result
    ? `${facts.latest_result.agent_name ?? facts.latest_result.agent_id} — ${facts.latest_result.status} (${facts.latest_result.at})`
    : "none yet";
  const subject = input.kind === "collaboration" ? "Task collaboration" : "Room delegation";
  const content = [
    `${subject} reached ${input.count} handoffs (reminder ${crossed.join(", ")}). Work continues; nothing was stopped and there is no total limit.`,
    `Agent turns: ${facts.turns_used}.${input.kind === "collaboration" ? " The Task's details are on the task collaboration line for people who can read it." : ""}`,
    `Latest result: ${latest}. Children in a row without a result: ${facts.consecutive_failures}.`,
    ...(facts.priced_spend_usd !== null ? [`Priced spend: $${facts.priced_spend_usd.toFixed(2)}.`] : []),
    input.kind === "collaboration"
      ? "A person can pause, resume or stop it from the task collaboration line in this conversation."
      : "A person can stop the running work from this conversation.",
  ].join("\n");
  await new PgSessionRepository(db).addRoomConversationNotice(container.space_id, container.session_id, {
    content,
    metadata: {
      execution_event: event,
      execution_event_key: eventKey,
      execution_details: {
        container_group_id: container.id, ...(input.taskId ? { task_id: input.taskId } : {}), threshold,
        crossed_thresholds: crossed, delegations_used: input.count, ...facts,
      },
    },
  });
  return threshold;
}
