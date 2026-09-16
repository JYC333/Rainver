import { describe, expect, it } from "vitest";
import {
  conversationRetryFingerprint,
  withConversationRetryIdempotency,
} from "../src/modules/sessions/conversationRetry.js";
import type { Queryable } from "../src/modules/sessions/repository.js";

function idempotencyDb(): Queryable & { stored: { request_fingerprint: string; response_json: string } | null } {
  const db = {
    stored: null as { request_fingerprint: string; response_json: string } | null,
    async query<Row = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
      if (sql.includes("SELECT request_fingerprint")) {
        return {
          rows: db.stored ? [db.stored] : [],
          rowCount: db.stored ? 1 : 0,
        } as { rows: Row[]; rowCount: number };
      }
      if (sql.includes("INSERT INTO conversation_turn_idempotencies")) {
        db.stored = {
          request_fingerprint: String(params[3]),
          response_json: String(params[7]),
        };
      }
      return { rows: [], rowCount: 0 } as { rows: Row[]; rowCount: number };
    },
  };
  return db;
}

const input = {
  spaceId: "space-1",
  userId: "user-1",
  key: "retry-click-1",
  fingerprint: conversationRetryFingerprint({ kind: "direct", runId: "run-1", sessionId: "session-1" }),
  sessionId: "session-1",
  messageId: "message-1",
  runId: "run-1",
};

describe("conversation retry idempotency", () => {
  it("replays the first response without running the retry twice", async () => {
    const db = idempotencyDb();
    let workCount = 0;
    const first = await withConversationRetryIdempotency(db, input, async () => {
      workCount += 1;
      return { run_id: "retry-run-1", run_ids: ["retry-run-1"] };
    });
    const second = await withConversationRetryIdempotency(db, input, async () => {
      workCount += 1;
      return { run_id: "retry-run-2", run_ids: ["retry-run-2"] };
    });

    expect(first).toEqual({
      value: { run_id: "retry-run-1", run_ids: ["retry-run-1"] },
      reused: false,
    });
    expect(second).toEqual(first && { ...first, reused: true });
    expect(workCount).toBe(1);
  });

  it("rejects reuse of a key for another original Run", async () => {
    const db = idempotencyDb();
    await withConversationRetryIdempotency(db, input, async () => ({ ok: true }));

    await expect(withConversationRetryIdempotency(db, {
      ...input,
      fingerprint: conversationRetryFingerprint({ kind: "direct", runId: "run-2", sessionId: "session-1" }),
    }, async () => ({ ok: false }))).rejects.toMatchObject({ statusCode: 409 });
  });
});
