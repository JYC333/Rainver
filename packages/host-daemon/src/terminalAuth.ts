import { LOGIN_TERMINAL_COLS, LOGIN_TERMINAL_ROWS } from "@rainver/protocol";
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

export function terminalShellCommand(command: readonly string[]): string {
  return command.map(part => `'${part.replace(/'/g, "'\\''")}'`).join(" ");
}

/** util-linux and BSD script both relay stdin through a sized PTY. */
export function ptyArgv(command: string[]): { command: string; args: string[] } {
  const sized = `stty cols ${LOGIN_TERMINAL_COLS} rows ${LOGIN_TERMINAL_ROWS} 2>/dev/null; exec ${terminalShellCommand(command)}`;
  if (platform() === "darwin") return { command: "script", args: ["-q", "/dev/null", "sh", "-c", sized] };
  return { command: "script", args: ["-qfec", sized, "/dev/null"] };
}
