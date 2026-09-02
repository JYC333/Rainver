import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

/**
 * The rows almost every Project-domain test needs before it can do anything:
 * a Space, its owner, the owner's membership, and one Project. Column lists
 * and literals match what the files used to inline, so assertions on names
 * and types are unchanged; pass the option when a test needs a different one.
 */
export async function seedSpaceOwnerProject(
  pool: Pool,
  input: {
    space: string;
    owner: string;
    project: string;
    spaceName?: string;
    spaceType?: string;
    ownerDisplayName?: string;
    projectName?: string;
    now?: string;
  },
): Promise<{ now: string }> {
  const now = input.now ?? new Date().toISOString();
  await pool.query(
    `INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1,$2,$3,$4,$4)`,
    [input.space, input.spaceName ?? "Main", input.spaceType ?? "personal", now],
  );
  await pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1,$2,'active',$3,$3)`,
    [input.owner, input.ownerDisplayName ?? input.owner, now],
  );
  await pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES ($1,$2,$3,'owner','active',$4,$4)`,
    [randomUUID(), input.space, input.owner, now],
  );
  await pool.query(
    `INSERT INTO projects (id, space_id, owner_user_id, name, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'active',$5,$5)`,
    [input.project, input.space, input.owner, input.projectName ?? "Research", now],
  );
  await seedProjectMainlineRoom(pool, {
    space: input.space,
    project: input.project,
    owner: input.owner,
    title: input.projectName ?? "Research",
    now,
  });
  return { now };
}

/**
 * The mainline Room a Project is created with (ADR 0018 decision 4).
 *
 * Part of the Project seed rather than an opt-in, because in production a
 * Project without one cannot exist — a fixture that omitted it would be
 * testing a state the system no longer has, and `getProjectMainline` now
 * reports its absence as a broken invariant rather than an empty Project.
 *
 * No conversation and no manager Agent: both arrive with the first message.
 */
export async function seedProjectMainlineRoom(
  pool: Pool,
  input: { space: string; project: string; owner: string; title?: string; roomId?: string; now?: string },
): Promise<{ roomId: string }> {
  const now = input.now ?? new Date().toISOString();
  const roomId = input.roomId ?? randomUUID();
  await pool.query(
    `INSERT INTO rooms (id, space_id, project_id, created_by_user_id, title, status,
                        created_at, updated_at, is_mainline)
     VALUES ($1,$2,$3,$4,$5,'active',$6,$6,true)`,
    [roomId, input.space, input.project, input.owner, input.title ?? "Project", now],
  );
  await pool.query(
    `INSERT INTO room_user_members (id, space_id, room_id, user_id, role, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'owner','active',$5,$5)`,
    [randomUUID(), input.space, roomId, input.owner, now],
  );
  return { roomId };
}

/**
 * Give every Project that lacks one the mainline Room it would have been
 * created with (ADR 0018 decision 4), plus its owner's membership.
 *
 * For tests that insert `projects` rows directly. Production has one creation
 * path and it writes the Room in the same transaction; a fixture that inserts
 * the row alone builds a Project the system cannot produce, and any read that
 * assumes the mainline exists — `getProjectMainline`, the conversation list —
 * reports it as a broken invariant. Idempotent, shape-independent, and safe
 * to call after any number of inserts. A Project with no owner is skipped: it
 * is itself a shape `create` never produces, and a Room needs a creator.
 */
export async function seedMainlineRoomsForAllProjects(pool: Pool, now = new Date().toISOString()): Promise<void> {
  await pool.query(
    `INSERT INTO rooms (id, space_id, project_id, created_by_user_id, title, status,
                        created_at, updated_at, is_mainline)
     SELECT gen_random_uuid()::varchar, p.space_id, p.id, p.owner_user_id, p.name, 'active', $1, $1, true
       FROM projects p
      WHERE p.owner_user_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM rooms r
           WHERE r.space_id = p.space_id AND r.project_id = p.id AND r.is_mainline AND r.status = 'active'
        )`,
    [now],
  );
  await pool.query(
    `INSERT INTO room_user_members (id, space_id, room_id, user_id, role, status, created_at, updated_at)
     SELECT gen_random_uuid()::varchar, r.space_id, r.id, r.created_by_user_id, 'owner', 'active', $1, $1
       FROM rooms r
      WHERE r.is_mainline AND r.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM room_user_members m
           WHERE m.space_id = r.space_id AND m.room_id = r.id AND m.user_id = r.created_by_user_id
        )`,
    [now],
  );
}

/**
 * Seat an Agent as a Room's manager.
 *
 * Every Room has exactly one active manager and it is always the system
 * Assistant; production seats it on the first message. A test that wants a
 * Room ready to speak in without going through that path seats one here.
 * Promoted once its third copy appeared.
 */
export async function seedRoomManager(
  pool: Pool,
  input: { space: string; room: string; agent: string; id?: string; now?: string },
): Promise<{ memberId: string }> {
  const memberId = input.id ?? randomUUID();
  const now = input.now ?? new Date().toISOString();
  const result = await pool.query<{ id: string }>(
    `INSERT INTO room_agent_members (id, space_id, room_id, agent_id, role, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'manager','active',$5,$5)
     ON CONFLICT (room_id, agent_id) DO UPDATE
       SET role = 'manager', status = 'active', updated_at = EXCLUDED.updated_at
     RETURNING id`,
    [memberId, input.space, input.room, input.agent, now],
  );
  return { memberId: result.rows[0]!.id };
}

/** An active agent with one version bound as current, as research tests need. */
export async function seedAgentWithVersion(
  pool: Pool,
  input: {
    agent: string;
    version: string;
    space: string;
    owner: string;
    name?: string;
    systemPrompt?: string;
    now?: string;
  },
): Promise<void> {
  const now = input.now ?? new Date().toISOString();
  await pool.query(
    `INSERT INTO agents (id, space_id, owner_user_id, name, status, current_version_id, created_at, updated_at, visibility)
     VALUES ($1,$2,$3,$4,'active',NULL,$5,$5,'space_shared')`,
    [input.agent, input.space, input.owner, input.name ?? "Research Agent", now],
  );
  await pool.query(
    `INSERT INTO agent_versions (
       id, agent_id, space_id, version_label, system_prompt, model_config_json,
       runtime_config_json, context_policy_json, memory_policy_json,
       capabilities_json, tool_permissions_json, runtime_policy_json, created_at
     ) VALUES ($1,$2,$3,'v1',$4,'{}','{}','{}','{}','[]','{}','{}',$5)`,
    [input.version, input.agent, input.space, input.systemPrompt ?? "Test research agent.", now],
  );
  await pool.query(`UPDATE agents SET current_version_id=$2 WHERE id=$1`, [input.agent, input.version]);
}

/** A finished agent Run in the Space, with the agent and version it needs. */
export async function seedRun(
  pool: Pool,
  input: { id: string; space: string; owner: string; agent: string; version: string; now?: string },
): Promise<void> {
  const now = input.now ?? new Date().toISOString();
  await seedAgentWithVersion(pool, { agent: input.agent, version: input.version, space: input.space, owner: input.owner, name: "Run Agent", now });
  await pool.query(
    `INSERT INTO runs (id, space_id, agent_id, agent_version_id, run_type, trigger_origin, status, mode, owner_user_id, visibility, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'agent','manual','succeeded','live',$5,'space_shared',$6,$6)`,
    [input.id, input.space, input.agent, input.version, input.owner, now],
  );
}

/** The unowned server host (machine + host rows) that Project Folder tests attach locations to. */
export async function seedServerHost(pool: Pool, input: { id: string; now?: string }): Promise<void> {
  const now = input.now ?? new Date().toISOString();
  await pool.query(
    `INSERT INTO machines (id, owner_user_id, display_name, device_kind, created_at, updated_at)
     VALUES ($1, NULL, 'Test server', 'server', $2, $2)`,
    [input.id, now],
  );
  await pool.query(
    `INSERT INTO hosts (id, owner_user_id, machine_id, name, kind, environment_kind, status, created_at, updated_at)
     VALUES ($1, NULL, $1, 'server', 'server', 'server', 'online', $2, $2)`,
    [input.id, now],
  );
}

/** A user plus their membership in the Space (role `member` unless given). */
export async function seedSpaceMember(
  pool: Pool,
  input: { space: string; user: string; role?: string; now?: string },
): Promise<void> {
  const now = input.now ?? new Date().toISOString();
  await pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1,$1,'active',$2,$2)`,
    [input.user, now],
  );
  await pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'active',$5,$5)`,
    [randomUUID(), input.space, input.user, input.role ?? "member", now],
  );
}
