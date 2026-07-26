import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPostgres, type TestPostgresDatabase } from "./support/sharedPostgres";
import { PgSessionRepository } from "../src/modules/sessions/repository";

// Real-PostgreSQL integration tests for the server sessions repository. The unit
// suites use a fake that records arguments but never runs SQL, so they cannot
// catch the defects that only surface on the real stack: the required
// default columns (id/status/created_at/updated_at) a raw INSERT must supply,
// the ck_messages_role CHECK, jsonb param binding, varchar lengths, and the
// add-message + session-touch CTE. These run the actual SQL against a throwaway
// Postgres (testcontainers) loaded with test/fixtures/sessionsSchema.sql.
//
// The suite skips gracefully when Docker is unavailable so `npm test` still runs
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
  await pool.query("TRUNCATE sessions, messages, session_summaries CASCADE");
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

  it("returns the latest active session summary scoped to the session space", async () => {
    if (!available || !repo || !pool) return;
    const created = await repo.createSession(SPACE, USER, {});
    const first = await repo.addMessage(SPACE, USER, created.id, {
      role: "user",
      content: "first",
    });
    const last = await repo.addMessage(SPACE, USER, created.id, {
      role: "assistant",
      content: "last",
    });
    await pool.query(
      `INSERT INTO session_summaries
         (id, space_id, session_id, user_id, version, status, summary_text,
          source_message_count, source_first_message_id, source_last_message_id,
          condenser_version, created_at)
       VALUES
         ('summary-v1', $1, $2, $3, 1, 'superseded', 'old summary', 0, NULL, NULL, 'pattern.v1', now()),
         ('summary-v2', $1, $2, $3, 2, 'active', 'latest summary', 2, $4, $5, 'pattern.v1', now())`,
      [SPACE, created.id, USER, first?.id, last?.id],
    );

    expect(await repo.getLatestSummaryForContext(SPACE, created.id)).toEqual({
      id: "summary-v2",
      session_id: created.id,
      version: 2,
      summary_text: "latest summary",
      source_message_count: 2,
      source_first_message_id: first?.id,
      source_last_message_id: last?.id,
      condenser_version: "pattern.v1",
    });
    expect(await repo.getLatestSummaryForContext("space-2", created.id)).toBeNull();
  });

  it("condenseSession is a no-op until enough messages age past the recent tail", async () => {
    if (!available || !repo) return;
    const created = await repo.createSession(SPACE, USER, {});
    // keepRecent=4, condenseBatch=2: nothing aged out yet with 3 messages.
    for (let i = 0; i < 3; i += 1) {
      await repo.addMessage(SPACE, USER, created.id, {
        role: i % 2 === 0 ? "user" : "assistant",
        content: `message ${i}`,
      });
    }
    const noop = await repo.condenseSession(SPACE, USER, created.id, {
      keepRecent: 4,
      condenseBatch: 2,
    });
    expect(noop).toBeNull();
    expect(await repo.getLatestSummaryForContext(SPACE, created.id)).toBeNull();
  });

  it("condenseSession writes one active summary covering aged-out messages", async () => {
    if (!available || !repo) return;
    const created = await repo.createSession(SPACE, USER, {});
    const ids: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      const msg = await repo.addMessage(SPACE, USER, created.id, {
        role: i % 2 === 0 ? "user" : "assistant",
        content: `message about deployment number ${i}`,
      });
      ids.push(msg!.id);
    }

    // keepRecent=4 → summarize the oldest 4 (ids[0..3]).
    const summary = await repo.condenseSession(SPACE, USER, created.id, {
      keepRecent: 4,
      condenseBatch: 2,
    });
    expect(summary).not.toBeNull();
    expect(summary!.version).toBe(1);
    expect(summary!.source_message_count).toBe(4);
    expect(summary!.source_first_message_id).toBe(ids[0]);
    expect(summary!.source_last_message_id).toBe(ids[3]);
    expect(summary!.condenser_version).toBe("pattern.v1");

    const latest = await repo.getLatestSummaryForContext(SPACE, created.id);
    expect(latest).toEqual(summary);
  });

  it("condenseSession supersedes the prior summary and bumps the version", async () => {
    if (!available || !repo || !pool) return;
    const created = await repo.createSession(SPACE, USER, {});
    for (let i = 0; i < 6; i += 1) {
      await repo.addMessage(SPACE, USER, created.id, {
        role: i % 2 === 0 ? "user" : "assistant",
        content: `first batch message ${i}`,
      });
    }
    const v1 = await repo.condenseSession(SPACE, USER, created.id, {
      keepRecent: 2,
      condenseBatch: 2,
    });
    expect(v1!.version).toBe(1);
    expect(v1!.source_message_count).toBe(4);

    // Add 4 more so 4 new messages age past the recent tail.
    for (let i = 0; i < 4; i += 1) {
      await repo.addMessage(SPACE, USER, created.id, {
        role: i % 2 === 0 ? "user" : "assistant",
        content: `second batch message ${i}`,
      });
    }
    const v2 = await repo.condenseSession(SPACE, USER, created.id, {
      keepRecent: 2,
      condenseBatch: 2,
    });
    expect(v2!.version).toBe(2);
    expect(v2!.source_message_count).toBe(8);

    // Exactly one active summary remains (partial unique active index holds).
    const active = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM session_summaries
        WHERE session_id = $1 AND status = 'active'`,
      [created.id],
    );
    expect(active.rows[0]?.n).toBe("1");
    expect(await repo.getLatestSummaryForContext(SPACE, created.id)).toEqual(v2);
  });

  it("condenseSession excludes whitespace-only messages from the count and slice", async () => {
    if (!available || !repo) return;
    const created = await repo.createSession(SPACE, USER, {});
    const real1 = await repo.addMessage(SPACE, USER, created.id, {
      role: "user",
      content: "real one",
    });
    await repo.addMessage(SPACE, USER, created.id, { role: "assistant", content: "   " });
    const real2 = await repo.addMessage(SPACE, USER, created.id, {
      role: "user",
      content: "real two",
    });
    await repo.addMessage(SPACE, USER, created.id, { role: "assistant", content: "\n\t " });
    await repo.addMessage(SPACE, USER, created.id, { role: "user", content: "real three" });
    await repo.addMessage(SPACE, USER, created.id, { role: "assistant", content: "real four" });

    // 4 non-whitespace messages, keepRecent=2 → summarize the oldest 2 of them.
    const summary = await repo.condenseSession(SPACE, USER, created.id, {
      keepRecent: 2,
      condenseBatch: 2,
    });
    expect(summary).not.toBeNull();
    // The two blank messages must not inflate the count or shift the range.
    expect(summary!.source_message_count).toBe(2);
    expect(summary!.source_first_message_id).toBe(real1!.id);
    expect(summary!.source_last_message_id).toBe(real2!.id);
  });

  it("condenseSession uses the LLM summarizer (llm.v1) with the scenario profile", async () => {
    if (!available || !repo) return;
    const created = await repo.createSession(SPACE, USER, {});
    for (let i = 0; i < 8; i += 1) {
      await repo.addMessage(SPACE, USER, created.id, {
        role: i % 2 === 0 ? "user" : "assistant",
        content: `message ${i}`,
      });
    }
    let seenSystem = "";
    let seenResolverProfile: string | null | undefined;
    let seenResolverMessages: readonly { content: string }[] = [];
    const summary = await repo.condenseSession(SPACE, USER, created.id, {
      keepRecent: 4,
      condenseBatch: 2,
      profile: "coding",
      condenserPromptResolver: async (input) => {
        seenResolverProfile = input.profile;
        seenResolverMessages = input.messages;
        const prompt = {
          system: "registry condenser coding system",
          user: `registry condenser user prompt: ${input.messages.map((message) => message.content).join(", ")}`,
        };
        return {
          ...prompt,
          resolveResult: {
            asset_key: "session.condenser.coding",
            version_id: "condenser-version",
            content_hash: "condenser-hash",
            scope_type: "system",
            scope_id: null,
            resolution_trace: ["system_baseline"],
            fallback_reason: null,
            rendered_messages: [
              { role: "system", content: prompt.system },
              { role: "user", content: prompt.user },
            ],
            rendered_text: null,
            rendered_hash: "rendered-hash",
            validation_warnings: [],
            validation_errors: [],
          },
        } as never;
      },
      summarize: async (prompt) => {
        seenSystem = prompt.system;
        return "LLM running summary.";
      },
    });
    expect(summary!.condenser_version).toBe("llm.v1");
    expect(summary!.summary_text).toBe("LLM running summary.");
    expect(summary!.source_message_count).toBe(4);
    expect(seenSystem).toContain("coding");
    expect(seenResolverProfile).toBe("coding");
    expect(seenResolverMessages.map((message) => message.content)).toEqual([
      "message 0",
      "message 1",
      "message 2",
      "message 3",
    ]);
    const stored = await pool!.query<{ summary_json: { prompts?: Record<string, unknown> } }>(
      "SELECT summary_json FROM session_summaries WHERE id = $1",
      [summary!.id],
    );
    expect(stored.rows[0]?.summary_json.prompts?.condenser).toMatchObject({
      asset_key: "session.condenser.coding",
      version_id: "condenser-version",
      content_hash: "condenser-hash",
    });

    const latest = await repo.getLatestSummaryForContext(SPACE, created.id);
    expect(latest!.condenser_version).toBe("llm.v1");
    expect(latest!.summary_text).toBe("LLM running summary.");
  });

  it("condenseSession falls back to pattern.v1 when the summarizer fails or is empty", async () => {
    if (!available || !repo) return;
    const created = await repo.createSession(SPACE, USER, {});
    for (let i = 0; i < 8; i += 1) {
      await repo.addMessage(SPACE, USER, created.id, {
        role: i % 2 === 0 ? "user" : "assistant",
        content: `message ${i}`,
      });
    }
    const thrown = await repo.condenseSession(SPACE, USER, created.id, {
      keepRecent: 4,
      condenseBatch: 2,
      summarize: async () => {
        throw new Error("provider down");
      },
    });
    expect(thrown!.condenser_version).toBe("pattern.v1");
    expect(thrown!.summary_text).toContain("Earlier conversation condensed");

    // Empty LLM text also falls back (next batch).
    for (let i = 8; i < 12; i += 1) {
      await repo.addMessage(SPACE, USER, created.id, {
        role: i % 2 === 0 ? "user" : "assistant",
        content: `message ${i}`,
      });
    }
    const empty = await repo.condenseSession(SPACE, USER, created.id, {
      keepRecent: 4,
      condenseBatch: 2,
      summarize: async () => "   ",
    });
    expect(empty!.condenser_version).toBe("pattern.v1");
  });

  it("condenseSession refuses a session the user cannot see", async () => {
    if (!available || !repo) return;
    const created = await repo.createSession(SPACE, USER, {});
    for (let i = 0; i < 8; i += 1) {
      await repo.addMessage(SPACE, USER, created.id, {
        role: i % 2 === 0 ? "user" : "assistant",
        content: `message ${i}`,
      });
    }
    expect(
      await repo.condenseSession(SPACE, "user-2", created.id, {
        keepRecent: 2,
        condenseBatch: 2,
      }),
    ).toBeNull();
  });
});
