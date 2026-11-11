import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostCommandFrame, HostCommandInnerFrame, HostDaemonFrame } from "@rainver/protocol";

/**
 * The journal behind `host_command` (`hostCommandJournal.ts`), on the real
 * filesystem. A restarted daemon is a fresh module graph that keeps only what
 * is on disk; durable-write faults go through `durableFile.ts`'s test seam.
 */
const COMMAND = "11111111-1111-4111-8111-111111111111";
const FINGERPRINT = "a".repeat(64);
let stateDir: string;

async function daemon() {
  vi.resetModules();
  const journal = await import("../src/hostCommandJournal.js");
  const durable = await import("../src/durableFile.js");
  journal.resetHostCommandJournalForTest();
  durable.resetDurableDirectoriesForTest();
  return { journal, durable };
}
const install = (requestId = "send-1"): HostCommandInnerFrame => ({
  type: "uninstall_tool", request_id: requestId, runtime_key: "codex", version: "1.0.0",
} as HostCommandInnerFrame);
const reset = (requestId = "send-1"): HostCommandInnerFrame => ({ type: "agent_profiles_reset", request_id: requestId, agent_id: "agent-1" } as HostCommandInnerFrame);
const frame = (command: HostCommandInnerFrame, overrides: Partial<HostCommandFrame> = {}): HostCommandFrame => ({
  type: "host_command", request_id: command.request_id, command_id: COMMAND, fingerprint: FINGERPRINT, command, ...overrides,
});
/** The ordinary handler: one effect, answered with its own result frame (plus an unrelated progress frame). */
function handler() {
  const effects: string[] = [];
  const execute = vi.fn((inner: HostCommandInnerFrame, sink: { send(frame: HostDaemonFrame): void }) => {
    effects.push(inner.type);
    sink.send({ type: "heartbeat" } as unknown as HostDaemonFrame);
    const result = inner.type === "agent_profiles_reset"
      ? { type: "managed_workspace_result", request_id: inner.request_id, action: "reset", ok: true, changed: true, error: null }
      : { type: "tool_result", request_id: inner.request_id, runtime_key: "codex", action: "uninstall_tool", ok: true, installation: null, error: null };
    setImmediate(() => sink.send(result as unknown as HostDaemonFrame));
  });
  return { effects, execute };
}
const receipts = async () => {
  const dir = join(stateDir, "host-commands");
  const names = (await readdir(dir).catch(() => [] as string[])).filter((name) => name.endsWith(".json"));
  return Promise.all(names.map(async (name) => JSON.parse(await readFile(join(dir, name), "utf8")) as Record<string, unknown>));
};

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "rainver-host-commands-"));
  process.env.RAINVER_HOST_CONFIG_DIR = stateDir;
});
afterEach(async () => {
  delete process.env.RAINVER_HOST_CONFIG_DIR;
  await rm(stateDir, { recursive: true, force: true });
});

describe("journaled Host commands", () => {
  it("records the start durably before the effect and the outcome before the answer, then replays it without a second effect", async () => {
    const { journal, durable } = await daemon();
    const synced: string[] = [];
    const restore = durable.setDurableIoForTest({ async syncFile(handle, path) { await handle.sync(); synced.push(path); } });
    const { effects, execute } = handler();
    const outer = { send: vi.fn() };
    const statusAtEffect: unknown[] = [];
    execute.mockImplementationOnce((inner, sink) => {
      // The effect starts only once its receipt is on disk.
      void receipts().then((all) => statusAtEffect.push(all.map((r) => r.status)));
      effects.push(inner.type);
      setTimeout(() => sink.send({ type: "tool_result", request_id: inner.request_id, runtime_key: "codex", action: "uninstall_tool", ok: true, installation: null, error: null } as unknown as HostDaemonFrame), 20);
    });
    const first = await journal.runJournaledHostCommand(frame(install()), execute, outer);
    restore();
    expect(first).toMatchObject({ outcome: "completed", replayed: false, command_id: COMMAND, request_id: "send-1", result: { type: "tool_result", ok: true } });
    expect(statusAtEffect).toEqual([["in_progress"]]);
    expect(synced.length).toBeGreaterThanOrEqual(2);
    expect(await receipts()).toMatchObject([{ status: "done", attempts: 1, fingerprint: FINGERPRINT }]);

    // A repeat after a lost answer, in a restarted process: the receipt, never the effect again.
    const restarted = await daemon();
    const again = await restarted.journal.runJournaledHostCommand(frame(install("send-2")), execute, outer);
    expect(again).toMatchObject({ outcome: "completed", replayed: true, request_id: "send-2", result: first.result });
    expect(effects).toEqual(["uninstall_tool"]);
  });

  it("passes the handler's other frames through and runs a concurrent repeat once", async () => {
    const { journal } = await daemon();
    const { effects, execute } = handler();
    const outer = { send: vi.fn() };
    const [a, b] = await Promise.all([
      journal.runJournaledHostCommand(frame(install("send-1")), execute, outer),
      journal.runJournaledHostCommand(frame(install("send-2")), execute, outer),
    ]);
    expect(effects).toEqual(["uninstall_tool"]);
    expect(a).toMatchObject({ outcome: "completed", replayed: false, request_id: "send-1" });
    expect(b).toMatchObject({ outcome: "completed", replayed: true, request_id: "send-2" });
    expect(outer.send).toHaveBeenCalledWith({ type: "heartbeat" });
  });

  it("refuses a repeat whose frozen command differs, running nothing", async () => {
    const { journal } = await daemon();
    const { effects, execute } = handler();
    await journal.runJournaledHostCommand(frame(install()), execute, { send: vi.fn() });
    const other = await journal.runJournaledHostCommand(frame(install("send-2"), { fingerprint: "b".repeat(64) }), execute, { send: vi.fn() });
    expect(other).toMatchObject({ outcome: "mismatch", result: null });
    expect(effects).toEqual(["uninstall_tool"]);
  });

  it("reports a command an earlier process started and never finished as interrupted, never running it again", async () => {
    const first = await daemon();
    // The effect starts and the process dies before it answers.
    void first.journal.runJournaledHostCommand(frame(install()), vi.fn(), { send: vi.fn() });
    await vi.waitFor(async () => expect(await receipts()).toMatchObject([{ status: "in_progress" }]));

    const restarted = await daemon();
    const { effects, execute } = handler();
    const answer = await restarted.journal.runJournaledHostCommand(frame(install("send-2")), execute, { send: vi.fn() });
    expect(answer).toMatchObject({ outcome: "interrupted", replayed: true, result: null });
    expect(await receipts()).toMatchObject([{ status: "interrupted" }]);
    // And stays so: every later repeat is the same unknown, not a fresh run.
    const later = await (await daemon()).journal.runJournaledHostCommand(frame(install("send-3")), execute, { send: vi.fn() });
    expect(later.outcome).toBe("interrupted");
    expect(effects).toEqual([]);
  });

  it("finishes an interrupted profile reset by running it again: it moves only what is still there", async () => {
    const first = await daemon();
    void first.journal.runJournaledHostCommand(frame(reset()), vi.fn(), { send: vi.fn() });
    await vi.waitFor(async () => expect(await receipts()).toMatchObject([{ status: "in_progress" }]));
    const restarted = await daemon();
    const { effects, execute } = handler();
    const answer = await restarted.journal.runJournaledHostCommand(frame(reset("send-2")), execute, { send: vi.fn() });
    expect(answer).toMatchObject({ outcome: "completed", replayed: true, result: { type: "managed_workspace_result", ok: true } });
    expect(effects).toEqual(["agent_profiles_reset"]);
    expect(await receipts()).toMatchObject([{ status: "done", attempts: 2 }]);
  });

  it("refuses, without any effect, a command whose start cannot be made durable", async () => {
    const { journal, durable } = await daemon();
    const restore = durable.setDurableIoForTest({ async syncFile() { throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" }); } });
    const { effects, execute } = handler();
    const answer = await journal.runJournaledHostCommand(frame(install()), execute, { send: vi.fn() });
    restore();
    expect(answer).toMatchObject({ outcome: "refused", result: null });
    expect(answer.error).toMatch(/host_command_not_recorded/);
    expect(effects).toEqual([]);
    // Nothing was recorded as started, so a later repeat may run it once.
    const retry = await journal.runJournaledHostCommand(frame(install("send-2")), execute, { send: vi.fn() });
    expect(retry).toMatchObject({ outcome: "completed", replayed: false });
    expect(effects).toEqual(["uninstall_tool"]);
  });

  it("refuses an unreadable receipt rather than guessing", async () => {
    const { journal } = await daemon();
    const { effects, execute } = handler();
    await journal.runJournaledHostCommand(frame(install()), execute, { send: vi.fn() });
    const dir = join(stateDir, "host-commands");
    const [name] = await readdir(dir);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, name!), "{not json", "utf8");
    const answer = await (await daemon()).journal.runJournaledHostCommand(frame(install("send-2")), execute, { send: vi.fn() });
    expect(answer).toMatchObject({ outcome: "refused" });
    expect(answer.error).toMatch(/host_command_journal_unreadable/);
    expect(effects).toEqual(["uninstall_tool"]);
  });

  /**
   * The final `done` write fails through the durable-IO seam once the effect has run
   * (`step` names the step: the file fsync before the rename, or the directory fsync
   * after it). Everything else is the real filesystem.
   */
  function failDoneWrite(durable: Awaited<ReturnType<typeof daemon>>["durable"], step: "file" | "directory", times = Infinity) {
    const state = { armed: false, failures: 0 };
    const fail = async (real: () => Promise<void>) => {
      if (state.armed && state.failures < times) { state.failures += 1; throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" }); }
      await real();
    };
    const restore = durable.setDurableIoForTest(step === "file"
      ? { syncFile: (handle) => fail(() => handle.sync()) }
      : { async syncDirectory(path) { await fail(async () => { const { open } = await import("node:fs/promises"); const dir = await open(path, "r"); try { await dir.sync(); } finally { await dir.close(); } }); } });
    return { state, restore };
  }
  /** The handler, arming the fault once its effect has started. */
  function arming(state: { armed: boolean }) {
    const { effects, execute } = handler();
    const inner = execute.getMockImplementation()!;
    execute.mockImplementation((frame, sink) => { state.armed = true; inner(frame, sink); });
    return { effects, execute };
  }

  it("retries a failed final write and answers completed only once the receipt is durable", async () => {
    const { journal, durable } = await daemon();
    const fault = failDoneWrite(durable, "file", 1);
    const { effects, execute } = arming(fault.state);
    const answer = await journal.runJournaledHostCommand(frame(install()), execute, { send: vi.fn() });
    fault.restore();
    expect(fault.state.failures).toBe(1);
    expect(answer).toMatchObject({ outcome: "completed", replayed: false, result: { type: "tool_result", ok: true } });
    expect(await receipts()).toMatchObject([{ status: "done" }]);
    expect(effects).toEqual(["uninstall_tool"]);
  });

  it("never answers completed when the outcome's file fsync keeps failing; a repeat records it without a second effect", async () => {
    const { journal, durable } = await daemon();
    const fault = failDoneWrite(durable, "file");
    const { effects, execute } = arming(fault.state);
    const answer = await journal.runJournaledHostCommand(frame(install()), execute, { send: vi.fn() });
    expect(answer).toMatchObject({ outcome: "unrecorded", result: null });
    expect(answer.error).toMatch(/host_command_outcome_not_recorded: EIO/);
    // The rename never happened: on disk it is still only started.
    expect(await receipts()).toMatchObject([{ status: "in_progress" }]);
    // Still failing: the same unknown, never the effect again — also for concurrent repeats.
    const [a, b] = await Promise.all([
      journal.runJournaledHostCommand(frame(install("send-2")), execute, { send: vi.fn() }),
      journal.runJournaledHostCommand(frame(install("send-3")), execute, { send: vi.fn() }),
    ]);
    expect([a.outcome, b.outcome]).toEqual(["unrecorded", "unrecorded"]);
    fault.restore();
    const recorded = await journal.runJournaledHostCommand(frame(install("send-4")), execute, { send: vi.fn() });
    expect(recorded).toMatchObject({ outcome: "completed", replayed: true, request_id: "send-4", result: { type: "tool_result", ok: true } });
    expect(await receipts()).toMatchObject([{ status: "done", attempts: 1 }]);
    expect(effects).toEqual(["uninstall_tool"]);
  });

  it("does not trust a done receipt whose directory fsync failed, in this process or after a restart", async () => {
    const first = await daemon();
    const fault = failDoneWrite(first.durable, "directory");
    const { effects, execute } = arming(fault.state);
    const answer = await first.journal.runJournaledHostCommand(frame(install()), execute, { send: vi.fn() });
    expect(answer.outcome).toBe("unrecorded");
    // Renamed into place, so visible as done, but power loss may still discard it.
    expect(await receipts()).toMatchObject([{ status: "done" }]);
    fault.restore();

    // A restarted process replays a visible done receipt only through the durability barrier.
    const restarted = await daemon();
    const stillFailing = failDoneWrite(restarted.durable, "directory");
    stillFailing.state.armed = true;
    const replay = await restarted.journal.runJournaledHostCommand(frame(install("send-2")), execute, { send: vi.fn() });
    expect(replay).toMatchObject({ outcome: "unrecorded", result: null });
    expect(stillFailing.state.failures).toBeGreaterThan(0);
    stillFailing.restore();
    const synced: string[] = [];
    const observe = restarted.durable.setDurableIoForTest({ async syncFile(handle, path) { await handle.sync(); synced.push(path); } });
    const proven = await restarted.journal.runJournaledHostCommand(frame(install("send-3")), execute, { send: vi.fn() });
    observe();
    expect(proven).toMatchObject({ outcome: "completed", replayed: true, result: { type: "tool_result", ok: true } });
    expect(synced).toHaveLength(1);
    expect(effects).toEqual(["uninstall_tool"]);
  });

  it("does not run a profile reset again in the process that ran it while its outcome is unrecorded", async () => {
    const first = await daemon();
    const fault = failDoneWrite(first.durable, "file");
    const { effects, execute } = arming(fault.state);
    expect((await first.journal.runJournaledHostCommand(frame(reset()), execute, { send: vi.fn() })).outcome).toBe("unrecorded");
    expect((await first.journal.runJournaledHostCommand(frame(reset("send-2")), execute, { send: vi.fn() })).outcome).toBe("unrecorded");
    expect(effects).toEqual(["agent_profiles_reset"]);
    fault.restore();
    // A process that never recorded it finds it started: the reset is finished by running it again
    // (it moves only what is still there) — the control plane still fences the Agent, as it never
    // received `completed` for it.
    const restarted = await daemon();
    const again = await restarted.journal.runJournaledHostCommand(frame(reset("send-3")), execute, { send: vi.fn() });
    expect(again).toMatchObject({ outcome: "completed", replayed: true });
    expect(effects).toEqual(["agent_profiles_reset", "agent_profiles_reset"]);
    expect(await receipts()).toMatchObject([{ status: "done", attempts: 2 }]);
  });

  it("prunes only settled receipts past retention", async () => {
    const { journal } = await daemon();
    const { execute } = handler();
    await journal.runJournaledHostCommand(frame(install()), execute, { send: vi.fn() });
    void journal.runJournaledHostCommand(frame(install("x"), { command_id: "22222222-2222-4222-8222-222222222222" }), vi.fn(), { send: vi.fn() });
    await vi.waitFor(async () => expect((await receipts()).length).toBe(2));
    journal.resetHostCommandJournalForTest();
    const removed = await journal.pruneSettledReceipts(Date.now() + 31 * 24 * 60 * 60 * 1000);
    expect(removed).toBe(1);
    expect(await receipts()).toMatchObject([{ status: "in_progress" }]);
  });
});
