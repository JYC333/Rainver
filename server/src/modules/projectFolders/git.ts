import { spawn } from "node:child_process";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class GitCommandError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "GitCommandError";
  }
}

export async function runGit(
  args: readonly string[],
  cwd: string,
  timeoutMs = 30_000,
): Promise<CommandResult> {
  return runCommand("git", args, cwd, timeoutMs);
}

export async function gitOutput(
  args: readonly string[],
  cwd: string,
  timeoutMs = 30_000,
): Promise<string> {
  const result = await runGit(args, cwd, timeoutMs);
  if (result.code !== 0) {
    throw new GitCommandError(
      args,
      result.code,
      `git ${args.join(" ")} failed (exit ${result.code}): ${result.stderr.slice(0, 400)}`,
    );
  }
  return result.stdout;
}

export async function isGitRepo(path: string): Promise<boolean> {
  try {
    const result = await runGit(["rev-parse", "--is-inside-work-tree"], path, 10_000);
    return result.code === 0;
  } catch {
    return false;
  }
}

async function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: NodeJS.Timeout;
    const child = spawn(command, [...args], {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult({ code: -1, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult({ code: code ?? -1, stdout, stderr });
    });
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolveResult({ code: -1, stdout, stderr: stderr || "Command timed out." });
    }, timeoutMs);
  });
}
