import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPostgres, isTestPostgresUnavailableError, type TestPostgresDatabase } from "./support/sharedPostgres";
import { resetTables } from "./support/resetTables";
import { PgSessionRepository } from "../src/modules/sessions/repository";

// Real-PostgreSQL integration tests for the server sessions repository. The unit
// suites use a fake that records arguments but never runs SQL, so they cannot
// catch the defects that only surface on the real stack: the required
// default columns (id/status/created_at/updated_at) a raw INSERT must supply,
// the ck_messages_role CHECK, jsonb param binding, varchar lengths, and the
// add-message + session-touch CTE. These run the actual SQL against a throwaway
// Postgres (testcontainers) loaded with test/fixtures/sessionsSchema.sql.
//
// The suite skips gracefully when Docker is unavailable so `pnpm test` still runs
// everywhere; where Docker is present (dev, CI) it always runs.

const SCHEMA = readFileSync(
  join(process.cwd(), "test/fixtures/sessionsSchema.sql"),
  "utf8",
);

let container: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let repo: PgSessionRepository | undefined;
let available = false;

beforeAll(async () => {
  try {
    container = await getTestPostgres(__filename, { empty: true });
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await pool.query(SCHEMA);
    repo = new PgSessionRepository(pool);
    available = true;
  } catch (err) {
    if (!isTestPostgresUnavailableError(err)) throw err;
    console.warn(
      `[sessions-integration] skipped — Docker/Postgres unavailable: ${
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
  await resetTables(pool, ["sessions", "messages"], { cascade: true });
});

const SPACE = "space-1";
const USER = "user-1";

describe("PgSessionRepository against real Postgres", () => {
  it("creates a session supplying all NOT NULL default columns", async () => {
    if (!available || !repo) return;
    const out = await repo.createSession(SPACE, USER, {
      title: "new chat",
      projectFolderId: null,
      metadata: { source: "test" },
    });

    expect(out.id).toMatch(/[0-9a-f-]{36}/);
    expect(out).toMatchObject({
      space_id: SPACE,
      user_id: USER,
      title: "new chat",
      status: "active",
    });
    // created_at == updated_at on create.
    expect(out.created_at).toEqual(out.updated_at);
  });

  it("round-trips create -> get -> list with space/user scoping", async () => {
    if (!available || !repo) return;
    const created = await repo.createSession(SPACE, USER, {});

    expect(await repo.getSession(SPACE, USER, created.id)).toMatchObject({
      id: created.id,
    });
    // Wrong space or wrong user cannot see it.
    expect(await repo.getSession("space-2", USER, created.id)).toBeNull();
    expect(await repo.getSession(SPACE, "user-2", created.id)).toBeNull();

    const page = await repo.listSessions(SPACE, USER, 50, 0);
    expect(page.total).toBe(1);
    expect(page.items[0]?.id).toBe(created.id);
    // A different user in the same space sees none.
    expect((await repo.listSessions(SPACE, "user-2", 50, 0)).total).toBe(0);
  });

  it("appends a message, touches the session, and returns it", async () => {
    if (!available || !repo) return;
    const created = await repo.createSession(SPACE, USER, {});

    const msg = await repo.addMessage(SPACE, USER, created.id, {
      role: "user",
      content: "hello there",
      metadata: { k: "v" },
    });
    expect(msg).toMatchObject({
      session_id: created.id,
      space_id: SPACE,
      user_id: USER,
      role: "user",
      content: "hello there",
      metadata_json: { k: "v" },
    });

    const messages = await repo.listMessages(SPACE, USER, created.id, 100, 0);
    expect(messages).toHaveLength(1);
    expect(messages![0]?.id).toBe(msg!.id);

    // updated_at was bumped past the original (the CTE touch ran).
    const after = await repo.getSession(SPACE, USER, created.id);
    expect(new Date(after!.updated_at).getTime()).toBeGreaterThanOrEqual(
      new Date(created.updated_at).getTime(),
    );
  });

  it("persists at most one assistant message for a retried chat Run", async () => {
    if (!available || !repo) return;
    const created = await repo.createSession(SPACE, USER, {});

    const first = await repo.addAssistantMessageForRun(
      SPACE,
      USER,
      created.id,
      "run-1",
      { content: "durable reply", metadata: { artifact_refs: ["artifact-1"] } },
    );
    const retried = await repo.addAssistantMessageForRun(
      SPACE,
      USER,
      created.id,
      "run-1",
      { content: "must not replace the durable reply" },
    );

    expect(retried).toEqual(first);
    expect(await repo.listMessages(SPACE, USER, created.id, 100, 0)).toEqual([
      first,
    ]);
  });

  it("refuses to append to a session the user cannot see (null, no insert)", async () => {
    if (!available || !repo || !pool) return;
    const created = await repo.createSession(SPACE, USER, {});

    const denied = await repo.addMessage(SPACE, "user-2", created.id, {
      role: "user",
      content: "should not land",
    });
    expect(denied).toBeNull();

    const count = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM messages",
    );
    expect(count.rows[0]?.n).toBe("0");
  });

  it("enforces the ck_messages_role CHECK from the real schema", async () => {
    if (!available || !repo) return;
    const created = await repo.createSession(SPACE, USER, {});

    await expect(
      repo.addMessage(SPACE, USER, created.id, {
        role: "not-a-valid-role",
        content: "x",
      }),
    ).rejects.toThrow();
  });

  it("404s message listing for a session the user cannot see", async () => {
    if (!available || !repo) return;
    const owned = await repo.createSession(SPACE, USER, {});
    // A different user cannot list the owner's messages.
    expect(await repo.listMessages(SPACE, "user-2", owned.id, 100, 0)).toBeNull();
  });

  it("returns recent messages for context in chronological order", async () => {
    if (!available || !repo) return;
    const created = await repo.createSession(SPACE, USER, {});
    await repo.addMessage(SPACE, USER, created.id, {
      role: "user",
      content: "one",
    });
    await repo.addMessage(SPACE, USER, created.id, {
      role: "assistant",
      content: "two",
    });
    await repo.addMessage(SPACE, USER, created.id, {
      role: "user",
      content: "three",
    });

    const recent = await repo.listRecentMessagesForContext(
      SPACE,
      USER,
      created.id,
      2,
    );
    expect(recent?.map((msg) => msg.content)).toEqual(["two", "three"]);
    expect(
      await repo.listRecentMessagesForContext(SPACE, "user-2", created.id, 2),
    ).toBeNull();
  });

});
