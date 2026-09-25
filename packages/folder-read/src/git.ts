import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import type { GitChangedFile } from "./types.js";

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

export interface RunGitOptions {
  /** Extra variables layered over the process environment (e.g. `GIT_INDEX_FILE`). */
  env?: Record<string, string>;
}

export async function runGit(
  args: readonly string[],
  cwd: string,
  timeoutMs = 30_000,
  options: RunGitOptions = {},
): Promise<CommandResult> {
  return runCommand("git", args, cwd, timeoutMs, options);
}

/**
 * Git run by a trusted process (the daemon, the server) inside a checkout an
 * Agent may have written to. A Run that can write `.git/` can make git execute
 * a command of its choosing — a hook, an fsmonitor, a clean/smudge filter
 * driver — and git would run it as whoever called git, outside any namespace
 * the Run itself was confined to (B62/B63). So every such call:
 *
 * - disables hooks and the fsmonitor;
 * - reads which filter drivers the repository's own configuration defines
 *   (`git config --show-scope --get-regexp`, which executes nothing) and
 *   blanks each one that does not come from the machine's global or system
 *   configuration — those are the owner's, `git lfs` among them;
 * - refuses a checkout whose own configuration sets `core.worktree`, which
 *   would point status, `add` and checkout at a directory other than the one
 *   named;
 * - passes `--ignore-submodules=dirty` to `status` and `diff`: to tell whether
 *   a nested repository's work tree is dirty git runs `status` inside it,
 *   under that repository's own configuration, which none of the above
 *   reaches. A nested repository whose commit moved still shows — only its
 *   uncommitted edits are not looked at;
 *
 * and a diff passes `--no-ext-diff --no-textconv` at its call site. The
 * overrides travel as `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`
 * rather than `-c`, which a driver name containing `=` would split wrongly
 * (the fixed ones go as `-c` as well). It fails closed: git older than
 * 2.31 ignores that environment, and a configuration the probe could not
 * read is one whose drivers are unknown, so either refuses the checkout.
 */
const FIXED_OVERRIDES: ReadonlyArray<readonly [string, string]> = [
  ["core.hooksPath", "/dev/null"],
  ["core.fsmonitor", "false"],
  // A nested repository whose commit moved is shown as its commit ids only:
  // `diff.submodule=diff` or a status summary would run git inside it, under
  // its own configuration (an external diff, a textconv, a clean filter).
  ["diff.submodule", "short"],
  ["status.submoduleSummary", "false"],
  // A checkout, reset or merge would otherwise also update each nested
  // repository — under its own configuration, filters included.
  ["submodule.recurse", "false"],
  // A command that writes objects or refs (a merge, a commit) may start
  // `git maintenance run --auto`, which under the checkout's own `gc.*`
  // configuration prunes worktrees, objects and reflogs.
  ["maintenance.auto", "false"],
  ["gc.auto", "0"],
];
const TRUSTED_CONFIG_SCOPES = new Set(["global", "system"]);

export class UntrustedCheckoutConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UntrustedCheckoutConfigError";
  }
}

/**
 * The configuration overrides a checkout needs before git may run in it, as
 * environment. Throws `UntrustedCheckoutConfigError` for a checkout git must
 * not be run in at all. Outside a repository there is no local configuration
 * and only the fixed overrides apply.
 */
export async function untrustedCheckoutGitEnv(cwd: string, timeoutMs = 10_000): Promise<Record<string, string>> {
  await requireEnvironmentConfigGit();
  const overrides: Array<readonly [string, string]> = [...FIXED_OVERRIDES];
  const probe = await runGit(
    ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
      "config", "-z", "--show-scope", "--get-regexp", "^(filter\\..*|core\\.worktree)$"],
    cwd,
    timeoutMs,
  );
  // 0: something matched; 1: nothing did. Anything else — a configuration git
  // cannot read, a probe that did not finish — leaves the drivers unknown.
  if (probe.code !== 0 && probe.code !== 1) {
    throw new UntrustedCheckoutConfigError(`Rainver could not read this checkout's git configuration (git exited ${probe.code}); it does not run git in it.`);
  }
  if (probe.code === 0) {
    const drivers = new Set<string>();
    // `-z`: scope NUL key LF value NUL, repeated.
    const fields = probe.stdout.split("\0");
    for (let index = 0; index + 1 < fields.length; index += 2) {
      const scope = fields[index]!;
      const entry = fields[index + 1]!;
      if (TRUSTED_CONFIG_SCOPES.has(scope)) continue;
      const key = entry.split("\n", 1)[0]!;
      if (key.toLowerCase() === "core.worktree") {
        throw new UntrustedCheckoutConfigError("This checkout's own configuration sets core.worktree; Rainver does not run git in it.");
      }
      const match = /^filter\.(.+)\.[^.]+$/s.exec(key);
      if (match) drivers.add(match[1]!);
    }
    for (const driver of drivers) {
      overrides.push(
        [`filter.${driver}.clean`, ""],
        [`filter.${driver}.smudge`, ""],
        [`filter.${driver}.process`, ""],
        [`filter.${driver}.required`, "false"],
      );
    }
  }
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(overrides.length) };
  overrides.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

/** `GIT_CONFIG_COUNT` configuration arrived in git 2.31; before it the overrides would be ignored. */
const MINIMUM_GIT = [2, 31] as const;
/**
 * The host's git version, once it has been read. Asked in the system's
 * temporary directory, not a caller's checkout (which may not exist); only a
 * version actually read is kept, so a git that could not be started this once
 * is asked again next time rather than refusing every call until a restart.
 */
let gitVersion: readonly [number, number] | null = null;

async function requireEnvironmentConfigGit(): Promise<void> {
  if (!gitVersion) {
    const result = await runGit(["version"], tmpdir(), 10_000);
    const match = /git version (\d+)\.(\d+)/.exec(result.stdout);
    if (!match) {
      throw new UntrustedCheckoutConfigError(
        `git's version could not be read (${result.stdout.trim() || result.stderr.trim() || `exit ${result.code}`}); Rainver does not run git in a checkout an Agent may write without knowing it.`,
      );
    }
    gitVersion = [Number(match[1]), Number(match[2])];
  }
  const [major, minor] = gitVersion;
  if (major > MINIMUM_GIT[0] || (major === MINIMUM_GIT[0] && minor >= MINIMUM_GIT[1])) return;
  throw new UntrustedCheckoutConfigError(
    `git ${major}.${minor} is older than ${MINIMUM_GIT.join(".")}; Rainver needs git ${MINIMUM_GIT.join(".")} or newer to run git in a checkout an Agent may write.`,
  );
}

/**
 * `runGit` for a checkout an Agent may have written; see
 * `untrustedCheckoutGitEnv`. A refused checkout answers like a failed git
 * command (exit 128) rather than throwing, as every other git failure here does.
 */
export async function runLocationGit(
  args: readonly string[],
  cwd: string,
  timeoutMs = 30_000,
  options: RunGitOptions = {},
): Promise<CommandResult> {
  let env: Record<string, string>;
  try {
    env = await untrustedCheckoutGitEnv(cwd, Math.min(timeoutMs, 10_000));
  } catch (error) {
    if (error instanceof UntrustedCheckoutConfigError) return { code: 128, stdout: "", stderr: error.message };
    throw error;
  }
  const [command, ...rest] = args;
  const effective = [
    ...FIXED_OVERRIDES.flatMap(([key, value]) => ["-c", `${key}=${value}`]),
    ...(command === "status" || command === "diff" ? [command, "--ignore-submodules=dirty", ...rest] : args),
  ];
  return runGit(effective, cwd, timeoutMs, { ...options, env: { ...options.env, ...env } });
}

/** `gitOutput` through `runLocationGit`. */
export async function locationGitOutput(
  args: readonly string[],
  cwd: string,
  timeoutMs = 30_000,
): Promise<string> {
  const result = await runLocationGit(args, cwd, timeoutMs);
  if (result.code !== 0) {
    throw new GitCommandError(
      args,
      result.code,
      `git ${args.join(" ")} failed (exit ${result.code}): ${result.stderr.slice(0, 400)}`,
    );
  }
  return result.stdout;
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
    const result = await runLocationGit(["rev-parse", "--is-inside-work-tree"], path, 10_000);
    return result.code === 0;
  } catch {
    return false;
  }
}

/** Ensure a writable managed directory has the Git baseline used by status and diff readers. */
export async function ensureGitRepository(path: string): Promise<boolean> {
  if (await isGitRepo(path)) return true;
  const result = await runGit(["init", "--quiet"], path, 30_000);
  return result.code === 0;
}

export function parsePorcelain(output: string): GitChangedFile[] {
  const result: GitChangedFile[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (line.length < 3) continue;
    const xy = line.slice(0, 2);
    const path = line.slice(3).trim();
    let status = "modified";
    if (xy.includes("?")) status = "untracked";
    else if (xy.includes("R")) status = "renamed";
    else if (xy.includes("D")) status = "deleted";
    else if (xy.includes("A")) status = "added";
    result.push({ path, status });
  }
  return result;
}

async function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  options: RunGitOptions = {},
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
      ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
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
