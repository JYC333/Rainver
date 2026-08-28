import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { WORK_SKILL_FILE_NAME } from "../capabilities/workSkill.js";

/**
 * The work surface for a Run executing in the server's own sandbox.
 *
 * Same three things a dispatched remote Run gets — the control-plane address,
 * this Run's identity, and the Skill — delivered the only way this path can:
 * written into a directory the sandbox already mounts, and named by the paths
 * the runtime will actually see. It replaces a writer that produced a
 * different configuration file for each of three vendors; this writes the same
 * files for every runtime, including one registered tomorrow.
 *
 * It goes in the Run's own HOME rather than its working directory, for two
 * reasons that both bite: a staged directory inside the worktree turns up as
 * an untracked entry in the Run's code patch — reported as a skipped change,
 * so a reviewer can no longer tell a truncated patch from the harness's own
 * files — and a read-only Run's context directory is bound over the workspace
 * entry by entry, so a project with a directory of the same name would have
 * had it replaced. HOME is mounted at a fixed path for every Run and is in
 * neither of those paths.
 */
const STAGED_DIRECTORY = ".rainver";

/** Where the Run's HOME is mounted inside the sandbox, for every runtime. */
const SANDBOX_HOME = "/home/sandbox";

/** The command's own package, so both delivery paths hand over one copy. */
function agentCliSourcePath(): string {
  // `createRequire`, not `import.meta.resolve`: the ESM resolver maps the
  // export without checking the file is there, so a checkout with nothing
  // built would get a `dist/` path that does not exist — and Vitest's module
  // runner does not implement it at all. `require.resolve` honours the same
  // `exports` map and fails when the target is missing, which is what makes
  // the fallback correct. The fallback is a checkout
  // with nothing built, whose TypeScript source runs under Node's own type
  // stripping — but only under an extension that says so, which is why the
  // staged name follows the file actually resolved.
  const require = createRequire(import.meta.url);
  try {
    return require.resolve("@rainver/agent-cli");
  } catch {
    return require.resolve("@rainver/agent-cli/source");
  }
}

export interface SandboxWorkSurface {
  /** Values for the Run's subprocess environment, already sandbox-relative. */
  env: Record<string, string>;
}

/**
 * Writes the command and the Skill under the Run's HOME, and returns the
 * environment naming them where the runtime will find them.
 *
 * The server cannot hand a runtime one of its own filesystem paths: nothing
 * outside the sandbox exists as far as that process is concerned.
 */
export async function stageSandboxWorkSurface(input: {
  /** The Run's HOME on this machine, mounted at `/home/sandbox` in the sandbox. */
  runHome: string;
  apiUrl: string;
  runId: string;
  token: string;
  skill: string;
}): Promise<SandboxWorkSurface> {
  const stagedRoot = join(input.runHome, STAGED_DIRECTORY);
  await mkdir(stagedRoot, { recursive: true, mode: 0o700 });
  const sandboxRoot = `${SANDBOX_HOME}/${STAGED_DIRECTORY}`;

  await writeFile(join(stagedRoot, WORK_SKILL_FILE_NAME), input.skill, {
    encoding: "utf8",
    mode: 0o600,
  });

  // Copied rather than mounted: the sandbox runner is a separate container
  // whose mounts are fixed managed roots, so a file only reaches a Run by
  // being written into one of them. The command has no runtime dependencies,
  // which is what makes one file enough.
  //
  // `.mjs`/`.mts` rather than `.js`/`.ts`: copying the file out of its package
  // leaves behind the `"type": "module"` that gave it its format, so Node
  // would decide from whatever `package.json` happens to be nearest — the
  // Run's own project, which for a CommonJS repository makes the command
  // refuse to start. The `m` settles it wherever the file lands, and the rest
  // of the extension follows the file actually resolved so a TypeScript
  // source is never staged under a name that says it is JavaScript.
  const cliSource = agentCliSourcePath();
  const cliFileName = extname(cliSource) === ".ts" ? "rainver.mts" : "rainver.mjs";
  await writeFile(join(stagedRoot, cliFileName), await readFile(cliSource, "utf8"), {
    encoding: "utf8",
    mode: 0o600,
  });

  // A launcher, for the same reason the daemon writes one: the command is a
  // script, not an executable, and the Skill tells the agent to run
  // `$RAINVER_CLI` directly.
  await writeFile(
    join(stagedRoot, "rainver"),
    `#!/bin/sh\nexec node ${sandboxRoot}/${cliFileName} "$@"\n`,
    { encoding: "utf8", mode: 0o700 },
  );

  return {
    env: {
      RAINVER_API_URL: input.apiUrl,
      RAINVER_RUN_ID: input.runId,
      RAINVER_TOOL_TOKEN: input.token,
      RAINVER_CLI: `${sandboxRoot}/rainver`,
      RAINVER_SKILL_PATH: `${sandboxRoot}/${WORK_SKILL_FILE_NAME}`,
    },
  };
}

/** Exported for the test that asserts the staged layout. */
export const SANDBOX_WORK_SURFACE_DIRECTORY = STAGED_DIRECTORY;
export const SANDBOX_WORK_SURFACE_HOME = SANDBOX_HOME;
