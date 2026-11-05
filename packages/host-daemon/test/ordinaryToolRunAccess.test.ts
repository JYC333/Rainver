import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Fault injection for the one branch a real process group cannot be made to
 * take on demand: `settleProcessGroup` failing. Test-only module mock; the
 * daemon has no switch for it.
 */
const settleControl = vi.hoisted(() => ({ failNext: false, gate: null as Promise<void> | null }));
vi.mock("../src/processGroup.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/processGroup.js")>();
  return {
    ...original,
    settleProcessGroup: (...args: Parameters<typeof original.settleProcessGroup>) => {
      if (!settleControl.failNext) return original.settleProcessGroup(...args);
      settleControl.failNext = false;
      // Optionally held, so a test can have something waiting when it fails.
      const gate = settleControl.gate ?? Promise.resolve();
      settleControl.gate = null;
      return gate.then(() => Promise.reject(new Error("injected: process group state unreadable")));
    },
  };
});
import { saveConfig } from "../src/config.js";
import { handleLaunch, hasInFlightRuns, planStrictLaunch, runDirForTests, setEgressProxy, sweepStaleRunProfiles, withRuntimeKeyDrained } from "../src/execution.js";
import { startEgressProxy } from "../src/egressProxy.js";
import { connect } from "node:net";
import { isLeaseBusy } from "../src/locationLease.js";
import {
  closeAllOrdinaryAccountSessions,
  handleOrdinaryAccountRequest,
  openOrdinaryAccountSession,
  ordinaryAccountRoot,
} from "../src/ordinaryToolAccounts.js";
import { applyRunOrdinaryToolsEnv, prepareRunOrdinaryTools, resolvesWithin } from "../src/ordinaryToolRunAccess.js";
import { buildStrictNamespaceCommand } from "../src/strictNamespace.js";
import { symlink } from "node:fs/promises";
import { __clearOrdinaryToolVersionCache, handleOrdinaryToolAction, ordinaryToolsRoot } from "../src/ordinaryTools.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
let root: string;
let configDir: string;
let savedEnv: NodeJS.ProcessEnv;
let scratchCount = 0;
/** A fresh Run directory, as `execution.ts` passes `runs/<id>`. */
const scratch = () => join(root, "run-scratch", String(++scratchCount));
const daemonRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * A `/bin/sh` stand-in for lark-cli that works inside an empty-root namespace:
 * `refresh` rewrites a token file in the data directory the way the real CLI
 * persists a refreshed token, and `whoami` prints the configured user.
 */
const FAKE_LARK = `#!/bin/sh
case "$1" in
  --version) echo "lark-cli version 1.0.99" ;;
  refresh) n=$(cat "$LARKSUITE_CLI_DATA_DIR/token" 2>/dev/null || echo 0); echo $((n + 1)) > "$LARKSUITE_CLI_DATA_DIR/token" ;;
  whoami) cat "\${LARKSUITE_CLI_CONFIG_DIR:-$HOME/.lark-cli}/user" 2>/dev/null || echo "(nobody)"; echo ;;
  auth) while [ -e "$(dirname "$0")/logout-gate" ]; do sleep 0.05; done; echo '{"ok":true,"loggedOut":false,"reason":"not_configured"}' ;;
  *) exit 2 ;;
esac
`;

/** A Rainver-managed copy, as P1 promotes it. */
async function installManagedLark() {
  const dir = join(ordinaryToolsRoot(), "managed", "lark_cli", "1.0.99");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "lark-cli"), FAKE_LARK);
  await chmod(join(dir, "lark-cli"), 0o755);
  await writeFile(join(dir, "manifest.json"), JSON.stringify({ tool_id: "lark_cli", version: "1.0.99", cmd: "lark-cli", installed_at: new Date().toISOString() }));
  return dir;
}

async function seedAccount(key: string, user: string) {
  const state = ordinaryAccountRoot("lark_cli", key);
  await mkdir(join(state, "config"), { recursive: true });
  await mkdir(join(state, "data"), { recursive: true });
  await writeFile(join(state, "config", "user"), user);
  await writeFile(join(state, "data", "token"), "0");
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "rainver-ordinary-run-"));
  configDir = join(root, "config");
  await mkdir(configDir);
  savedEnv = { ...process.env };
  process.env.RAINVER_HOST_CONFIG_DIR = configDir;
  process.env.PATH = "/usr/bin:/bin";
  process.env.LARKSUITE_CLI_APP_SECRET = "inherited-secret";
  process.env.OPENCLAW_HOME = "/elsewhere";
  process.env.ANTHROPIC_API_KEY = "provider-key";
  __clearOrdinaryToolVersionCache();
});

afterEach(async () => {
  closeAllOrdinaryAccountSessions();
  process.env = savedEnv;
  await rm(root, { recursive: true, force: true });
});

describe("ordinary tools in a Run", () => {
  it("changes nothing for a launch without the field, and never picks an account the launch did not name", async () => {
    expect(await prepareRunOrdinaryTools(undefined, true, { scratchParent: scratch() })).toBeNull();
    await installManagedLark();
    await seedAccount(A, "Alice");
    const tools = (await prepareRunOrdinaryTools({ accounts: [] }, true, { scratchParent: scratch() }))!;
    // Explicit, empty and this Run's own: never the Host's default login.
    expect(tools.env.LARKSUITE_CLI_CONFIG_DIR).toMatch(new RegExp(`^${join(root, "run-scratch", String(scratchCount))}/ordinary-tools-[^/]+/config$`));
    expect(JSON.parse(tools.env.RAINVER_ORDINARY_TOOLS!).accounts).toEqual({ "lark-cli": "none" });
    expect(tools.binds.some((bind) => bind.path.includes("ordinary-tool-state"))).toBe(false);
    expect(tools.binds.filter((bind) => bind.access === "read_write").map((bind) => bind.path))
      .toEqual([tools.env.LARKSUITE_CLI_CONFIG_DIR, tools.env.LARKSUITE_CLI_DATA_DIR]);
    tools.release();
  });

  it("reports what each mode can actually provide", async () => {
    const elsewhere = join(root, "opt");
    await mkdir(elsewhere);
    await writeFile(join(elsewhere, "lark-cli"), FAKE_LARK);
    await chmod(join(elsewhere, "lark-cli"), 0o755);
    expect((await handleOrdinaryToolAction({ action: "register", tool_id: "lark_cli", path: join(elsewhere, "lark-cli") }, () => {})).ok).toBe(true);
    await seedAccount(A, "Alice");
    // A registered copy outside the system roots has an unknown dependency
    // closure: a strict namespace does not get it, and no account is offered.
    const strict = (await prepareRunOrdinaryTools({ accounts: [{ tool_id: "lark_cli", account_key: A }] }, true, { scratchParent: scratch() }))!;
    expect(JSON.parse(strict.env.RAINVER_ORDINARY_TOOLS!)).toMatchObject({ tools: { "lark-cli": "not_in_sandbox", jq: expect.any(String) }, accounts: { "lark-cli": "tool_unavailable" } });
    strict.release();
    // A trusted Host's Run uses it where it is.
    const trusted = (await prepareRunOrdinaryTools({ accounts: [{ tool_id: "lark_cli", account_key: A }] }, false, { scratchParent: scratch() }))!;
    expect(trusted.pathPrefix).toEqual([elsewhere]);
    expect(trusted.binds).toEqual([]);
    expect(JSON.parse(trusted.env.RAINVER_ORDINARY_TOOLS!).accounts).toEqual({ "lark-cli": "personal" });
    trusted.release();
    // macOS cannot keep accounts apart, so none is provided there.
    const mac = (await prepareRunOrdinaryTools({ accounts: [{ tool_id: "lark_cli", account_key: A }] }, false, { scratchParent: scratch(), platform: "darwin" }))!;
    expect(JSON.parse(mac.env.RAINVER_ORDINARY_TOOLS!).accounts).toEqual({ "lark-cli": "unsupported" });
    expect(mac.env.LARKSUITE_CLI_CONFIG_DIR).toContain(join(root, "run-scratch"));
    mac.release();
  });

  it("keeps the account and the binary held until the Run releases them, sharing only with the same person", async () => {
    await installManagedLark();
    await seedAccount(A, "Alice");
    const run = (await prepareRunOrdinaryTools({ accounts: [{ tool_id: "lark_cli", account_key: A }] }, true, { scratchParent: scratch() }))!;
    expect(await handleOrdinaryAccountRequest({ tool_id: "lark_cli", account_key: A, action: "logout" })).toMatchObject({ ok: false, error: "account_in_use_by_run" });
    const login: unknown[] = [];
    await openOrdinaryAccountSession({ session_id: "s-1", tool_id: "lark_cli", account_key: A, flow: "login" }, (event) => login.push(event));
    expect(login).toEqual([{ kind: "exit", outcome: "failed", error: "account_in_use_by_run", status: null }]);
    expect(await handleOrdinaryToolAction({ action: "remove", tool_id: "lark_cli", source: "managed" }, () => {})).toMatchObject({ ok: false, error: expect.stringMatching(/in use/) });
    // Another person's account is independent; a second Run of the same person shares.
    expect((await handleOrdinaryAccountRequest({ tool_id: "lark_cli", account_key: B, action: "logout" })).ok).toBe(true);
    const second = (await prepareRunOrdinaryTools({ accounts: [{ tool_id: "lark_cli", account_key: A }] }, true, { scratchParent: scratch() }))!;
    expect(JSON.parse(second.env.RAINVER_ORDINARY_TOOLS!).accounts).toEqual({ "lark-cli": "personal" });
    run.release();
    run.release();
    expect(await handleOrdinaryAccountRequest({ tool_id: "lark_cli", account_key: A, action: "logout" })).toMatchObject({ ok: false, error: "account_in_use_by_run" });
    second.release();
    expect((await handleOrdinaryAccountRequest({ tool_id: "lark_cli", account_key: A, action: "logout" })).ok).toBe(true);
    expect((await handleOrdinaryToolAction({ action: "remove", tool_id: "lark_cli", source: "managed" }, () => {})).ok).toBe(true);
  });

  it.skipIf(!existsSync("/usr/bin/bwrap"))("gives each person's strict Run only their own account, persisting refresh in place", async () => {
    await installManagedLark();
    await seedAccount(A, "Alice");
    await seedAccount(B, "Bob");
    await writeFile(join(configDir, "config.json"), "{\"token\":\"daemon-registration\"}");
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const probe = async (key: string) => {
      const tools = (await prepareRunOrdinaryTools({ accounts: [{ tool_id: "lark_cli", account_key: key }] }, true, { scratchParent: scratch() }))!;
      const runDir = join(root, "runs", key.slice(0, 4));
      await mkdir(join(runDir, "home"), { recursive: true });
      const plan = planStrictLaunch({
        runId: `run-${key.slice(0, 4)}`, runDir, command: "/bin/sh",
        args: ["-c", [
          "lark-cli refresh && lark-cli whoami",
          'for p in "$@"; do if [ -e "$p" ]; then echo "visible:$p"; else echo "absent:$p"; fi; done',
          "env | grep -E '^(LARKSUITE_CLI_APP_SECRET|OPENCLAW|ANTHROPIC)' || echo no-ambient",
          'echo "home=$HOME"; command -v sh',
        ].join("; "), "probe",
        ordinaryAccountRoot("lark_cli", key === A ? B : A), join(configDir, "config.json"),
        join(configDir, "ordinary-tools", "registrations.json"), join(ordinaryAccountRoot("lark_cli", key), "home"), join(homedir(), ".bashrc")],
        cwd: workspace, derivedEnv: {}, ambient: process.env,
        isolation: { sandbox_mode: "read_write", egress_profile: "none" }, egress: {},
        profileDir: null, loginHome: null, toolTree: null, runtimeRoot: daemonRoot,
        ordinaryToolBinds: tools.binds,
      });
      const env = applyRunOrdinaryToolsEnv(plan.env, tools);
      const output = await new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = spawn(plan.command, plan.args, { env, stdio: ["ignore", "pipe", "pipe", "pipe"] });
        let out = "";
        child.stdout!.on("data", (chunk: Buffer) => { out += chunk.toString(); });
        child.stderr!.on("data", (chunk: Buffer) => { out += chunk.toString(); });
        child.on("close", (code) => resolve({ code, out }));
      });
      tools.release();
      return output;
    };
    const alice = await probe(A);
    expect(alice.code).toBe(0);
    const lines = alice.out.trim().split("\n");
    expect(lines[0]).toBe("Alice");
    // Bob's state, the daemon's registration and file map, Alice's account HOME and the Host user's HOME are absent.
    expect(lines.slice(1, 6).every((line) => line.startsWith("absent:"))).toBe(true);
    expect(alice.out).toContain("no-ambient");
    expect(alice.out).toContain(`home=${join(root, "runs", "aaaa", "home")}`);
    // The refresh landed in Alice's own data directory, on the Host.
    expect(await readFile(join(ordinaryAccountRoot("lark_cli", A), "data", "token"), "utf8")).toBe("1\n");
    expect(await readFile(join(ordinaryAccountRoot("lark_cli", B), "data", "token"), "utf8")).toBe("0");
    const again = await probe(A);
    expect(again.out.split("\n")[0]).toBe("Alice");
    expect(await readFile(join(ordinaryAccountRoot("lark_cli", A), "data", "token"), "utf8")).toBe("2\n");
    const bob = await probe(B);
    expect(bob.out.split("\n")[0]).toBe("Bob");
    expect(await readFile(join(ordinaryAccountRoot("lark_cli", B), "data", "token"), "utf8")).toBe("1\n");
  });

  it("holds the account for a trusted Run until its process exits", async () => {
    const elsewhere = join(root, "opt");
    await mkdir(elsewhere);
    await writeFile(join(elsewhere, "lark-cli"), FAKE_LARK);
    await chmod(join(elsewhere, "lark-cli"), 0o755);
    expect((await handleOrdinaryToolAction({ action: "register", tool_id: "lark_cli", path: join(elsewhere, "lark-cli") }, () => {})).ok).toBe(true);
    await seedAccount(A, "Alice");
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await saveConfig({ server_url: "http://127.0.0.1:9", host_id: "host-1", trust: "trusted", token: "t", workspaces: { "folder-1": workspace } });
    const gate = join(root, "gate");
    await writeFile(gate, "");
    const frames: Array<Record<string, unknown>> = [];
    await handleLaunch({
      run_id: "run-trusted", launch_id: "launch-trusted", workspace_location_id: "folder-1",
      argv: ["sh", "-c", `lark-cli whoami; printenv LARKSUITE_CLI_APP_SECRET || echo no-secret; while [ -e ${gate} ]; do sleep 0.05; done`],
      ordinary_tools: { accounts: [{ tool_id: "lark_cli", account_key: A }] },
    }, (frame) => frames.push(frame as Record<string, unknown>), () => {});
    await expect.poll(() => frames.filter((frame) => frame.type === "output").map((frame) => frame.chunk).join("")).toContain("no-secret");
    expect(frames.filter((frame) => frame.type === "output").map((frame) => frame.chunk).join("")).toContain("Alice");
    expect(await handleOrdinaryAccountRequest({ tool_id: "lark_cli", account_key: A, action: "logout" })).toMatchObject({ error: "account_in_use_by_run" });
    await rm(gate);
    await expect.poll(() => frames.some((frame) => frame.type === "complete"), { timeout: 15_000 }).toBe(true);
    expect(frames.find((frame) => frame.type === "complete")).toMatchObject({ exit_code: 0 });
    expect((await handleOrdinaryAccountRequest({ tool_id: "lark_cli", account_key: A, action: "logout" })).ok).toBe(true);
  });
});

describe("review fixes", () => {
  /** The Host user's own default lark-cli login, which no Run without a personal account may use. */
  async function hostDefaultLogin() {
    const hostHome = join(root, "host-home");
    await mkdir(join(hostHome, ".lark-cli"), { recursive: true });
    await writeFile(join(hostHome, ".lark-cli", "user"), "HostOwner");
    process.env.HOME = hostHome;
  }
  const whoami = (tools: Awaited<ReturnType<typeof prepareRunOrdinaryTools>>, command: string) => new Promise<string>((resolveRun) => {
    const child = spawn(command, ["whoami"], { env: applyRunOrdinaryToolsEnv({ ...process.env } as Record<string, string>, tools!) });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    child.on("close", () => resolveRun(out.trim()));
  });

  it("gives a Run without a personal account an empty CLI state of its own, never the Host's default login", async () => {
    await hostDefaultLogin();
    const managed = await installManagedLark();
    await seedAccount(A, "Alice");
    const command = join(managed, "lark-cli");
    const none = await prepareRunOrdinaryTools({ accounts: [] }, false, { scratchParent: scratch() });
    const unsupported = await prepareRunOrdinaryTools({ accounts: [{ tool_id: "lark_cli", account_key: A }] }, false, { scratchParent: scratch(), platform: "darwin" });
    // Busy: Alice's logout is in progress.
    await writeFile(join(managed, "logout-gate"), "");
    const logout = handleOrdinaryAccountRequest({ tool_id: "lark_cli", account_key: A, action: "logout" });
    const busy = await prepareRunOrdinaryTools({ accounts: [{ tool_id: "lark_cli", account_key: A }] }, false, { scratchParent: scratch() });
    expect(JSON.parse(busy!.env.RAINVER_ORDINARY_TOOLS!).accounts).toEqual({ "lark-cli": "busy" });
    for (const tools of [none, unsupported, busy]) {
      expect(await whoami(tools, command)).toBe("(nobody)");
      expect(tools!.env.LARKSUITE_CLI_CONFIG_DIR).toContain(join(root, "run-scratch"));
      tools!.release();
    }
    await rm(join(managed, "logout-gate"));
    expect((await logout).ok).toBe(true);
    // The person's own account still answers as them; the Host's default is untouched.
    const personal = await prepareRunOrdinaryTools({ accounts: [{ tool_id: "lark_cli", account_key: A }] }, false, { scratchParent: scratch() });
    expect(await whoami(personal, command)).toBe("Alice");
    personal!.release();
    expect(await readFile(join(root, "host-home", ".lark-cli", "user"), "utf8")).toBe("HostOwner");
  });

  it("does the same for a trusted Run launched with no account", async () => {
    await hostDefaultLogin();
    const managed = await installManagedLark();
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await saveConfig({ server_url: "http://127.0.0.1:9", host_id: "host-1", trust: "trusted", token: "t", workspaces: { "folder-1": workspace } });
    const frames: Array<Record<string, unknown>> = [];
    await handleLaunch({ run_id: "run-none", launch_id: "launch-none", workspace_location_id: "folder-1",
      argv: ["sh", "-c", "lark-cli whoami"], ordinary_tools: { accounts: [] } }, (frame) => frames.push(frame as Record<string, unknown>), () => {});
    await expect.poll(() => frames.some((frame) => frame.type === "complete"), { timeout: 15_000 }).toBe(true);
    const output = frames.filter((frame) => frame.type === "output").map((frame) => frame.chunk).join("");
    expect(output).toContain("(nobody)");
    expect(output).not.toContain("HostOwner");
    expect(managed).toBeTruthy();
  });

  it("calls a tool visible in a strict namespace only when it resolves inside the bound roots", async () => {
    // A temporary stand-in for a system root; the real /usr is not modified.
    const sysroot = join(root, "sysroot");
    const outside = join(root, "outside");
    for (const dir of [join(sysroot, "bin"), join(sysroot, "lib"), outside]) await mkdir(dir, { recursive: true });
    await writeFile(join(outside, "lark-cli"), FAKE_LARK);
    await chmod(join(outside, "lark-cli"), 0o755);
    await symlink(join(outside, "lark-cli"), join(sysroot, "bin", "lark-cli"));
    await writeFile(join(sysroot, "lib", "jq-real"), "#!/bin/sh\necho jq-1.7.1\n");
    await chmod(join(sysroot, "lib", "jq-real"), 0o755);
    await symlink("../lib/jq-real", join(sysroot, "bin", "jq"));
    // In, out, back in: the middle hop is not visible either.
    await symlink(join(sysroot, "lib", "jq-real"), join(outside, "hop"));
    await symlink(join(outside, "hop"), join(sysroot, "bin", "jq-hop"));
    const roots = [`${sysroot}/`];
    expect(resolvesWithin(join(sysroot, "bin", "jq"), roots)).toBe(true);
    expect(resolvesWithin(join(sysroot, "bin", "lark-cli"), roots)).toBe(false);
    expect(resolvesWithin(join(sysroot, "bin", "jq-hop"), roots)).toBe(false);

    for (const [tool_id, path] of [["lark_cli", join(sysroot, "bin", "lark-cli")], ["jq", join(sysroot, "bin", "jq")]] as const) {
      expect((await handleOrdinaryToolAction({ action: "register", tool_id, path }, () => {})).ok).toBe(true);
    }
    await seedAccount(A, "Alice");
    const strict = (await prepareRunOrdinaryTools({ accounts: [{ tool_id: "lark_cli", account_key: A }] }, true, { scratchParent: scratch(), systemRoots: roots }))!;
    expect(JSON.parse(strict.env.RAINVER_ORDINARY_TOOLS!)).toMatchObject({ tools: { "lark-cli": "not_in_sandbox", jq: "available" }, accounts: { "lark-cli": "tool_unavailable" } });
    expect(strict.binds.some((bind) => bind.path.startsWith(outside))).toBe(false);
    strict.release();

    if (!existsSync("/usr/bin/bwrap")) return;
    // The decision matches a real namespace that binds the stand-in root as a system root.
    const plan = buildStrictNamespaceCommand({
      command: "/bin/sh",
      args: ["-c", `${join(sysroot, "bin", "jq")}; ${join(sysroot, "bin", "lark-cli")} --version || echo lark-unreachable; ${join(sysroot, "bin", "jq-hop")} || echo hop-unreachable`],
      cwd: sysroot, home: join(root, "ns-home"), binds: [{ path: sysroot, access: "read_only" }],
      isolation: { sandbox_mode: "read_only", egress_profile: "none" }, env: { PATH: "/usr/bin:/bin" },
    });
    await mkdir(join(root, "ns-home"), { recursive: true });
    const out = await new Promise<string>((resolveRun) => {
      const child = spawn(plan.command, plan.args, { env: plan.env, stdio: ["ignore", "pipe", "pipe", "pipe"] });
      let text = "";
      child.stdout!.on("data", (chunk: Buffer) => { text += chunk.toString(); });
      child.on("close", () => resolveRun(text));
    });
    expect(out).toContain("jq-1.7.1");
    expect(out).toContain("lark-unreachable");
    expect(out).toContain("hop-unreachable");
  });

  it("rejects a parent directory that leaves the system roots, even when it links back", async () => {
    const sysroot = join(root, "sysroot2");
    const outside = join(root, "outside2");
    await mkdir(join(sysroot, "usr", "bin"), { recursive: true });
    await mkdir(join(sysroot, "usr", "local"), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(sysroot, "usr", "bin", "jq"), "#!/bin/sh\necho jq-1.7.1\n");
    await chmod(join(sysroot, "usr", "bin", "jq"), 0o755);
    // /usr/local/bin -> /opt/bridge -> /usr/bin: the file is ordinary and its real path is inside.
    await symlink(join(sysroot, "usr", "bin"), join(outside, "bridge"));
    await symlink(join(outside, "bridge"), join(sysroot, "usr", "local", "bin"));
    // An ordinary directory link between bound places stays visible.
    await symlink("bin", join(sysroot, "usr", "sbin"));
    const roots = [`${sysroot}/`];
    expect(resolvesWithin(join(sysroot, "usr", "local", "bin", "jq"), roots)).toBe(false);
    expect(resolvesWithin(join(sysroot, "usr", "sbin", "jq"), roots)).toBe(true);
    expect(resolvesWithin(join(sysroot, "usr", "bin", "jq"), roots)).toBe(true);

    expect((await handleOrdinaryToolAction({ action: "register", tool_id: "jq", path: join(sysroot, "usr", "local", "bin", "jq") }, () => {})).ok).toBe(true);
    const strict = (await prepareRunOrdinaryTools({ accounts: [] }, true, { scratchParent: scratch(), systemRoots: roots }))!;
    expect(JSON.parse(strict.env.RAINVER_ORDINARY_TOOLS!).tools.jq).toBe("not_in_sandbox");
    expect(strict.binds.some((bind) => bind.path.startsWith(outside))).toBe(false);
    strict.release();

    if (!existsSync("/usr/bin/bwrap")) return;
    const plan = buildStrictNamespaceCommand({
      command: "/bin/sh",
      args: ["-c", `${join(sysroot, "usr", "local", "bin", "jq")} || echo bridge-unreachable; ${join(sysroot, "usr", "sbin", "jq")}`],
      cwd: sysroot, home: join(root, "ns-home2"), binds: [{ path: sysroot, access: "read_only" }],
      isolation: { sandbox_mode: "read_only", egress_profile: "none" }, env: { PATH: "/usr/bin:/bin" },
    });
    await mkdir(join(root, "ns-home2"), { recursive: true });
    const out = await new Promise<string>((resolveRun) => {
      const child = spawn(plan.command, plan.args, { env: plan.env, stdio: ["ignore", "pipe", "pipe", "pipe"] });
      let text = "";
      child.stdout!.on("data", (chunk: Buffer) => { text += chunk.toString(); });
      child.on("close", () => resolveRun(text));
    });
    expect(out).toContain("bridge-unreachable");
    expect(out).toContain("jq-1.7.1");
  });

  it("gives every launch attempt a fresh empty state, whatever an earlier attempt left in the Run directory", async () => {
    await hostDefaultLogin();
    const managed = await installManagedLark();
    await seedAccount(A, "Alice");
    const command = join(managed, "lark-cli");
    const runDirectory = scratch();
    const first = (await prepareRunOrdinaryTools({ accounts: [] }, false, { scratchParent: runDirectory }))!;
    first.release();
    // An earlier attempt's state, a link to someone's account inside it, and a planted link beside it.
    await writeFile(join(first.env.LARKSUITE_CLI_CONFIG_DIR!, "user"), "Ghost");
    await rm(first.env.LARKSUITE_CLI_DATA_DIR!, { recursive: true });
    await symlink(join(ordinaryAccountRoot("lark_cli", A), "data"), first.env.LARKSUITE_CLI_DATA_DIR!);
    await symlink(join(ordinaryAccountRoot("lark_cli", A), "config"), join(runDirectory, "ordinary-tools-planted"));
    const second = (await prepareRunOrdinaryTools({ accounts: [] }, false, { scratchParent: runDirectory }))!;
    expect(second.env.LARKSUITE_CLI_CONFIG_DIR).not.toBe(first.env.LARKSUITE_CLI_CONFIG_DIR);
    expect(dirname(second.env.LARKSUITE_CLI_CONFIG_DIR!)).not.toBe(join(runDirectory, "ordinary-tools-planted"));
    expect(await whoami(second, command)).toBe("(nobody)");
    second.release();
    // Nothing of Alice's was emptied or rewritten.
    expect(await readFile(join(ordinaryAccountRoot("lark_cli", A), "config", "user"), "utf8")).toBe("Alice");
    expect(await readFile(join(ordinaryAccountRoot("lark_cli", A), "data", "token"), "utf8")).toBe("0");

    // A Run directory that is itself a link is refused rather than followed.
    const linked = join(root, "linked-run");
    await symlink(ordinaryAccountRoot("lark_cli", A), linked);
    await expect(prepareRunOrdinaryTools({ accounts: [] }, false, { scratchParent: linked })).rejects.toThrow(/not a plain directory/);
    expect((await readdir(ordinaryAccountRoot("lark_cli", A))).sort()).toEqual(["config", "data"]);
    // The personal account still persists in place.
    const personal = (await prepareRunOrdinaryTools({ accounts: [{ tool_id: "lark_cli", account_key: A }] }, false, { scratchParent: scratch() }))!;
    expect(personal.env.LARKSUITE_CLI_DATA_DIR).toBe(join(ordinaryAccountRoot("lark_cli", A), "data"));
    personal.release();
  });

  it("finishes nothing — diff, Location, run directory, complete, tool or account — until a background command the Run left behind has exited", async () => {
    const managed = await installManagedLark();
    await seedAccount(A, "Alice");
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    for (const args of [["init", "-q"], ["config", "user.email", "t@example.test"], ["config", "user.name", "t"], ["commit", "-q", "--allow-empty", "-m", "base"]]) {
      execFileSync("git", args, { cwd: workspace });
    }
    // Receives the Run's diff upload, as the control plane would.
    const uploads: string[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      request.on("end", () => { if (request.url?.endsWith("/diff")) uploads.push(body); response.end("{}"); });
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const port = (server.address() as { port: number }).port;
    await saveConfig({ server_url: `http://127.0.0.1:${port}`, host_id: "host-1", trust: "trusted", token: "t", workspaces: { "folder-1": workspace } });
    const alive = join(root, "background-alive");
    // The runtime starts a command with redirected stdio and exits at once.
    // Asked to stop, the command takes two seconds and writes into the
    // workspace on its way out — a write the Run's diff must not miss.
    const background = `( trap 'sleep 2; echo late > ${join(workspace, "late.txt")}; exit 0' TERM; touch ${alive}; while :; do lark-cli whoami >/dev/null; sleep 0.05; done ) </dev/null >/dev/null 2>&1 & echo started`;
    const frames: Array<Record<string, unknown>> = [];
    await handleLaunch({ run_id: "run-bg", launch_id: "launch-bg", workspace_location_id: "folder-1",
      argv: ["sh", "-c", background], ordinary_tools: { accounts: [{ tool_id: "lark_cli", account_key: A }] } },
    (frame) => frames.push(frame as Record<string, unknown>), () => {});
    await expect.poll(() => frames.some((frame) => frame.type === "output" && String(frame.chunk).includes("started"))).toBe(true);
    await expect.poll(() => existsSync(alive)).toBe(true);
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    // The runtime has exited; its command has not. Everything is still held.
    expect(frames.some((frame) => frame.type === "complete")).toBe(false);
    expect(isLeaseBusy("folder-1")).toBe(true);
    expect(existsSync(runDirForTests("run-bg"))).toBe(true);
    expect(existsSync(join(workspace, "late.txt"))).toBe(false);
    expect(await handleOrdinaryAccountRequest({ tool_id: "lark_cli", account_key: A, action: "logout" })).toMatchObject({ ok: false, error: "account_in_use_by_run" });
    expect(await handleOrdinaryToolAction({ action: "remove", tool_id: "lark_cli", source: "managed" }, () => {})).toMatchObject({ ok: false, error: expect.stringMatching(/in use/) });
    // Only once it has gone — its last write included — does the Run finish.
    await expect.poll(() => frames.some((frame) => frame.type === "complete"), { timeout: 15_000 }).toBe(true);
    expect(await readFile(join(workspace, "late.txt"), "utf8")).toBe("late\n");
    expect(frames.find((frame) => frame.type === "complete")).toMatchObject({ exit_code: 0, error: null });
    expect(isLeaseBusy("folder-1")).toBe(false);
    expect(existsSync(runDirForTests("run-bg"))).toBe(false);
    expect((await handleOrdinaryAccountRequest({ tool_id: "lark_cli", account_key: A, action: "logout" })).ok).toBe(true);
    expect((await handleOrdinaryToolAction({ action: "remove", tool_id: "lark_cli", source: "managed" }, () => {})).ok).toBe(true);
    // The diff the Run reported includes the write made after its runtime exited.
    expect(uploads.some((body) => body.includes("late.txt"))).toBe(true);
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    expect(managed).toBeTruthy();
  }, 30_000);
});

// Last in this file on purpose: what it checks is that nothing is released,
// so its account, Location and tool lease stay held for the rest of this
// worker. It uses its own account key, Location and run id.
describe("a Run whose leftover processes cannot be confirmed stopped", () => {
  it("fails without snapshot, upload or cleanup, and keeps everything it holds", async () => {
    await installManagedLark();
    const key = "e".repeat(40);
    await seedAccount(key, "Erin");
    const workspace = join(root, "workspace-fail");
    await mkdir(workspace);
    const requests: string[] = [];
    const server = createServer((request, response) => { requests.push(request.url ?? ""); response.end("{}"); });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const port = (server.address() as { port: number }).port;
    const workspaceB = join(root, "workspace-fail-b");
    await mkdir(workspaceB);
    await saveConfig({ server_url: `http://127.0.0.1:${port}`, host_id: "host-1", trust: "trusted", token: "t", workspaces: { "folder-fail": workspace, "folder-fail-b": workspaceB } });
    // A real egress proxy holding this Run's grant, as a strict Host's would.
    const proxy = await startEgressProxy(() => {});
    setEgressProxy(proxy, `http://127.0.0.1:${port}`);
    const grant = proxy.grant("run-unsettled", "default", { mode: "direct" });
    const refusedThroughGrant = () => new Promise<void>((resolveRefusal) => {
      const [host, proxyPort] = proxy.address.split(":");
      const socket = connect(Number(proxyPort), host);
      const done = () => { socket.destroy(); resolveRefusal(); };
      socket.setTimeout(5000, done);
      socket.on("error", done);
      socket.on("data", done);
      socket.on("connect", () => {
        const auth = Buffer.from(`run:${grant.token}`).toString("base64");
        socket.write(`CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: registry.npmjs.org:443\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`);
      });
    });
    settleControl.failNext = true;
    const frames: Array<Record<string, unknown>> = [];
    await handleLaunch({ run_id: "run-unsettled", launch_id: "launch-unsettled", workspace_location_id: "folder-fail", runtime_key: "acp_fake",
      argv: ["sh", "-c", "echo started; echo change > changed.txt"], ordinary_tools: { accounts: [{ tool_id: "lark_cli", account_key: key }] } },
    (frame) => frames.push(frame as Record<string, unknown>), () => {});
    await expect.poll(() => frames.some((frame) => frame.type === "complete"), { timeout: 15_000 }).toBe(true);
    // A failure, never a success, and nothing pretends to be a finished Run.
    expect(frames.find((frame) => frame.type === "complete")).toMatchObject({ exit_code: 1, error: expect.stringMatching(/could not be confirmed stopped/) });
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
    expect(requests.filter((url) => url.includes("/diff") || url.includes("/outputs"))).toEqual([]);
    // Kept for recovery: the directory (also through a reconnect sweep), the Location, the tool and the account.
    expect(existsSync(runDirForTests("run-unsettled"))).toBe(true);
    await sweepStaleRunProfiles();
    expect(existsSync(runDirForTests("run-unsettled"))).toBe(true);
    expect(isLeaseBusy("folder-fail")).toBe(true);
    expect(hasInFlightRuns()).toBe(true);
    expect(await handleOrdinaryAccountRequest({ tool_id: "lark_cli", account_key: key, action: "logout" })).toMatchObject({ ok: false, error: "account_in_use_by_run" });
    expect(await handleOrdinaryToolAction({ action: "remove", tool_id: "lark_cli", source: "managed" }, () => {})).toMatchObject({ ok: false, error: expect.stringMatching(/in use/) });

    // Its runtime cannot be replaced or removed underneath those processes; another can.
    let replaced = false;
    await expect(withRuntimeKeyDrained("acp_fake", 60_000, async () => { replaced = true; })).rejects.toThrow(/could not be confirmed stopped/);
    expect(replaced).toBe(false);
    let otherReplaced = false;
    await withRuntimeKeyDrained("some_other_runtime", 1_000, async () => { otherReplaced = true; });
    expect(otherReplaced).toBe(true);

    // A later attempt of the same Run, elsewhere, finishes normally — and does
    // not revoke the grant or remove the directory the kept attempt still has.
    const later: Array<Record<string, unknown>> = [];
    await handleLaunch({ run_id: "run-unsettled", launch_id: "launch-unsettled-b", workspace_location_id: "folder-fail-b", runtime_key: "acp_other", argv: ["true"] },
      (frame) => later.push(frame as Record<string, unknown>), () => {});
    await expect.poll(() => later.some((frame) => frame.type === "complete"), { timeout: 15_000 }).toBe(true);
    expect(later.find((frame) => frame.type === "complete")).toMatchObject({ exit_code: 0 });
    expect(existsSync(runDirForTests("run-unsettled"))).toBe(true);
    await refusedThroughGrant();
    // Still a live grant: the proxy recorded the refusal against this Run.
    expect(proxy.log("run-unsettled").length).toBeGreaterThan(0);
    setEgressProxy(null);
    await proxy.close?.();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }, 60_000);

  it("refuses a runtime replacement that was already waiting when the attempt became kept", async () => {
    await installManagedLark();
    const workspace = join(root, "workspace-race");
    await mkdir(workspace);
    await saveConfig({ server_url: "http://127.0.0.1:9", host_id: "host-1", trust: "trusted", token: "t", workspaces: { "folder-race": workspace } });
    let openGate: () => void = () => {};
    settleControl.gate = new Promise<void>((resolveGate) => { openGate = resolveGate; });
    settleControl.failNext = true;
    const frames: Array<Record<string, unknown>> = [];
    await handleLaunch({ run_id: "run-race", launch_id: "launch-race", workspace_location_id: "folder-race", runtime_key: "acp_race",
      argv: ["sh", "-c", "echo started; sleep 0.3"], ordinary_tools: { accounts: [] } },
    (frame) => frames.push(frame as Record<string, unknown>), () => {});
    await expect.poll(() => frames.some((frame) => frame.type === "output")).toBe(true);
    // The drain starts while the attempt is still an active Run of this runtime…
    let replaced = false;
    const drain = withRuntimeKeyDrained("acp_race", 30_000, async () => { replaced = true; });
    const outcome = drain.then(() => "replaced", (error: Error) => error.message);
    // …and the attempt becomes kept (and stops counting as active) while it waits.
    await new Promise((resolveWait) => setTimeout(resolveWait, 600));
    openGate();
    await expect.poll(() => frames.some((frame) => frame.type === "complete"), { timeout: 15_000 }).toBe(true);
    expect(frames.find((frame) => frame.type === "complete")).toMatchObject({ exit_code: 1 });
    expect(await outcome).toMatch(/could not be confirmed stopped/);
    expect(replaced).toBe(false);
  }, 30_000);
});
