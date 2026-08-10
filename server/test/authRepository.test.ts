import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPostgres, isTestPostgresUnavailableError, type TestPostgresDatabase } from "./support/sharedPostgres";
import { PgAuthRepository } from "../src/modules/auth/identity";

const SCHEMA = `
CREATE TABLE users (
  id varchar(36) PRIMARY KEY,
  email varchar(256),
  display_name varchar(256) NOT NULL,
  avatar_url text,
  status varchar(32) NOT NULL DEFAULT 'active',
  last_login_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE TABLE spaces (
  id varchar(36) PRIMARY KEY,
  name varchar(256) NOT NULL,
  type varchar(32) NOT NULL,
  created_by_user_id varchar(36),
  oversight_mode varchar(16) NOT NULL DEFAULT 'none',
  egress_notifications_enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE TABLE space_memberships (
  id varchar(36) PRIMARY KEY,
  space_id varchar(36) NOT NULL REFERENCES spaces(id),
  user_id varchar(36) NOT NULL REFERENCES users(id),
  role varchar(32) NOT NULL,
  status varchar(32) NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE TABLE user_sessions (
  id varchar(36) PRIMARY KEY,
  user_id varchar(36) NOT NULL REFERENCES users(id),
  token_hash varchar(128) NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz
);
CREATE TABLE auth_accounts (
  id varchar(36) PRIMARY KEY,
  user_id varchar(36) NOT NULL REFERENCES users(id),
  provider varchar(32) NOT NULL,
  provider_user_id varchar(256) NOT NULL,
  email varchar(256) NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE TABLE memory_entries (
  id varchar(36) PRIMARY KEY,
  space_id varchar(36) NOT NULL REFERENCES spaces(id),
  scope_type varchar(32) NOT NULL,
  scope_id varchar(36),
  memory_type varchar(32) NOT NULL,
  content text NOT NULL,
  status varchar(32) NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  subject_user_id varchar(36),
  owner_user_id varchar(36),
  sensitivity_level varchar(32) NOT NULL,
  namespace varchar(255),
  title varchar(512),
  visibility varchar(32) NOT NULL,
  confidence double precision NOT NULL,
  importance double precision NOT NULL,
  created_by varchar(64),
  deleted_at timestamptz,
  version integer NOT NULL,
  access_count integer NOT NULL
);
CREATE TABLE note_collections (
  id varchar(36) PRIMARY KEY,
  space_id varchar(36) NOT NULL REFERENCES spaces(id),
  parent_id varchar(36),
  name varchar(256) NOT NULL,
  system_role varchar(32) NOT NULL,
  sort_order integer NOT NULL,
  is_system boolean NOT NULL,
  is_hidden boolean NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE TABLE runtime_context_policy_versions (
  id varchar(36) PRIMARY KEY,
  space_id varchar(36) NOT NULL REFERENCES spaces(id),
  scope_type varchar(32) NOT NULL,
  scope_id varchar(36) NOT NULL,
  version integer NOT NULL,
  policy_json jsonb NOT NULL,
  base_version_id varchar(36),
  typed_diff_json jsonb NOT NULL,
  reason varchar(2000) NOT NULL,
  created_by_user_id varchar(36) NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL
);
CREATE TABLE runtime_context_policy_bindings (
  space_id varchar(36) NOT NULL REFERENCES spaces(id),
  scope_type varchar(32) NOT NULL,
  scope_id varchar(36) NOT NULL,
  active_version_id varchar(36) NOT NULL REFERENCES runtime_context_policy_versions(id),
  updated_by_user_id varchar(36) NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (space_id, scope_type, scope_id)
);
CREATE TABLE runtime_context_policy_audits (
  id varchar(36) PRIMARY KEY,
  space_id varchar(36) NOT NULL REFERENCES spaces(id),
  scope_type varchar(32) NOT NULL,
  scope_id varchar(36) NOT NULL,
  actor_user_id varchar(36) NOT NULL REFERENCES users(id),
  base_version_id varchar(36),
  new_version_id varchar(36) NOT NULL REFERENCES runtime_context_policy_versions(id),
  typed_diff_json jsonb NOT NULL,
  reason varchar(2000) NOT NULL,
  created_at timestamptz NOT NULL
);
`;

let container: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let repo: PgAuthRepository | undefined;
let available = false;

beforeAll(async () => {
  try {
    container = await getTestPostgres(__filename, { empty: true });
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await pool.query(SCHEMA);
    repo = new PgAuthRepository(pool);
    available = true;
  } catch (err) {
    if (!isTestPostgresUnavailableError(err)) throw err;
    console.warn(
      `[auth-repository] skipped — Docker/Postgres unavailable: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  if (!available || !pool) return;
  await pool.query(
    "TRUNCATE runtime_context_policy_audits, runtime_context_policy_bindings, runtime_context_policy_versions, note_collections, memory_entries, auth_accounts, user_sessions, space_memberships, spaces, users CASCADE",
  );
  await pool.query(
    `INSERT INTO users
       (id, email, display_name, avatar_url, last_login_at, created_at, updated_at)
     VALUES
       ('user-1', 'u@example.test', 'User One', NULL, NULL, now(), now()),
       ('user-2', 'v@example.test', 'User Two', NULL, NULL, now(), now())`,
  );
  await pool.query(
    `INSERT INTO spaces
       (id, name, type, created_by_user_id, created_at, updated_at)
     VALUES
       ('personal-1', 'Personal', 'personal', 'user-1', now() - interval '2 days', now()),
       ('team-1', 'Team', 'team', 'user-1', now() - interval '1 day', now()),
       ('other-1', 'Other', 'team', 'user-2', now(), now())`,
  );
  await pool.query(
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
  await pool!.query(
    `INSERT INTO user_sessions
       (id, user_id, token_hash, created_at, expires_at, last_seen_at)
     VALUES ($1, $2, $3, now(), now() + ($4::interval), NULL)`,
    [id, userId, createHash("sha256").update(raw).digest("hex"), expiresIn],
  );
}

describe("PgAuthRepository", () => {
  it("resolves a session cookie to the default personal space and touches last_seen_at", async () => {
    if (!available || !repo || !pool) return;

    const identity = await repo.resolveIdentity({ sessionToken: "raw-token" });

    expect(identity).toEqual({ ok: true, spaceId: "personal-1", userId: "user-1" });
    const touched = await pool.query("SELECT last_seen_at FROM user_sessions WHERE id = 'session-1'");
    expect(touched.rows[0].last_seen_at).not.toBeNull();
  });

  it("honors requested space only when the session user is an active member", async () => {
    if (!available || !repo) return;

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
    if (!available || !repo) return;

    const denied = await repo.resolveIdentity({ authorization: "Bearer ask_test" });

    expect(denied).toMatchObject({ ok: false, statusCode: 501 });
  });

  it("serves current user and space read models", async () => {
    if (!available || !repo) return;

    const user = await repo.getCurrentUser("raw-token");
    expect(user).toMatchObject({ id: "user-1", email: "u@example.test" });

    const spaces = await repo.getUserSpaces("user-1");
    expect(spaces.map((s) => s.id)).toEqual(["personal-1", "team-1"]);

    const space = await repo.getSpaceForUser("user-1", "team-1");
    expect(space).toMatchObject({ id: "team-1", role: "admin" });
  });

  it("creates a Google user with a personal space, default seeds, and a session", async () => {
    if (!available || !repo || !pool) return;

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

    const spaces = await pool.query("SELECT id, name, type, oversight_mode FROM spaces WHERE created_by_user_id = $1", [
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
    const membership = await pool.query(
      "SELECT role, status FROM space_memberships WHERE user_id = $1 AND space_id = $2",
      [user.id, spaceId],
    );
    expect(membership.rows[0]).toEqual({ role: "owner", status: "active" });
    expect((await pool.query("SELECT count(*)::int AS count FROM memory_entries WHERE space_id = $1", [spaceId])).rows[0].count).toBe(0);
    expect((await pool.query("SELECT count(*)::int AS count FROM note_collections WHERE space_id = $1", [spaceId])).rows[0].count).toBe(5);
    expect((await pool.query("SELECT count(*)::int AS count FROM runtime_context_policy_versions WHERE space_id = $1", [spaceId])).rows[0].count).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS count FROM user_sessions WHERE user_id = $1", [user.id])).rows[0].count).toBe(1);
  });
});
