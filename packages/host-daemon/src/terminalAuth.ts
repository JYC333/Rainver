import { accessSync, constants } from "node:fs";
import { platform } from "node:os";
import { delimiter, join } from "node:path";

/** Whether this host can reproduce an ACP Terminal Auth launch in a PTY. */
export function terminalAuthAvailable(): boolean {
  if (platform() === "win32") return false;
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    try {
      accessSync(join(directory || ".", "script"), constants.X_OK);
      return true;
    } catch {
      // Keep looking: PATH entries commonly do not contain this executable.
    }
  }
  return false;
}
