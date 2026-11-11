import { fileURLToPath } from "node:url";
import { vi } from "vitest";
import { sharedHostConnectionRegistry, type ManagedWorkspaceResult } from "../../src/modules/hosts/connectionRegistry.js";

/**
 * The daemon's real managed-workspace code over a real filesystem, behind the
 * control plane's Host registry. Tests set `RAINVER_HOST_CONFIG_DIR` to a
 * temporary directory first; the faults are shaped where the network or a
 * crash would shape them, never as a canned answer.
 */

export type ManagedFrame = {
  agent_id: string; container_kind: "conversation" | "direct"; container_id: string; include_workspace: boolean;
  operation_id?: string; generation?: number;
};
type LegacyHooks = { beforeLegacyMove?: () => Promise<void> };
export type ManagedDaemon = {
  executeManagedWorkspaceOperation: (frame: ManagedFrame & { action: "archive" | "restore" }, hooks?: { afterMove?: (stage: string) => void } & LegacyHooks) => Promise<ManagedWorkspaceResult>;
  executeWorkspaceCommand: (locationRoot: string | null, frame: unknown, hooks?: LegacyHooks) => Promise<{ ok: boolean; error: string | null }>;
  /** The daemon's real legacy drain (`legacyArchiveDrain.ts`). */
  drainLegacyArchives: () => Promise<void>;
  managedWorkspacePath: (agent: string, container: { kind: "conversation" | "direct"; id: string }) => string;
  runtimeProfileContainerPath: (agent: string, kind: "conversation" | "direct" | "workspace", id: string) => string;
  listManagedWorkspaces: () => Promise<unknown[]>;
};

/** The daemon's modules, loaded fresh: a restarted daemon keeps only what is on disk. */
export async function loadManagedDaemon(): Promise<ManagedDaemon> {
  vi.resetModules();
  // Not literals: the daemon's sources type-check in their own package, outside the server's rootDir.
  const source = (path: string) => fileURLToPath(new URL(`../../../packages/host-daemon/src/${path}`, import.meta.url));
  const operations = await import(source("managedWorkspaceOperations.ts"));
  const workspaces = await import(source("managedWorkspaces.ts"));
  const execution = await import(source("executionWorkspace.ts"));
  const drain = await import(source("legacyArchiveDrain.ts"));
  return { ...operations, ...workspaces, executeWorkspaceCommand: execution.executeWorkspaceCommand,
    drainLegacyArchives: drain.drainLegacyArchives } as ManagedDaemon;
}

/**
 * `in_flight`: the daemon admitted the request and is still running it, detached from the connection that
 * delivered it — the reply never reaches this control plane (it restarted). `releaseInFlight` lets it finish.
 * `ack_after_duplicate`: the request lands and finishes, but its reply arrives only after the daemon admitted a
 * duplicate of it (a resend that raced it), which is still running (`in_flight`) when the reply is acknowledged.
 */
export type HostFault = "none" | "offline" | "crash_after_workspace" | "crash_after_profile" | "lost_reply" | "hold" | "in_flight" | "ack_after_duplicate";

/** How long a drain request waits before the registry would answer `host_timeout`. */
const DRAIN_TIMEOUT_MS = 200;

/**
 * The connected Host: every managed-workspace request and every workspace
 * `archive_profiles` command goes to the daemon's real handler. `next` shapes
 * the next delivery of either.
 */
export function connectManagedHost(host: ManagedDaemon) {
  let fault: HostFault = "none";
  const held: Array<() => Promise<unknown>> = [];
  const sent: Array<{ type: string; frame: ManagedFrame }> = [];
  const take = () => { const current = fault; fault = "none"; return current; };
  let openGate = () => {};
  let gate = Promise.resolve();
  const running: Promise<unknown>[] = [];
  const hold = () => { if (!running.length) gate = new Promise<void>((resolve) => { openGate = resolve; }); return { beforeLegacyMove: () => gate }; };
  const drains: Array<ManagedWorkspaceResult> = [];
  let drainFault: "none" | "offline" = "none";
  const spy = vi.spyOn(sharedHostConnectionRegistry, "requestManagedWorkspaceAction").mockImplementation(async (_hostId, type, frame) => {
    sent.push({ type, frame: frame as ManagedFrame });
    const action = type === "managed_workspace_archive" ? "archive" as const : "restore" as const;
    const deliver = () => host.executeManagedWorkspaceOperation({ ...(frame as ManagedFrame), action });
    const current = take();
    switch (current) {
      case "offline": return { ok: false, changed: false, error: "host_offline" };
      case "hold": held.push(deliver); return { ok: false, changed: false, error: "host_timeout" };
      case "lost_reply": await deliver(); return { ok: false, changed: false, error: "host_timeout" };
      case "in_flight": running.push(host.executeManagedWorkspaceOperation({ ...(frame as ManagedFrame), action }, hold()));
        return { ok: false, changed: false, error: "host_timeout" };
      case "ack_after_duplicate": {
        const answer = await deliver();
        running.push(host.executeManagedWorkspaceOperation({ ...(frame as ManagedFrame), action }, hold()));
        return answer;
      }
      case "crash_after_workspace":
      case "crash_after_profile": {
        const killedAfter = current === "crash_after_workspace" ? "workspace" : "profile";
        return host.executeManagedWorkspaceOperation({ ...(frame as ManagedFrame), action }, {
          afterMove: (stage) => { if (stage === killedAfter) throw new Error("daemon killed"); },
        });
      }
      default: return deliver();
    }
  });
  const branch = vi.spyOn(sharedHostConnectionRegistry, "requestTaskBranch").mockImplementation((async (_hostId: string, type: string, frame: unknown) => {
    sent.push({ type: `${type}:${(frame as { action: string }).action}`, frame: frame as ManagedFrame });
    const deliver = () => host.executeWorkspaceCommand(null, frame);
    switch (take()) {
      case "offline": return { ok: false, error: "host_offline" };
      case "hold": held.push(deliver); return { ok: false, error: "host_timeout" };
      case "lost_reply": await deliver(); return { ok: false, error: "host_timeout" };
      case "in_flight": running.push(host.executeWorkspaceCommand(null, frame, hold())); return { ok: false, error: "host_timeout" };
      case "ack_after_duplicate": { const answer = await deliver(); running.push(host.executeWorkspaceCommand(null, frame, hold())); return answer; }
      default: return deliver();
    }
  }) as never);
  // The daemon's own drain: it answers only once every identity-less request it admitted has finished.
  const drain = vi.spyOn(sharedHostConnectionRegistry, "drainLegacyManagedWorkspaceArchives").mockImplementation(async () => {
    const current = drainFault; drainFault = "none";
    const answer: ManagedWorkspaceResult = current === "offline" ? { ok: false, changed: false, error: "host_offline" }
      : await Promise.race([
        // As the daemon's dispatch answers it: a drain that could not make the closure durable is `io_error`.
        host.drainLegacyArchives().then(() => ({ ok: true, changed: false, error: null }),
          (error: unknown) => ({ ok: false, changed: false, error: error instanceof Error ? error.message : String(error), error_code: "io_error" as const })),
        new Promise<ManagedWorkspaceResult>((resolve) => setTimeout(() => resolve({ ok: false, changed: false, error: "host_timeout" }), DRAIN_TIMEOUT_MS)),
      ]);
    drains.push(answer);
    return answer;
  });
  const online = vi.spyOn(sharedHostConnectionRegistry, "isOnline").mockReturnValue(true);
  return {
    sent,
    /** Every drain answer, in order. */
    drains,
    next(value: HostFault) { fault = value; },
    nextDrain(value: "offline") { drainFault = value; },
    /** Delivers requests the network held, after whatever happened since. */
    async release() { const out = []; for (const deliver of held.splice(0)) out.push(await deliver()); return out; },
    /** Lets the requests the daemon is still running finish, and returns what each did. */
    async releaseInFlight() { openGate(); return Promise.all(running.splice(0)); },
    restore() { spy.mockRestore(); branch.mockRestore(); drain.mockRestore(); online.mockRestore(); },
  };
}
