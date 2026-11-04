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
