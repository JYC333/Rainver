import { createHash } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { PgAuthRepository } from "../src/modules/auth/identity.js";

let repo: PgAuthRepository | undefined;

const db = useTestDatabase(import.meta.filename, { max: 10 });

beforeAll(async () => {
  if (!db.available) return;
  repo = new PgAuthRepository(db.pool);
});

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["runtime_context_policy_audits", "runtime_context_policy_bindings", "runtime_context_policy_versions", "note_collections", "memory_entries", "auth_accounts", "user_sessions", "space_memberships", "spaces", "users"],
    { cascade: true },
  );
  await db.pool.query(
    `INSERT INTO users
       (id, email, display_name, status, avatar_url, last_login_at, created_at, updated_at)
     VALUES
       ('user-1', 'u@example.test', 'User One', 'active', NULL, NULL, now(), now()),
       ('user-2', 'v@example.test', 'User Two', 'active', NULL, NULL, now(), now())`,
  );
  await db.pool.query(
    `INSERT INTO spaces
       (id, name, type, created_by_user_id, created_at, updated_at)
     VALUES
       ('personal-1', 'Personal', 'personal', 'user-1', now() - interval '2 days', now()),
       ('team-1', 'Team', 'team', 'user-1', now() - interval '1 day', now()),
       ('other-1', 'Other', 'team', 'user-2', now(), now())`,
  );
  await db.pool.query(
    `INSERT INTO space_memberships
       (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES
       ('m-personal', 'personal-1', 'user-1', 'owner', 'active', now() - interval '2 days', now()),
       ('m-team', 'team-1', 'user-1', 'admin', 'active', now() - interval '1 day', now()),
       ('m-other', 'other-1', 'user-2', 'owner', 'active', now(), now())`,
  );
  await insertSession("raw-token", "user-1", "session-1", "1 day");
});

async function insertSession(raw: string, userId: string, id: string, expiresIn: string): Promise<void> {
  await db.pool.query(
    `INSERT INTO user_sessions
       (id, user_id, token_hash, created_at, expires_at, last_seen_at)
     VALUES ($1, $2, $3, now(), now() + ($4::interval), NULL)`,
    [id, userId, createHash("sha256").update(raw).digest("hex"), expiresIn],
  );
}

describe("PgAuthRepository", () => {
  it("resolves a session cookie to the default personal space and touches last_seen_at", async () => {
    if (!db.available || !repo || !db.pool) return;

    const identity = await repo.resolveIdentity({ sessionToken: "raw-token" });

    expect(identity).toEqual({ ok: true, spaceId: "personal-1", userId: "user-1" });
    const touched = await db.pool.query("SELECT last_seen_at FROM user_sessions WHERE id = 'session-1'");
    expect(touched.rows[0].last_seen_at).not.toBeNull();
  });

  it("honors requested space only when the session user is an active member", async () => {
    if (!db.available || !repo) return;

    expect(
      await repo.resolveIdentity({ sessionToken: "raw-token", requestedSpaceId: "team-1" }),
    ).toEqual({ ok: true, spaceId: "team-1", userId: "user-1" });

    const denied = await repo.resolveIdentity({
      sessionToken: "raw-token",
      requestedSpaceId: "other-1",
    });
    expect(denied).toMatchObject({ ok: false, statusCode: 403 });
    expect(denied.ok === false ? JSON.parse(denied.body) : null).toEqual({
      detail: "Not a member of this space",
    });
  });

  it("keeps API key auth explicitly unavailable while api_keys are not canonical", async () => {
    if (!db.available || !repo) return;

    const denied = await repo.resolveIdentity({ authorization: "Bearer ask_test" });

    expect(denied).toMatchObject({ ok: false, statusCode: 501 });
  });

  it("serves current user and space read models", async () => {
    if (!db.available || !repo) return;

    const user = await repo.getCurrentUser("raw-token");
    expect(user).toMatchObject({ id: "user-1", email: "u@example.test" });

    const spaces = await repo.getUserSpaces("user-1");
    expect(spaces.map((s) => s.id)).toEqual(["personal-1", "team-1"]);

    const space = await repo.getSpaceForUser("user-1", "team-1");
    expect(space).toMatchObject({ id: "team-1", role: "admin" });
  });

  it("creates a Google user with a personal space, default seeds, and a session", async () => {
    if (!db.available || !repo || !db.pool) return;

    const user = await repo.findOrCreateFromGoogle({
      googleSub: "google-new",
      email: "new@example.test",
      displayName: "New User",
      avatarUrl: "https://avatar.example/new.png",
    });
    const rawSession = await repo.createSession(user.id, 30);

    expect(user).toMatchObject({
      email: "new@example.test",
      display_name: "New User",
      avatar_url: "https://avatar.example/new.png",
    });
    expect(rawSession).toMatch(/^[0-9a-f]{64}$/);

    const spaces = await db.pool.query("SELECT id, name, type, oversight_mode FROM spaces WHERE created_by_user_id = $1", [
      user.id,
    ]);
    expect(spaces.rows).toHaveLength(1);
    expect(spaces.rows[0]).toMatchObject({
      name: "New User's Personal Space",
      type: "personal",
      // Personal Spaces are forced to 'none' — there is no request body in
      // this bootstrap path, so the column default is the only enforcement.
      oversight_mode: "none",
    });
    const spaceId = spaces.rows[0].id as string;
    const membership = await db.pool.query(
      "SELECT role, status FROM space_memberships WHERE user_id = $1 AND space_id = $2",
      [user.id, spaceId],
    );
    expect(membership.rows[0]).toEqual({ role: "owner", status: "active" });
    expect((await db.pool.query("SELECT count(*)::int AS count FROM memory_entries WHERE space_id = $1", [spaceId])).rows[0].count).toBe(0);
    expect((await db.pool.query("SELECT count(*)::int AS count FROM note_collections WHERE space_id = $1", [spaceId])).rows[0].count).toBe(5);
    expect((await db.pool.query("SELECT count(*)::int AS count FROM runtime_context_policy_versions WHERE space_id = $1", [spaceId])).rows[0].count).toBe(1);
    expect((await db.pool.query("SELECT count(*)::int AS count FROM user_sessions WHERE user_id = $1", [user.id])).rows[0].count).toBe(1);
  });
});
