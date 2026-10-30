import { afterEach, describe, expect, it, vi } from "vitest";
import { RunExecutionControl } from "../src/modules/runs/executionControl.js";
import { LocalCliProcessRegistry } from "../src/modules/runs/localCliExecution.js";
import { HostConnectionRegistry } from "../src/modules/hosts/connectionRegistry.js";
import type { RunAttemptRecord, RunRecord } from "../src/modules/runs/repository.js";

afterEach(() => vi.useRealTimers());
const run = { id: "run", space_id: "space" } as RunRecord;
const attempt = { attempt_number: 3, launch_id: "nonce" } as RunAttemptRecord;
const repository = { getLatestRunAttempt: async () => attempt };
const complete = { exit_code: 1, timed_out: false, error: null };

describe("Run execution stop protocol", () => {
  it("uses the persisted launch after server restart and requires its exact acknowledgement", async () => {
    const hosts = new HostConnectionRegistry();
    let sent!: () => void;
    const sentFrame = new Promise<void>(resolve => { sent = resolve; });
    const frames: unknown[] = [];
    hosts.registerConnection("host", { send(frame) { frames.push(frame); sent(); }, close() {} });
    const control = new RunExecutionControl(repository, async () => "host", new LocalCliProcessRegistry(), hosts);
    const stopping = control.stop(run);
    await sentFrame;
    expect(frames).toEqual([{ type: "terminate", run_id: "run", launch_id: "nonce", force: false }]);
    hosts.receiveComplete("host", "run", complete, "other-nonce");
    let finished = false;
    void stopping.then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    hosts.receiveComplete("host", "run", complete, "nonce");
    await expect(stopping).resolves.toMatchObject({ attempt_number: 3, confirmed_exit: true });
  });

  it("leaves offline launches unconfirmed", async () => {
    const control = new RunExecutionControl(repository, async () => "offline", undefined, new HostConnectionRegistry());
    await expect(control.stop(run)).resolves.toMatchObject({ confirmed_exit: false, process_terminated: false });
  });

  it("does not mistake local controller unwind for physical exit on an offline Host", async () => {
    const processes = new LocalCliProcessRegistry();
    processes.registerRemote(run.id, () => processes.deregister(run.id), () => processes.deregister(run.id));
    const control = new RunExecutionControl(repository, async () => "offline", processes, new HostConnectionRegistry());
    await expect(control.stop(run)).resolves.toMatchObject({ confirmed_exit: false });
  });

  it("escalates graceful stop without claiming an exit on timeout", async () => {
    vi.useFakeTimers();
    const hosts = new HostConnectionRegistry();
    const frames: unknown[] = [];
    hosts.registerConnection("host", { send: frame => frames.push(frame), close() {} });
    const stopping = new RunExecutionControl(repository, async () => "host", undefined, hosts).stop(run);
    await vi.advanceTimersByTimeAsync(7_000);
    await expect(stopping).resolves.toMatchObject({ confirmed_exit: false, force_kill_escalated: true });
    expect(frames).toEqual([
      { type: "terminate", run_id: "run", launch_id: "nonce", force: false },
      { type: "terminate", run_id: "run", launch_id: "nonce", force: true },
    ]);
  });

  it("aborts preparation before treating an undispatched attempt as stopped", async () => {
    const processes = new LocalCliProcessRegistry();
    const invocation = processes.openInvocation(run.id);
    const control = new RunExecutionControl({ getLatestRunAttempt: async () => null }, async () => "host", processes);
    await expect(control.stop(run)).resolves.toMatchObject({ confirmed_exit: true });
    expect(invocation.signal.aborted).toBe(true);
    invocation.close();
  });
});
