import { randomUUID } from "node:crypto";
import type { Queryable } from "../modules/routeUtils/common.js";

/**
 * Get-or-create an `actors` row for a person or a service.
 *
 * Every append-only surface that records *who did this* — run steps, and now
 * Project work events — needs a non-null Actor FK, and each of them arrived at
 * the same select-then-insert. Keeping one copy matters less for the SQL than
 * for the lookup key: an actor found by a slightly different predicate is a
 * second identity for the same person, and nothing downstream can tell the two
 * apart afterwards.
 *
 * Not covered here: the Space Assistant's actor, which deliberately pins its
 * row id to the Agent id so Room provisioning can reconcile it idempotently
 * (`agents/repository.ts`). That is an identity decision, not a lookup.
 */

async function findOrCreate(
  db: Queryable,
  where: { sql: string; params: readonly unknown[] },
  insert: { columns: string; values: string; params: readonly unknown[] },
): Promise<string> {
  const existing = await db.query<{ id: string }>(
    `SELECT id FROM actors WHERE ${where.sql} AND status = 'active' LIMIT 1`,
    [...where.params],
  );
  const found = existing.rows[0];
  if (found) return found.id;

  const created = await db.query<{ id: string }>(
    `INSERT INTO actors (${insert.columns}) VALUES (${insert.values})
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [...insert.params],
  );
  const row = created.rows[0];
  if (row) return row.id;

  // A concurrent writer won the insert. Re-read rather than fail: two
  // simultaneous first-writes for the same identity is normal, not an error.
  const raced = await db.query<{ id: string }>(
    `SELECT id FROM actors WHERE ${where.sql} AND status = 'active' LIMIT 1`,
    [...where.params],
  );
  const settled = raced.rows[0];
  if (!settled) throw new Error("actor insert returned no row and no existing actor was found");
  return settled.id;
}

export async function resolveUserActorId(
  db: Queryable,
  spaceId: string,
  userId: string,
): Promise<string> {
  const now = new Date().toISOString();
  return findOrCreate(
    db,
    { sql: "actor_type = 'user' AND user_id = $1 AND space_id = $2", params: [userId, spaceId] },
    {
      columns: "id, space_id, actor_type, user_id, agent_id, service_name, display_name, status, metadata_json, created_at, updated_at",
      values: "$1, $2, 'user', $3, NULL, NULL, NULL, 'active', '{}'::jsonb, $4, $4",
      params: [randomUUID(), spaceId, userId, now],
    },
  );
}

/**
 * The Agent's own actor.
 *
 * Created with the Agent's id as its own, matching how the Space Assistant's
 * actor is provisioned — so an Agent has one identity whichever path reaches
 * it first, rather than one per creator.
 */
export async function resolveAgentActorId(
  db: Queryable,
  spaceId: string,
  agentId: string,
): Promise<string> {
  const now = new Date().toISOString();
  // Pinned id, so this is an upsert rather than find-or-create: a row that
  // was archived keeps the Agent's id, and a plain insert would collide on it
  // while the active-only lookup kept missing it — an Agent that could never
  // act again.
  const result = await db.query<{ id: string }>(
    `INSERT INTO actors (
       id, space_id, actor_type, user_id, agent_id, service_name, display_name,
       status, metadata_json, created_at, updated_at
     ) VALUES ($1, $2, 'agent', NULL, $1, NULL, NULL, 'active', '{}'::jsonb, $3, $3)
     ON CONFLICT (id) DO UPDATE
       SET status = 'active', updated_at = EXCLUDED.updated_at
     RETURNING id`,
    [agentId, spaceId, now],
  );
  const row = result.rows[0];
  if (!row) throw new Error("agent actor upsert returned no row");
  return row.id;
}

/**
 * `actorType` distinguishes background dispatch (`job`) from in-process system
 * work (`system`); `serviceName` names which one, so an audit trail says
 * `agent_run` or `project_work_settlement` rather than "the server".
 */
export async function resolveServiceActorId(
  db: Queryable,
  spaceId: string,
  serviceName: string,
  actorType: "system" | "job" = "system",
): Promise<string> {
  const now = new Date().toISOString();
  return findOrCreate(
    db,
    {
      sql: "actor_type = $1 AND service_name = $2 AND space_id = $3",
      params: [actorType, serviceName, spaceId],
    },
    {
      columns: "id, space_id, actor_type, user_id, agent_id, service_name, display_name, status, metadata_json, created_at, updated_at",
      values: "$1, $2, $3, NULL, NULL, $4, NULL, 'active', '{}'::jsonb, $5, $5",
      params: [randomUUID(), spaceId, actorType, serviceName, now],
    },
  );
}
