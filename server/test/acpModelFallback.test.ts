import { describe, expect, it } from "vitest";
import { createCliConversationController } from "../src/modules/runs/cliConversationProtocol.js";
import { launchModelWrites, modelFallbackOf, recordRuntimeModelFallback, runModelFallback, runtimeModelFallbackNotice, stopAtCommitOnModelFallback } from "../src/modules/runs/runtimeModelFallback.js";
import { withTransaction } from "../src/db/tx.js";
import type { Queryable } from "../src/modules/routeUtils/common.js";
import { listRuntimeAdapterSpecs } from "../src/modules/runtimeAdapters/specs.js";

/**
 * `on_model_fallback` (`runs/runtimeModelFallback.ts`, ADR 0037) reports only the runtime's own explicit fallback notice
 * on the main session of this launch's prompt — never an echo, a response's model id, a resume replay or a child session.
 * The notices are the ones the pinned adapters send: `claude-agent-acp`'s `model_refusal_fallback` warning and
 * `codex-acp`'s `model/rerouted` notice (fields on the update itself).
 */
function open(input: { runtime?: "claude_code" | "codex_cli" | "opencode"; resume?: boolean } = {}) {
  const fallbacks: { title: string; description: string | null }[] = [];
  const send = () => {};
  const controller = createCliConversationController({
    runtime_key: input.runtime ?? "claude_code", cwd: "/workspace", prompt: "continue",
    ...(input.resume ? { runtime_session_id: "session-1" } : {}),
    on_model_fallback: (report) => { fallbacks.push(report); },
  })!;
  const receive = (message: Record<string, unknown>) => controller.receive(message, send, send);
  const update = (update: Record<string, unknown>, sessionId = "session-1") =>
    receive({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
  controller.start(send);
  receive({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } });
  return { controller, fallbacks, receive, update };
}

const sessionNew = (currentValue: string) => ({ jsonrpc: "2.0", id: 2, result: {
  sessionId: "session-1", configOptions: [{ id: "model", category: "model", type: "select", currentValue, options: [{ value: currentValue }] }],
} });
const claudeFallback = { sessionUpdate: "notice", severity: "warning",
  title: "claude-opus-5-5 declined this request (cyber); retried with claude-sonnet-5-5. The session will continue on claude-sonnet-5-5." };
const codexReroute = { sessionUpdate: "notice", severity: "info", title: "Model rerouted", description: "Switched from gpt-6.1 to gpt-6.1-mini (high_risk_cyber_activity)." };

describe("ACP explicit model fallback", () => {
  it("reports the runtime's own fallback notice on this prompt's main session, for Claude Code and Codex alike", () => {
    const claude = open();
    claude.receive(sessionNew("claude-opus-5-5"));
    claude.update(claudeFallback);
    expect(claude.fallbacks).toEqual([{ title: claudeFallback.title, description: null }]);
    // The long form ("Model fallback" with the summary as its description) counts as well.
    claude.update({ sessionUpdate: "notice", severity: "warning", title: "Model fallback", description: "x declined this request; retried with y." });
    expect(claude.fallbacks).toHaveLength(2);
    const codex = open({ runtime: "codex_cli" });
    codex.receive(sessionNew("gpt-6.1"));
    codex.update(codexReroute);
    expect(codex.fallbacks).toEqual([{ title: "Model rerouted", description: codexReroute.description }]);
  });

  it("infers nothing: another notice, an echo, a response's model id, final usage rows or a runtime without a declared notice are no fallback", () => {
    const run = open();
    run.receive(sessionNew("opus"));
    run.update({ sessionUpdate: "notice", severity: "warning", title: "Retrying Claude, attempt 1 of 3." });
    run.update({ sessionUpdate: "config_option_update", configOptions: [{ id: "model", category: "model", type: "select", currentValue: "claude-opus-5-5", options: [] }] });
    // An alias answered by its concrete id, and a usage row naming another model: neither is an explicit report.
    run.update({ sessionUpdate: "usage_update", used: 1, size: 100, _meta: { "_claude/model": "claude-haiku-5-5" } });
    run.receive({ jsonrpc: "2.0", id: 4, result: { stopReason: "end_turn", _meta: { quota: { model_usage: [{ model: "claude-haiku-5-5",
      token_count: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }] } } } });
    expect(run.fallbacks).toEqual([]);
    const openCode = open({ runtime: "opencode" });
    openCode.receive(sessionNew("vendor/model"));
    openCode.update(codexReroute);
    expect(openCode.fallbacks).toEqual([]);
  });

  it("ignores a restored session's notices before this launch prompts, and a child session's", () => {
    const run = open({ resume: true });
    run.update(claudeFallback);
    expect(run.fallbacks).toEqual([]);
    run.receive(sessionNew("claude-opus-5-5"));
    run.update({ sessionUpdate: "subagent_update", sessionId: "child-1", state: { state: "running" } });
    run.update(claudeFallback, "child-1");
    expect(run.fallbacks).toEqual([]);
    run.update(claudeFallback);
    expect(run.fallbacks).toHaveLength(1);
  });

  it("judges which notice is a fallback only from the adapter catalog declaration, never a runtime named in code", () => {
    const declared = listRuntimeAdapterSpecs().filter((spec) => spec.model.model_fallback_notice);
    expect(declared.map((spec) => spec.runtime_key).sort()).toEqual(["claude_code", "codex_cli"]);
    for (const spec of listRuntimeAdapterSpecs()) {
      expect(runtimeModelFallbackNotice(spec.runtime_key, codexReroute) !== null, spec.runtime_key)
        .toBe(Boolean(spec.model.model_fallback_notice && new RegExp(spec.model.model_fallback_notice.notice_title).test(codexReroute.title)));
    }
    for (const unknown of [null, undefined, "", "unknown_runtime"]) expect(runtimeModelFallbackNotice(unknown, claudeFallback)).toBeNull();
    // An older shape nests the fields under `notice`.
    expect(runtimeModelFallbackNotice("codex_cli", { sessionUpdate: "notice", notice: { title: "Model rerouted" } })).toEqual({ title: "Model rerouted", description: null });
  });

  it("reads a recorded fallback back from the Run's model override, and nothing else", () => {
    expect(modelFallbackOf({ runtime_model_fallback: { title: "Model rerouted", description: null, launch_id: "l-1", reported_at: "2026-11-23T00:00:00.000Z" } }))
      .toEqual({ title: "Model rerouted", description: null, launch_id: "l-1", reported_at: "2026-11-23T00:00:00.000Z" });
    for (const value of [null, {}, { runtime_model_fallback: null }, { runtime_model_fallback: { title: "" } }, { runtime_reported_model: "x" }]) expect(modelFallbackOf(value)).toBeNull();
  });

  it("starts a fallback's write on receipt, never queued behind observation writes still waiting, and settles both", async () => {
    const order: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    // The first observation waits (as a Run-row write waits behind a Gmail release holding the row).
    const writes = launchModelWrites({
      observe: async (model) => { order.push(`observe:${model}`); if (model === "gpt-6.1") await blocked; },
      fallback: async (report) => { order.push(`fallback:${report.title}`); },
    });
    writes.selected("gpt-6.1");
    writes.selected("gpt-6.1-mini");
    writes.fellBack({ title: "Model rerouted", description: null });
    // Synchronously, before any await: the fallback write has started while the observations are still queued.
    expect(order).toEqual(["fallback:Model rerouted"]);
    await Promise.resolve();
    expect(order).toEqual(["fallback:Model rerouted", "observe:gpt-6.1"]);
    let settled = false;
    const done = writes.settled().then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    release();
    await done;
    expect(order).toEqual(["fallback:Model rerouted", "observe:gpt-6.1", "observe:gpt-6.1-mini"]);
    const failing = launchModelWrites({ observe: async () => { throw new Error("observation failed"); }, fallback: async () => undefined });
    failing.selected(null);
    failing.fellBack({ title: "Model rerouted", description: null });
    await expect(failing.settled()).rejects.toThrow("observation failed");
    const fallbackFails = launchModelWrites({ fallback: () => { throw new Error("fallback failed"); } });
    fallbackFails.fellBack({ title: "Model rerouted", description: null });
    await expect(fallbackFails.settled()).rejects.toThrow("fallback failed");
  });

  it("stops the round from receipt: the report is read in process while its Run-row write still waits, and from the row once committed", async () => {
    const runId = `run-${Math.random()}`;
    let commit!: () => void;
    const committed = new Promise<void>((resolve) => { commit = resolve; });
    let row: unknown = null;
    const db: Queryable = {
      async query(sql: string) {
        if (sql.startsWith("UPDATE runs")) { await committed; row = { runtime_model_fallback: { title: "Model rerouted", description: null, launch_id: "launch-1", reported_at: "2026-11-23T00:00:00.000Z" } }; return { rows: [], rowCount: 1 } as never; }
        return { rows: [{ model_override_json: row }], rowCount: 1 } as never;
      },
    };
    expect(await runModelFallback(db, { spaceId: "space-1", runId })).toBeNull();
    const writing = recordRuntimeModelFallback(db, { spaceId: "space-1", runId, launchId: "launch-1", title: "Model rerouted", description: "Switched." });
    // The row is not written yet (its UPDATE waits behind a lock): every check already sees the report.
    expect(await runModelFallback(db, { spaceId: "space-1", runId })).toMatchObject({ title: "Model rerouted", description: "Switched.", launch_id: "launch-1" });
    expect(await runModelFallback(db, { spaceId: "space-2", runId })).toBeNull();
    commit();
    await writing;
    expect(await runModelFallback(db, { spaceId: "space-1", runId })).toMatchObject({ title: "Model rerouted", reported_at: "2026-11-23T00:00:00.000Z" });
    // A write that fails keeps the note in this process, so settlement here still stops the round.
    const failed = `run-${Math.random()}`;
    const broken: Queryable = { async query(sql: string) { if (sql.startsWith("UPDATE runs")) throw new Error("connection lost"); return { rows: [], rowCount: 0 } as never; } };
    await expect(recordRuntimeModelFallback(broken, { spaceId: "space-1", runId: failed, launchId: null, title: "Model rerouted", description: null })).rejects.toThrow("connection lost");
    expect(await runModelFallback(broken, { spaceId: "space-1", runId: failed })).toMatchObject({ title: "Model rerouted" });
  });

  it("stops a step at its commit boundary once this process received the report after the step's check, and only that transaction", async () => {
    const statements: string[] = [];
    let blockReport: () => void = () => {};
    const client = { async query(sql: string) {
      statements.push(sql.split(" ")[0]!);
      // The Run-row write waits behind the step's own Run lock until the step ends.
      if (sql.startsWith("UPDATE runs")) await new Promise<void>((resolve) => { blockReport = resolve; });
      return { rows: [], rowCount: 0 };
    }, release() {} };
    const pool = { connect: async () => client } as never;
    const run = { spaceId: "space-1", runId: `run-${Math.random()}` };
    const refused = new Error("withheld");
    let writing: Promise<void> | undefined;
    await expect(withTransaction(pool, async (tx) => {
      stopAtCommitOnModelFallback(tx, run, () => refused);
      await tx.query("SELECT 1");
      // Received while the step waited between its statements: noted before any await, its write still pending.
      writing = recordRuntimeModelFallback({ query: client.query } as Queryable, { ...run, launchId: null, title: "Model rerouted", description: null });
      await tx.query("SELECT 2");
    })).rejects.toBe(refused);
    expect(statements.filter((sql) => sql !== "UPDATE")).toEqual(["BEGIN", "SELECT", "SELECT", "ROLLBACK"]);
    blockReport();
    await writing;
    // The pooled client carries no guard into its next transaction, and a step of another Run commits.
    await withTransaction(pool, async (tx) => { stopAtCommitOnModelFallback(tx, { spaceId: "space-1", runId: "other" }, () => refused); });
    expect(statements.slice(-2)).toEqual(["BEGIN", "COMMIT"]);
    // A client with no commit boundary is refused, never silently unguarded.
    expect(() => stopAtCommitOnModelFallback(client as Queryable, run, () => refused)).toThrow("commit guard");
  });
});
