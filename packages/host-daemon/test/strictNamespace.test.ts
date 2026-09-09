import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { BWRAP_PATH, buildStrictNamespaceCommand } from "../src/strictNamespace.js";
import { daemonRuntimeRoot, launchFailureMessage, planStrictLaunch, runDirForTests as runDir, strictBindsForRun } from "../src/execution.js";
import type { StrictNamespaceRequest } from "../src/strictNamespace.js";

/**
 * The strict namespace is the whole safety model of a shared execution host:
 * a Run on the built-in host is reachable by anyone allowed to dispatch in its
 * Space, and this argv is the only thing between them. These assertions are on
 * the argv rather than on a live `bwrap`, because CI has no bubblewrap and a
 * test that silently skipped would assert nothing at all; a real namespace is
 * part of this phase's on-machine verification.
 */
const base: StrictNamespaceRequest = {
  command: "/usr/bin/agent",
  args: ["--serve"],
  cwd: "/runner/workspaces/project",
  home: "/runner/host/agents/a1/profiles/conversation/c1/opencode/ambient",
  binds: [],
  isolation: { sandbox_mode: "read_write", egress_profile: "default" },
  env: {},
};

/** The `--ro-bind`/`--bind` pairs, as `target → access`. */
function binds(args: string[]): Map<string, "read_only" | "read_write"> {
  const found = new Map<string, "read_only" | "read_write">();
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--ro-bind" || args[i] === "--bind") {
      found.set(args[i + 2]!, args[i] === "--ro-bind" ? "read_only" : "read_write");
    }
  }
  return found;
}

function env(args: string[]): Record<string, string> {
  const found: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--setenv") found[args[i + 1]!] = args[i + 2]!;
  }
  return found;
}

describe("the strict-mode namespace", () => {
  it("starts from an empty root and runs the command through the readiness handshake", () => {
    const { command, args } = buildStrictNamespaceCommand({ ...base });
    expect(command).toBe(BWRAP_PATH);
    expect(args.slice(0, 5)).toEqual(["--die-with-parent", "--new-session", "--unshare-pid", "--tmpfs", "/"]);
    // `exec "$@"` after reporting on fd 3: without it, a namespace that could
    // not be built is indistinguishable from a runtime that exited at once.
    const separator = args.indexOf("--");
    expect(args.slice(separator + 1)).toEqual([
      "/bin/sh",
      "-c",
      'printf \'ready\\n\' >&3; exec "$@"',
      "strict-launch",
      "/usr/bin/agent",
      "--serve",
    ]);
    expect(args.slice(separator - 2, separator)).toEqual(["--chdir", "/runner/workspaces/project"]);
  });

  it("binds the workspace read-only for a read-only Run and read-write otherwise", () => {
    expect(binds(buildStrictNamespaceCommand({ ...base }).args).get("/runner/workspaces/project")).toBe("read_write");
    const readOnly = buildStrictNamespaceCommand({
      ...base,
      isolation: { sandbox_mode: "read_only", egress_profile: "default" },
    });
    expect(binds(readOnly.args).get("/runner/workspaces/project")).toBe("read_only");
    // HOME stays writable either way: a read-only Run still keeps its own
    // session state, and a runtime that cannot write its profile cannot run.
    expect(binds(readOnly.args).get(base.home)).toBe("read_write");
  });

  it("unshares the network only for the `none` egress profile", () => {
    expect(buildStrictNamespaceCommand({ ...base }).args).not.toContain("--unshare-net");
    const isolated = buildStrictNamespaceCommand({
      ...base,
      isolation: { sandbox_mode: "read_write", egress_profile: "none" },
    });
    expect(isolated.args).toContain("--unshare-net");
  });

  it("exposes nothing beyond the system roots, the workspace, HOME and the stated binds", () => {
    const { args } = buildStrictNamespaceCommand({
      ...base,
      binds: [{ path: "/runner/host/runs/run-1", access: "read_write" }],
    });
    const targets = [...binds(args).keys()];
    expect(targets).toContain("/runner/host/runs/run-1");
    // The instance's other authority roots, the daemon's registration, and
    // every sibling workspace are simply absent.
    expect(targets).not.toContain("/runner/host");
    expect(targets).not.toContain("/runner/workspaces");
    expect(targets).not.toContain("/runner/host/config.json");
  });

  it("keeps the widest access when a path is bound twice, and applies parents before children", () => {
    const { args } = buildStrictNamespaceCommand({
      ...base,
      binds: [
        { path: "/tools/opencode", access: "read_only" },
        { path: "/tools/opencode/home", access: "read_write" },
        { path: "/tools/opencode", access: "read_write" },
      ],
    });
    const mounted = binds(args);
    expect(mounted.get("/tools/opencode")).toBe("read_write");
    expect(mounted.get("/tools/opencode/home")).toBe("read_write");
    const order = [...mounted.keys()];
    expect(order.indexOf("/tools/opencode")).toBeLessThan(order.indexOf("/tools/opencode/home"));
  });

  it("sets HOME to the namespace's own home and marks the Run as already isolated", () => {
    const { args } = buildStrictNamespaceCommand({ ...base, env: { LANG: "C.UTF-8" } });
    expect(env(args)).toMatchObject({ HOME: base.home, LANG: "C.UTF-8", RAINVER_STRICT_SANDBOX: "1" });
  });

  it("refuses a relative or unnormalized path rather than building a namespace around it", () => {
    expect(() => buildStrictNamespaceCommand({ ...base, cwd: "relative/path" })).toThrow(/absolute/);
    expect(() => buildStrictNamespaceCommand({ ...base, binds: [{ path: "/runner/../etc", access: "read_only" }] }))
      .toThrow(/absolute/);
  });
});

describe("what a strict Run is given besides its workspace", () => {
  const inputs = {
    runDir: "/runner/host/runs/run-1",
    profileDir: "/runner/host/agents/a1/profiles/conversation/c1/opencode/ambient",
    loginHome: "/runner/host/tools/opencode/1.18/home",
    toolTree: "/runner/host/tools/opencode/1.18",
    runtimeRoot: "/app",
  };

  it("carries the run directory, the Agent's profile, its login home and the daemon's own tree", () => {
    expect(strictBindsForRun(inputs)).toEqual([
      { path: "/runner/host/runs/run-1", access: "read_write" },
      // The ACP adapter this daemon spawns and the `rainver` command it hands
      // the Run both live here; an empty root has neither otherwise.
      { path: "/app", access: "read_only" },
      { path: inputs.profileDir, access: "read_write" },
      // Read-only: the profile links the credential out of it and the daemon
      // never reads the bytes (ADR 0008).
      // Read-only, and it stays read-only: on a shared host this is the
      // instance's one subscription login, and a Run that could rewrite it
      // could bill every other member's Runs to an account of its choosing.
      { path: inputs.loginHome, access: "read_only" },
      // The copy's `home/` is inside its tree, so nothing writable is added
      // for it either.
      { path: inputs.toolTree, access: "read_only" },
    ]);
  });

  it("gives an unbound Run with the machine's own copy no profile or tool tree to leak through", () => {
    expect(strictBindsForRun({ ...inputs, profileDir: null, loginHome: null, toolTree: null }))
      .toEqual([
        { path: "/runner/host/runs/run-1", access: "read_write" },
        { path: "/app", access: "read_only" },
      ]);
  });

  it("resolves the install root, not this package, so its dependency trees are inside it", () => {
    expect(daemonRuntimeRoot("file:///opt/rainver-host/node_modules/@rainver/host-daemon/dist/execution.js"))
      .toBe("/opt/rainver-host");
  });

  it("climbs to the highest ancestor holding a dependency tree when there is no node_modules segment", async () => {
    // The container's layout: the daemon at `<root>/packages/host-daemon/dist`
    // with dependency trees at both `<root>/packages/host-daemon/node_modules`
    // and `<root>/node_modules`. Stopping at the package's own parent would
    // leave the ACP adapter and the `rainver` command outside the namespace.
    const root = await mkdtemp(join(tmpdir(), "rainver-runtime-root-"));
    await mkdir(join(root, "node_modules"), { recursive: true });
    await mkdir(join(root, "packages", "host-daemon", "node_modules"), { recursive: true });
    await mkdir(join(root, "packages", "host-daemon", "dist"), { recursive: true });
    try {
      expect(daemonRuntimeRoot(pathToFileURL(join(root, "packages", "host-daemon", "dist", "execution.js")).href))
        .toBe(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

/**
 * What a strict launch actually hands the agent process.
 *
 * This is where a shared execution host's isolation is decided — the
 * environment, the HOME, the binds — and none of it is observable from a test
 * that would have to spawn `bwrap` to see it. Each assertion here stands for a
 * defect that was in the first cut of this phase.
 */
describe("planning a strict launch", () => {
  const plan = (overrides: Partial<Parameters<typeof planStrictLaunch>[0]> = {}) => planStrictLaunch({ egress: {},
    runId: "run-1",
    runDir: "/runner/host/runs/run-1",
    command: "/usr/bin/agent",
    args: ["--serve"],
    cwd: "/runner/workspaces/project",
    derivedEnv: { RAINVER_OUTPUT_DIR: "/runner/host/runs/run-1/outputs", CLAUDE_CONFIG_DIR: "/profile" },
    ambient: {
      PATH: "/usr/bin",
      LANG: "C.UTF-8",
      HOME: "/runner/host/home",
      // The instance's internal token: `sandbox-runner` receives it through
      // `.runner.env`, and the control plane accepts it as
      // `x-rainver-internal-token` on the internal credential and execution
      // routes, from the very network this namespace shares.
      SANDBOX_RUNNER_TOKEN: "the-instance-internal-token",
      RAINVER_BUILTIN_HOST_CREDENTIAL: "/runner/builtin-host/registration.json",
    },
    isolation: { sandbox_mode: "read_write", egress_profile: "default" },
    profileDir: "/profile",
    loginHome: null,
    toolTree: null,
    runtimeRoot: "/app",
    ...overrides,
  });

  it("gives the agent an allowlisted environment, never this container's own", () => {
    const { env } = plan();
    expect(env).toMatchObject({ PATH: "/usr/bin", LANG: "C.UTF-8", RAINVER_OUTPUT_DIR: "/runner/host/runs/run-1/outputs" });
    // A trusted host keeps the machine's environment because it is the
    // owner's machine. A strict host is nobody's machine and its environment
    // is the instance's.
    expect(env).not.toHaveProperty("SANDBOX_RUNNER_TOKEN");
    expect(env).not.toHaveProperty("RAINVER_BUILTIN_HOST_CREDENTIAL");
    expect(Object.values(env)).not.toContain("the-instance-internal-token");
  });

  it("gives each Run its own HOME instead of one the whole instance shares", () => {
    // The container's HOME, and a managed copy's shared login home, both reach
    // this point as ordinary environment; neither may become the directory a
    // Run writes its vendor history and scratch files into.
    expect(plan().home).toBe("/runner/host/runs/run-1/home");
    expect(plan({ derivedEnv: { HOME: "/runner/host/tools/opencode/1.18/home" } }).home)
      .toBe("/runner/host/runs/run-1/home");
    expect(plan().env.HOME).toBe("/runner/host/runs/run-1/home");
  });

  it("falls closed when the dispatch stated no isolation policy", () => {
    const { args } = plan({ isolation: undefined });
    expect(args).toContain("--unshare-net");
    expect(binds(args).get("/runner/workspaces/project")).toBe("read_only");
  });

  it("refuses a run id that would place the run directory outside the daemon's own", () => {
    // `join` normalizes `../..` away, so the escaped path looks perfectly
    // ordinary by the time a namespace is built around it — which is why the
    // guard is on the id, as it was on the Runner's mount ids.
    expect(() => runDir("../..")).toThrow(/usable directory name/);
    expect(() => runDir("run/../../etc")).toThrow(/usable directory name/);
  });
});

describe("what a strict run's failure is reported as", () => {
  const failure = (overrides: Partial<Parameters<typeof launchFailureMessage>[0]> = {}) => launchFailureMessage({
    namespaceReady: true,
    timedOut: false,
    terminationRequested: false,
    exitCode: 0,
    stderrTail: "",
    ...overrides,
  });

  it("blames the namespace only when nothing else stopped the run", () => {
    expect(failure({ namespaceReady: false, exitCode: 1, stderrTail: "bwrap: Can't find source path" }))
      .toBe("This run's isolation namespace failed to start. bwrap: Can't find source path");
  });

  it("does not blame the namespace for a run something else killed", () => {
    // A cancel and a timeout both stop the child before it can report on
    // fd 3. Reporting a namespace failure there would blame the isolation for
    // a run that was working — and `timed_out` alone does not distinguish a
    // deliberate cancel.
    expect(failure({ namespaceReady: false, terminationRequested: true, exitCode: 143, stderrTail: "" })).toBeNull();
    expect(failure({ namespaceReady: false, timedOut: true, exitCode: 137, stderrTail: "" })).toBeNull();
  });

  it("reports an ordinary non-zero exit the way it always did", () => {
    expect(failure({ exitCode: 2, stderrTail: "usage: agent" })).toBe("usage: agent");
    expect(failure({ exitCode: 0, stderrTail: "a warning" })).toBeNull();
  });
});
