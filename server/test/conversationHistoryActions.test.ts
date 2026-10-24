import { beforeEach, describe, expect, it } from "vitest";
import { ConversationHistoryService } from "../src/modules/sessions/conversationHistorySystemActionExecutors.js";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { seedConversationMessages } from "./support/domainSeeds.js";

const db = useTestDatabase(import.meta.filename, { max: 2 });

describe("conversation.search / conversation.read (real PostgreSQL)", () => {
  beforeEach(async () => {
    if (!db.available) return;
    await resetTables(db.pool, ["spaces", "users"], { cascade: true });
    await db.pool.query(
      `INSERT INTO users (id, display_name, status, created_at, updated_at, email, registration_source)
       VALUES ('user-1', 'Owner', 'active', now(), now(), 'owner@test.invalid', 'system')`,
    );
    await db.pool.query(
      `INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at)
       VALUES ('space-1', 'Space', 'personal', 'user-1', now(), now())`,
    );
    await db.pool.query(
      `INSERT INTO sessions (id, space_id, user_id, agent_id, title, status, created_at, updated_at)
       VALUES ('session-1', 'space-1', 'user-1', NULL, 'Thread', 'active', now(), now()),
              ('session-2', 'space-1', 'user-1', NULL, 'Other', 'active', now(), now())`,
    );
    await seedConversationMessages(db.pool, {
      space: "space-1",
      session: "session-1",
      messages: [
        { id: "m-1", role: "user", content: "Please rename the lexer module to tokenizer.", userId: "user-1", createdAt: "2026-10-01T10:00:00.000Z" },
        { id: "m-2", role: "assistant", content: "Renamed src/lexer.ts to src/tokenizer.ts and updated the imports.", createdAt: "2026-10-01T10:05:00.000Z" },
        { id: "m-3", role: "user", content: "Now the tests.", userId: "user-1", createdAt: "2026-10-02T09:00:00.000Z" },
      ],
    });
    await seedConversationMessages(db.pool, {
      space: "space-1",
      session: "session-2",
      messages: [{ id: "m-other", role: "user", content: "The tokenizer in another conversation.", userId: "user-1" }],
    });
  });

  it("finds matches only in its own conversation, newest first, with bounded excerpts", async (ctx) => {
    if (!db.available) return ctx.skip();
    const service = new ConversationHistoryService(db.pool);
    const found = await service.search({ spaceId: "space-1", sessionId: "session-1", request: { query: "tokenizer", max_results: 20 } });
    expect(found.truncated).toBe(false);
    expect(found.hits.map((hit) => hit.id)).toEqual(["m-2", "m-1"]);
    expect(found.hits[0]).toMatchObject({ kind: "message", role: "assistant" });
    expect(found.hits[0]!.excerpt).toContain("src/tokenizer.ts");
    // A LIKE wildcard in the query is a character to find, not a pattern.
    const literal = await service.search({ spaceId: "space-1", sessionId: "session-1", request: { query: "%", max_results: 20 } });
    expect(literal.hits).toHaveLength(0);
    const windowed = await service.search({
      spaceId: "space-1", sessionId: "session-1",
      request: { query: "the", since: "2026-10-02T00:00:00.000Z", max_results: 20 },
    });
    expect(windowed.hits.map((hit) => hit.id)).toEqual(["m-3"]);
  });

  it("reads whole messages by id or window and says when it stopped", async (ctx) => {
    if (!db.available) return ctx.skip();
    const service = new ConversationHistoryService(db.pool);
    const byId = await service.read({ spaceId: "space-1", sessionId: "session-1", request: { message_ids: ["m-2", "m-other"], max_messages: 20 } });
    expect(byId.messages.map((message) => message.id)).toEqual(["m-2"]);
    expect(byId.messages[0]!.content).toContain("updated the imports");
    const window = await service.read({
      spaceId: "space-1", sessionId: "session-1",
      request: { since: "2026-10-01T00:00:00.000Z", until: "2026-10-01T23:59:59.000Z", max_messages: 1 },
    });
    expect(window.messages.map((message) => message.id)).toEqual(["m-1"]);
    expect(window.truncated).toBe(true);
    await expect(service.read({ spaceId: "space-1", sessionId: "session-1", request: { max_messages: 20 } }))
      .rejects.toMatchObject({ statusCode: 422 });
  });
});
