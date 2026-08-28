import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, buildAmbientRecords, redactAmbientText, supportsAmbientImport } from "../src/ambientSessions.js";

/**
 * The update shapes here are taken from a real replay of each runtime, run
 * against this machine's own installations on 2026-08-28: Claude and OpenCode
 * split message text across chunks sharing a `messageId`, Codex numbers its
 * ids `item-N` per session, and all three send a `tool_call` followed by
 * `tool_call_update`s carrying the result in full.
 */
function chunk(kind: string, messageId: string, text: string): Record<string, unknown> {
  return { sessionUpdate: kind, messageId, content: { type: "text", text } };
}

describe("ambient record building", () => {
  it("joins message chunks that share a message id into one record", () => {
    const { records } = buildAmbientRecords([
      chunk("user_message_chunk", "msg-1", "review the "),
      chunk("user_message_chunk", "msg-1", "branch diff"),
      chunk("agent_message_chunk", "msg-2", "Reading the diff now."),
    ]);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ kind: "user_message", text: "review the branch diff" });
    expect(records[1]).toMatchObject({ kind: "agent_message", text: "Reading the diff now." });
  });

  it("folds a tool call and its updates into one record and keeps only a label of the result", () => {
    const { records } = buildAmbientRecords([
      { sessionUpdate: "tool_call", toolCallId: "call-1", title: "Bash", status: "pending", rawInput: { command: "pnpm test" } },
      { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed", rawOutput: "x".repeat(50_000) },
    ]);
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record).toMatchObject({ kind: "tool_call", tool_name: "Bash", tool_status: "completed" });
    expect(record.tool_input).toContain("pnpm test");
    // The result is a label, not a copy: it is the bulk of a session's bytes
    // and the usual home of a leaked key.
    expect(Buffer.byteLength(record.tool_output!, "utf8")).toBeLessThanOrEqual(DEFAULT_LIMITS.tool_output_max_bytes);
    expect(record.truncated).toBe(true);
  });

  it("drops thoughts, which are reasoning rather than conclusion and the least stable part across runtimes", () => {
    const { records } = buildAmbientRecords([
      { sessionUpdate: "agent_thought_chunk", messageId: "t-1", content: { type: "text", text: "The user wants…" } },
      chunk("agent_message_chunk", "msg-1", "Here is the answer."),
    ]);
    expect(records.map((record) => record.kind)).toEqual(["agent_message"]);
  });

  it("keeps an unmodelled update raw rather than losing it while the source still exists", () => {
    const { records } = buildAmbientRecords([
      { sessionUpdate: "some_future_update", payload: { a: 1 } },
    ]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: "unknown" });
    expect(records[0]!.raw_json).toContain("some_future_update");
  });

  it("keeps only the last plan, since earlier revisions are superseded by it", () => {
    const { records } = buildAmbientRecords([
      { sessionUpdate: "plan", entries: [{ content: "first" }] },
      { sessionUpdate: "plan", entries: [{ content: "second" }] },
    ]);
    const plans = records.filter((record) => record.kind === "plan");
    expect(plans).toHaveLength(1);
    expect(plans[0]!.raw_json).toContain("second");
    expect(plans[0]!.raw_json).not.toContain("first");
  });

  it("forwards reported token usage separately from records", () => {
    const { records, usage } = buildAmbientRecords([
      { sessionUpdate: "usage_update", usage: { inputTokens: 100, outputTokens: 20, cachedReadTokens: 5 }, model: "claude-x" },
    ]);
    expect(records).toHaveLength(0);
    expect(usage).toEqual([expect.objectContaining({
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 5,
      model: "claude-x",
    })]);
  });

  it("gives Codex's per-session ids record keys that carry their session scope", () => {
    // `item-1` repeats in every Codex session, which is why the server's
    // identity is (session, key) and never the key alone. The daemon's job is
    // only to report the key it was given, unchanged.
    const { records } = buildAmbientRecords([chunk("user_message_chunk", "item-1", "hello")]);
    expect(records[0]!.record_key).toBe("message:item-1");
  });

  it("drops a record that trimming leaves with nothing in it", () => {
    const { records } = buildAmbientRecords([chunk("agent_message_chunk", "msg-1", "   ")]);
    expect(records).toHaveLength(0);
  });
});

describe("redaction", () => {
  it("removes recognisable key shapes before anything leaves the machine", () => {
    const redacted = redactAmbientText([
      "export ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnop",
      "token: ghp_abcdefghijklmnopqrstuvwxyz0123",
      "Authorization: Bearer abcdefghijklmnopqrstuvwx",
      "postgres://user:hunter2@db.internal:5432/app",
    ].join("\n"));
    expect(redacted).not.toContain("sk-ant-api03-abcdefghijklmnop");
    expect(redacted).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
    expect(redacted).not.toContain("hunter2");
    expect(redacted).toContain("[redacted]");
  });

  it("leaves ordinary prose alone", () => {
    const text = "The control group here is wrong, and the token budget is 200k.";
    expect(redactAmbientText(text)).toBe(text);
  });

  it("redacts inside a tool call's arguments, which is where a key usually appears", () => {
    const { records } = buildAmbientRecords([
      { sessionUpdate: "tool_call", toolCallId: "c1", title: "Bash", rawInput: { command: "curl -H 'x: sk-ant-api03-zzzzzzzzzzzz'" } },
    ]);
    expect(records[0]!.tool_input).not.toContain("sk-ant-api03-zzzzzzzzzzzz");
  });
});

describe("capability gate", () => {
  it("requires both listing and loading, because either alone cannot produce an import", () => {
    expect(supportsAmbientImport({
      agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } },
    })).toBe(true);
    expect(supportsAmbientImport({
      agentCapabilities: { loadSession: true, sessionCapabilities: {} },
    })).toBe(false);
    expect(supportsAmbientImport({
      agentCapabilities: { loadSession: false, sessionCapabilities: { list: {} } },
    })).toBe(false);
    expect(supportsAmbientImport({})).toBe(false);
  });
});

describe("enumeration versus selection", () => {
  /**
   * The distinction this covers is the one that decides whether an import's
   * source counts as deleted. `held` answers "what does this machine still
   * have for the folder"; `selected` answers "what should this sync replay".
   * Conflating them marks a session outside the 30-day window as gone while
   * it is sitting on disk.
   */
  it("reports a session outside the window as still held, while not replaying it", async () => {
    const { listSessionsForTest } = await import("../src/ambientSessions.js")
    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString()
    const recent = new Date().toISOString()
    const enumeration = await listSessionsForTest(
      [
        { sessionId: "old", cwd: "/work", updatedAt: old },
        { sessionId: "new", cwd: "/work", updatedAt: recent },
      ],
      "/work",
      50,
      30,
    )
    expect(enumeration.held).toEqual(["old", "new"])
    expect(enumeration.selected.map(session => session.session_id)).toEqual(["new"])
    expect(enumeration.conclusive).toBe(true)
  })

  it("excludes another folder's sessions from both answers", async () => {
    const { listSessionsForTest } = await import("../src/ambientSessions.js")
    const enumeration = await listSessionsForTest(
      [
        { sessionId: "here", cwd: "/work", updatedAt: new Date().toISOString() },
        { sessionId: "elsewhere", cwd: "/other", updatedAt: new Date().toISOString() },
      ],
      "/work/",
      50,
      30,
    )
    expect(enumeration.held).toEqual(["here"])
    expect(enumeration.conclusive).toBe(true)
  })

  it("calls an enumeration inconclusive when a runtime answered but matched nothing", async () => {
    // Far likelier than "this folder has no history": the runtime ignored the
    // cwd filter. Reporting it as conclusive would mark a folder's entire
    // imported history gone in one sync.
    const { listSessionsForTest } = await import("../src/ambientSessions.js")
    const enumeration = await listSessionsForTest(
      [{ sessionId: "elsewhere", cwd: "/other", updatedAt: new Date().toISOString() }],
      "/work",
      50,
      30,
    )
    expect(enumeration.held).toEqual([])
    expect(enumeration.conclusive).toBe(false)
  })

  it("calls an empty answer conclusive, because that is real evidence", async () => {
    const { listSessionsForTest } = await import("../src/ambientSessions.js")
    const enumeration = await listSessionsForTest([], "/work", 50, 30)
    expect(enumeration.conclusive).toBe(true)
  })

  it("calls a run out of page budget inconclusive, since `held` is then only a prefix", async () => {
    // Treating a prefix as the whole would mark the unread tail gone, and a
    // session outside the replay window is never re-marked present, so the
    // wrong badge would stick.
    const { listSessionsForTest } = await import("../src/ambientSessions.js")
    const enumeration = await listSessionsForTest(
      [{ sessionId: "one", cwd: "/work", updatedAt: new Date().toISOString() }],
      "/work",
      50,
      30,
      new Set(),
      { alwaysPaginate: true },
    )
    expect(enumeration.held.length).toBeGreaterThan(0)
    expect(enumeration.conclusive).toBe(false)
  })
})
