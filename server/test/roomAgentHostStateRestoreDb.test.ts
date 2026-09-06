import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { seedAgentWithVersion, seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { findManagedWorkspaceRestoreTarget } from "../src/modules/rooms/rosterService.js";
import { PgHostThreadRepository } from "../src/modules/hosts/threadRepository.js";

/**
 * What a re-added Room specialist gets its host state back from.
 *
 * Two things are archived when an Agent leaves a Conversation and only one of
 * them is always there to restore: the Agent's runtime profile always, the
 * shared cwd only when it was the last one out. The heartbeat reports
 * workspaces and not profiles, so the question this answers is "is there a
 * closed thread to restore into", with the workspace as a separate flag.
 */

const SPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROJECT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const AGENT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const VERSION = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const MACHINE = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const HOST = "11111111-1111-4111-8111-111111111111";
const CONVERSATION = "22222222-2222-4222-8222-222222222222";
const FOLDER = "33333333-3333-4333-8333-333333333333";
const LOCATION = "44444444-4444-4444-8444-444444444444";

const db = useTestDatabase(import.meta.filename);
let roomId = "";

async function closedConversationThread(workspaceMode: "managed" | "location"): Promise<void> {
  await db.pool.query(
    `INSERT INTO host_threads (
       id, space_id, execution_host_id, workspace_mode, session_id, agent_id, container_kind,
       adapter_type, runtime_installation, status, created_by_user_id, created_at, updated_at
       , workspace_location_id
     ) VALUES ($1, $2, $3, $4, $5, $6, 'conversation', 'claude_code', 'own', 'closed', $7, now(), now(), $8)`,
    [randomUUID(), SPACE, HOST, workspaceMode, CONVERSATION, AGENT, OWNER,
      workspaceMode === "location" ? LOCATION : null],
  );
}

async function reportWorkspaceArchive(available: boolean): Promise<void> {
  await db.pool.query(
    `UPDATE hosts SET managed_workspaces_json = $2::jsonb WHERE id = $1`,
    [HOST, JSON.stringify([{
      container_kind: "conversation",
      container_id: CONVERSATION,
      archived_available: available,
    }])],
  );
}

async function target() {
  const client = await db.pool.connect();
  try {
    return await findManagedWorkspaceRestoreTarget(client, SPACE, AGENT, roomId, OWNER);
  } finally {
    client.release();
  }
}

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["host_threads", "sessions", "workspace_locations", "project_folders", "agents", "agent_versions", "rooms", "projects", "hosts", "machines", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  const { now } = await seedSpaceOwnerProject(db.pool, { space: SPACE, owner: OWNER, project: PROJECT });
  roomId = (await db.pool.query<{ id: string }>(
    `SELECT id FROM rooms WHERE space_id = $1 AND is_mainline = true LIMIT 1`, [SPACE],
  )).rows[0]!.id;
  await db.pool.query(
    `INSERT INTO sessions (id, space_id, project_id, room_id, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'active', $5, $5)`,
    [CONVERSATION, SPACE, PROJECT, roomId, now],
  );
  await seedAgentWithVersion(db.pool, { agent: AGENT, version: VERSION, space: SPACE, owner: OWNER, now });
  await db.pool.query(
    `INSERT INTO machines (id, owner_user_id, display_name, device_kind, created_at, updated_at)
     VALUES ($1, $2, 'laptop', 'laptop', $3, $3)`,
    [MACHINE, OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO hosts (id, owner_user_id, machine_id, name, kind, environment_kind, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'laptop', 'remote', 'linux_native', 'online', $4, $4)`,
    [HOST, OWNER, MACHINE, now],
  );
  await db.pool.query(
    `INSERT INTO project_folders (id, space_id, project_id, name, kind, status, protected, system_managed, created_at, updated_at)
     VALUES ($1, $2, $3, 'repo', 'code', 'active', false, false, $4, $4)`,
    [FOLDER, SPACE, PROJECT, now],
  );
  await db.pool.query(
    `INSERT INTO workspace_locations (
       id, space_id, project_folder_id, execution_host_id, execution_host_kind,
       display_path, execution_ready, status, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, 'remote', '~/code', true, 'active', $5, $5)`,
    [LOCATION, SPACE, FOLDER, HOST, now],
  );
});

describe("finding what a re-added Agent restores", () => {
  it("offers the profile back even when no workspace archive is available", async (ctx) => {
    if (!db.available) return ctx.skip();
    // The common case: this Agent left while others stayed, so only its
    // profile was archived. Requiring a workspace archive here is what made
    // every such profile permanently unrestorable and swept after 30 days.
    await closedConversationThread("managed");
    await reportWorkspaceArchive(false);

    await expect(target()).resolves.toMatchObject({
      hostId: HOST,
      agentId: AGENT,
      conversationId: CONVERSATION,
      includeWorkspace: false,
    });
  });

  it("takes the shared cwd too when the host reports one archived", async (ctx) => {
    if (!db.available) return ctx.skip();
    await closedConversationThread("managed");
    await reportWorkspaceArchive(true);

    await expect(target()).resolves.toMatchObject({ includeWorkspace: true });
  });

  it("never asks for a workspace a Location-pinned Conversation never had", async (ctx) => {
    if (!db.available) return ctx.skip();
    await closedConversationThread("location");
    await reportWorkspaceArchive(true);

    await expect(target()).resolves.toMatchObject({ includeWorkspace: false });
  });

  it("finds nothing when the Agent has no closed thread in this Room", async (ctx) => {
    if (!db.available) return ctx.skip();
    await expect(target()).resolves.toBeNull();

    // And nothing on a live thread — there is nothing to bring back while the
    // Agent is still in the Room.
    await new PgHostThreadRepository(db.pool).getOrCreateForConversationAgent({
      executionHostId: HOST,
      workspaceMode: "managed",
      spaceId: SPACE,
      sessionId: CONVERSATION,
      agentId: AGENT,
      adapterType: "claude_code",
      runtimeInstallation: "own",
      createdByUserId: OWNER,
    });
    await expect(target()).resolves.toBeNull();
  });

  it("offers nothing on a revoked host, another user's host, or another Room", async (ctx) => {
    if (!db.available) return ctx.skip();
    await closedConversationThread("managed");

    await db.pool.query(`UPDATE hosts SET status = 'revoked' WHERE id = $1`, [HOST]);
    await expect(target()).resolves.toBeNull();
    await db.pool.query(`UPDATE hosts SET status = 'online' WHERE id = $1`, [HOST]);

    // A Host is user-scoped (B63): restoring state onto someone else's
    // machine is not this person's to ask for.
    const other = randomUUID();
    await db.pool.query(
      `INSERT INTO users (id, email, display_name, status, created_at, updated_at)
       VALUES ($1, 'other@example.com', 'Other', 'active', now(), now())`,
      [other],
    );
    await db.pool.query(`UPDATE hosts SET owner_user_id = $2 WHERE id = $1`, [HOST, other]);
    await expect(target()).resolves.toBeNull();
    await db.pool.query(`UPDATE hosts SET owner_user_id = $2 WHERE id = $1`, [HOST, OWNER]);

    // And a Room is a visibility boundary (ADR 0018): a closed thread in one
    // Room is not what a specialist re-added to another picks up.
    const otherRoom = randomUUID();
    await db.pool.query(
      `INSERT INTO rooms (id, space_id, project_id, title, is_mainline, status, created_by_user_id, created_at, updated_at)
       VALUES ($1, $2, $3, 'Limited', false, 'active', $4, now(), now())`,
      [otherRoom, SPACE, PROJECT, OWNER],
    );
    const client = await db.pool.connect();
    try {
      await expect(findManagedWorkspaceRestoreTarget(client, SPACE, AGENT, otherRoom, OWNER))
        .resolves.toBeNull();
    } finally {
      client.release();
    }
  });
});
