import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { seedRun } from "./support/domainSeeds.js";
import { ROOT_BRANCH_PATH, childBranchPath, visibleMessagePathSql } from "../src/modules/sessions/messagePath.js";
import { PgSessionRepository } from "../src/modules/sessions/repository.js";

// Real-PostgreSQL integration tests for the server sessions repository. The unit
// suites use a fake that records arguments but never runs SQL, so they cannot
// catch the defects that only surface on the real stack: the required
// default columns (id/status/created_at/updated_at) a raw INSERT must supply,
// the ck_messages_role CHECK, jsonb param binding, varchar lengths, and the
// add-message + session-touch CTE. These run the actual SQL against a throwaway
//
// The suite skips gracefully when Docker is unavailable so `pnpm test` still runs
// everywhere; where Docker is present (dev, CI) it always runs.

let repo: PgSessionRepository | undefined;

const db = useTestDatabase(import.meta.filename, { max: 10 });

beforeAll(async () => {
  if (!db.available) return;
  repo = new PgSessionRepository(db.pool);
});

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["runs", "agent_versions", "agents", "sessions", "messages", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  await db.pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1, 'Main', 'personal', now(), now())`, [SPACE]);
  await db.pool.query(`INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ('user-1', 'user-1', 'active', now(), now()), ('user-2', 'user-2', 'active', now(), now()) ON CONFLICT (id) DO NOTHING`);
});

const SPACE = "space-1";
const USER = "user-1";

describe("PgSessionRepository against real Postgres", () => {
  it("creates a session supplying all NOT NULL default columns", async () => {
    if (!db.available || !repo) return;
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
    if (!db.available || !repo) return;
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
    if (!db.available || !repo) return;
    const created = await repo.createSession(SPACE, USER, {});

    const msg = await repo.addMessage(SPACE, USER, created.id, {
      role: "user",
      content: "hello there",
      metadata: { status: "v" },
    });
    expect(msg).toMatchObject({
      session_id: created.id,
      space_id: SPACE,
      user_id: USER,
      role: "user",
      content: "hello there",
      metadata_json: { status: "v" },
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
    if (!db.available || !repo) return;
    const created = await repo.createSession(SPACE, USER, {});

    await seedRun(db.pool!, {
      id: "run-1", space: SPACE, owner: USER, agent: "agent-1", version: "agent-version-1",
    });

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
    expect(first?.run_id).toBe("run-1");
    expect(await repo.listMessages(SPACE, USER, created.id, 100, 0)).toEqual([
      first,
    ]);
  });

  it("links each appended message to the one before it and advances the head", async () => {
    if (!db.available || !repo || !db.pool) return;
    const created = await repo.createSession(SPACE, USER, {});

    const first = await repo.addMessage(SPACE, USER, created.id, { role: "user", content: "one" });
    const second = await repo.addMessage(SPACE, USER, created.id, { role: "user", content: "two" });

    expect(first!.parent_message_id).toBeNull();
    expect(second!.parent_message_id).toBe(first!.id);

    const head = await db.pool.query<{ head_message_id: string | null }>(
      "SELECT head_message_id FROM sessions WHERE id = $1",
      [created.id],
    );
    expect(head.rows[0]?.head_message_id).toBe(second!.id);
  });

  it("reads the branch the head is on, not every row of the session", async () => {
    if (!db.available || !repo || !db.pool) return;
    const created = await repo.createSession(SPACE, USER, {});
    const root = await repo.addMessage(SPACE, USER, created.id, { role: "user", content: "root" });
    await repo.addMessage(SPACE, USER, created.id, { role: "assistant", content: "kept" });

    // A second child of the same parent: what an edit-and-resend or a
    // regenerate will write. Because it does not continue the tip it starts
    // its own branch, named by its own id. It is newer than `kept`, so a
    // transcript read ordered by time alone would show it — the path read
    // must not.
    const forkBranch = childBranchPath({
      parentBranchPath: ROOT_BRANCH_PATH,
      parentIsTip: false,
      childMessageId: "abandoned",
      parentDepth: 0,
    });
    await db.pool.query(
      `INSERT INTO messages
         (id, space_id, session_id, user_id, role, content, parent_message_id, path_depth, branch_path, created_at)
       VALUES ('abandoned', $1, $2, $3, 'assistant', 'abandoned branch', $4, 1, $5, now())`,
      [SPACE, created.id, USER, root!.id, forkBranch],
    );

    const visible = await repo.listMessages(SPACE, USER, created.id, 100, 0);
    expect(visible!.map((message) => message.content)).toEqual(["root", "kept"]);

    // Moving the head onto the other child swaps which branch is visible,
    // with no message row changed.
    await db.pool.query("UPDATE sessions SET head_message_id = 'abandoned' WHERE id = $1", [created.id]);
    const switched = await repo.listMessages(SPACE, USER, created.id, 100, 0);
    expect(switched!.map((message) => message.content)).toEqual(["root", "abandoned branch"]);
  });

  it("keeps one chain when several writers append to the same conversation at once", async () => {
    if (!db.available || !repo || !db.pool) return;
    const created = await repo.createSession(SPACE, USER, {});
    await repo.addMessage(SPACE, USER, created.id, { role: "user", content: "seed" });

    // Separate pools, so these are genuinely concurrent connections rather
    // than one client serialized by the driver. Each append derives its depth
    // from the head; under READ COMMITTED a writer that waited for the session
    // lock still holds a snapshot from before the other one committed, so
    // without `uq_messages_branch_position` and the retry around it two rows
    // would claim the same depth and one would fall off the path entirely.
    const pools = [
      new Pool({ connectionString: db.connectionUri, max: 5 }),
      new Pool({ connectionString: db.connectionUri, max: 5 }),
    ];
    try {
      await Promise.all(Array.from({ length: 8 }, (_unused, index) =>
        new PgSessionRepository(pools[index % 2]!)
          .addMessage(SPACE, USER, created.id, { role: "user", content: `m${index}` })));
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
    }

    const visible = await repo.listMessages(SPACE, USER, created.id, 100, 0);
    expect(visible).toHaveLength(9);
    const stored = await db.pool.query<{ path_depth: number }>(
      "SELECT path_depth FROM messages WHERE session_id = $1", [created.id]);
    expect(new Set(stored.rows.map((row) => row.path_depth)).size).toBe(9);
  });

  it("keeps an Agent reply that lost the race for its position on the branch", async () => {
    if (!db.available || !repo || !db.pool) return;
    await seedRun(db.pool, {
      id: "run-race", space: SPACE, owner: USER, agent: "agent-race", version: "agent-version-race",
    });
    const created = await repo.createSession(SPACE, USER, {});
    await repo.addMessage(SPACE, USER, created.id, { role: "user", content: "seed" });

    // The reply's insert carries `ON CONFLICT DO NOTHING` for its own
    // idempotency (one reply per Run). Untargeted, that clause would also
    // absorb a branch-position collision — which reads as "already written"
    // and returns null, dropping the reply instead of retrying for the next
    // free position.
    const pools = [
      new Pool({ connectionString: db.connectionUri, max: 4 }),
      new Pool({ connectionString: db.connectionUri, max: 4 }),
    ];
    try {
      await Promise.all([
        new PgSessionRepository(pools[0]!)
          .addAssistantMessageForRun(SPACE, USER, created.id, "run-race", { content: "the reply" }),
        ...Array.from({ length: 3 }, (_unused, index) =>
          new PgSessionRepository(pools[1]!)
            .addMessage(SPACE, USER, created.id, { role: "user", content: `u${index}` })),
      ]);
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
    }

    const reply = await db.pool.query("SELECT id FROM messages WHERE run_id = $1", ["run-race"]);
    expect(reply.rowCount).toBe(1);
    expect(await repo.listMessages(SPACE, USER, created.id, 100, 0)).toHaveLength(5);
  });

  it("appends concurrently from inside transactions without a single collision", async () => {
    if (!db.available || !repo || !db.pool) return;
    const created = await repo.createSession(SPACE, USER, {});
    await repo.addMessage(SPACE, USER, created.id, { role: "user", content: "seed" });

    // The transactional callers are the ones a collision would be fatal for:
    // a failed statement poisons their transaction, so the retry cannot save
    // them. The append lock has to prevent the collision outright, and this
    // asserts it does at a contention level well past anything real.
    const pools = Array.from({ length: 4 }, () =>
      new Pool({ connectionString: db.connectionUri, max: 6 }));
    try {
      await Promise.all(Array.from({ length: 16 }, async (_unused, index) => {
        const client = await pools[index % pools.length]!.connect();
        try {
          await client.query("BEGIN");
          await new PgSessionRepository(client)
            .addMessage(SPACE, USER, created.id, { role: "user", content: `t${index}` });
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => {});
          throw error;
        } finally {
          client.release();
        }
      }));
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
    }

    expect(await repo.listMessages(SPACE, USER, created.id, 100, 0)).toHaveLength(17);
    const depths = await db.pool.query<{ n: string }>(
      "SELECT count(DISTINCT path_depth)::text AS n FROM messages WHERE session_id = $1", [created.id]);
    expect(depths.rows[0]!.n).toBe("17");
  });

  it("reads one page of a long conversation without walking all of it", async () => {
    if (!db.available || !repo || !db.pool) return;
    const created = await repo.createSession(SPACE, USER, {});
    // A linear conversation long enough that a per-page full walk shows up as
    // an order-of-magnitude difference in buffers touched.
    await db.pool.query(
      `INSERT INTO messages
         (id, space_id, session_id, user_id, role, content, parent_message_id, path_depth, branch_path, created_at)
       SELECT 'seq' || lpad(i::text, 5, '0'), $1, $2, $3, 'user', 'body ' || i,
              CASE WHEN i = 0 THEN NULL ELSE 'seq' || lpad((i - 1)::text, 5, '0') END,
              i, $4, now() + (i || ' seconds')::interval
         FROM generate_series(0, 4999) i`,
      [SPACE, created.id, USER, ROOT_BRANCH_PATH],
    );
    await db.pool.query("UPDATE sessions SET head_message_id = 'seq04999' WHERE id = $1", [created.id]);
    await db.pool.query("ANALYZE messages");
    await db.pool.query("ANALYZE sessions");

    const page = await repo.listMessages(SPACE, USER, created.id, 20, 0);
    expect(page).toHaveLength(20);
    expect(page!.at(-1)!.content).toBe("body 4999");

    // The cost of a page must not scale with the conversation. A read that
    // walked `parent_message_id` per page touched ~15000 buffers here; the
    // materialized path answers the same page from the index.
    const plan = await db.pool.query<{ "QUERY PLAN": string }>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
       SELECT m.id FROM messages m
        WHERE m.session_id = $1 AND m.space_id = $2
          AND ${visibleMessagePathSql({ alias: "m", spaceParam: "$2", sessionParam: "$1" })}
        ORDER BY m.path_depth DESC, m.id DESC LIMIT 20`,
      [created.id, SPACE],
    );
    const buffers = JSON.stringify(plan.rows[0]).match(/"Shared Hit Blocks":\s*(\d+)/g) ?? [];
    const worst = Math.max(...buffers.map((entry) => Number(entry.split(":")[1])));
    expect(worst).toBeLessThan(500);
  });

  it("refuses to append to a session the user cannot see (null, no insert)", async () => {
    if (!db.available || !repo || !db.pool) return;
    const created = await repo.createSession(SPACE, USER, {});

    const denied = await repo.addMessage(SPACE, "user-2", created.id, {
      role: "user",
      content: "should not land",
    });
    expect(denied).toBeNull();

    const count = await db.pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM messages",
    );
    expect(count.rows[0]?.n).toBe("0");
  });

  it("enforces the ck_messages_role CHECK from the real schema", async () => {
    if (!db.available || !repo) return;
    const created = await repo.createSession(SPACE, USER, {});

    await expect(
      repo.addMessage(SPACE, USER, created.id, {
        role: "not-a-valid-role",
        content: "x",
      }),
    ).rejects.toThrow();
  });

  it("404s message listing for a session the user cannot see", async () => {
    if (!db.available || !repo) return;
    const owned = await repo.createSession(SPACE, USER, {});
    // A different user cannot list the owner's messages.
    expect(await repo.listMessages(SPACE, "user-2", owned.id, 100, 0)).toBeNull();
  });

  it("returns recent messages for context in chronological order", async () => {
    if (!db.available || !repo) return;
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
