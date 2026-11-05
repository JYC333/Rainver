import { readdirSync, readFileSync } from "node:fs";
import type { ChildProcess } from "node:child_process";

/** Signal a child and its descendants when it was spawned detached. */
export function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): boolean {
  if (typeof child.pid !== "number") return false;
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch {
    try {
      return child.kill(signal);
    } catch {
      return false;
    }
  }
}

/**
 * Whether any live (non-zombie) process remains in a process group. On Linux
 * this reads `/proc`, so an exited-but-unreaped member does not keep a group
 * "alive"; elsewhere it falls back to `kill(-pgid, 0)`.
 */
export function processGroupAlive(pgid: number): boolean {
  if (process.platform === "linux") {
    let entries: string[];
    try {
      entries = readdirSync("/proc");
    } catch {
      entries = [];
    }
    if (entries.length > 0) {
      for (const entry of entries) {
        if (!/^\d+$/.test(entry)) continue;
        try {
          const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
          // `pid (comm) state ppid pgrp …`; comm may contain spaces and parentheses.
          const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
          if (Number(fields[2]) === pgid && fields[0] !== "Z") return true;
        } catch {
          continue;
        }
      }
      return false;
    }
  }
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Ends what is left of a detached Run's process group after its main process
 * exited — a background command with redirected stdio outlives the runtime —
 * and resolves only once no member is left: SIGTERM, then SIGKILL after
 * `graceMs`, then waiting. A process that left the group itself (`setsid`) is
 * outside what this can see or end.
 */
export async function settleProcessGroup(
  pgid: number | undefined,
  log: (line: string) => void,
  options: { graceMs?: number; pollMs?: number } = {},
): Promise<void> {
  if (typeof pgid !== "number" || !processGroupAlive(pgid)) return;
  const pollMs = options.pollMs ?? 50;
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  try { process.kill(-pgid, "SIGTERM"); } catch { /* already gone */ }
  const deadline = Date.now() + (options.graceMs ?? 5_000);
  while (processGroupAlive(pgid) && Date.now() < deadline) await sleep(pollMs);
  if (!processGroupAlive(pgid)) return;
  log(`process group ${pgid} outlived its Run and ignored SIGTERM — sending SIGKILL`);
  try { process.kill(-pgid, "SIGKILL"); } catch { /* already gone */ }
  while (processGroupAlive(pgid)) await sleep(pollMs * 4);
}
