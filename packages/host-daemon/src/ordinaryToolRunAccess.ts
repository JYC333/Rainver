import {
  ORDINARY_TOOL_CATALOG,
  ORDINARY_TOOL_IDS,
  ORDINARY_TOOLS_RUN_PROTOCOL,
  type HostLaunchOrdinaryTools,
  type OrdinaryToolId,
} from "@rainver/protocol";
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { lstat, mkdir, mkdtemp } from "node:fs/promises";
import { dirname, join } from "node:path";
import { acquireRunAccountUse, ordinaryToolAccountsCapability } from "./ordinaryToolAccounts.js";
import { leaseOrdinaryToolCommand, resolveOrdinaryToolCopy } from "./ordinaryTools.js";
import type { StrictBind } from "./strictNamespace.js";

/**
 * What a Run gets of the Host's ordinary CLI tools (`ordinaryTools.ts`) and of
 * its instructing person's own account (`ordinaryToolAccounts.ts`).
 *
 * - Tools. In a strict namespace the system roots are already bound
 *   read-only, so a copy found there is visible as is. A Rainver-managed copy
 *   is added by binding its version directory read-only and putting it first
 *   on PATH. A registered copy elsewhere (an npm wrapper, a home directory) is
 *   not bound: its dependency closure is unknown, so it is reported as not in
 *   the sandbox rather than half-provided. A trusted Host has no namespace;
 *   its Run uses the copy where it is.
 * - Account. Only a key named in the launch, which the control plane derived
 *   from the Run's instructing person, and only where per-user isolation holds
 *   (Linux). The Run receives that person's `LARKSUITE_CLI_CONFIG_DIR` and
 *   `LARKSUITE_CLI_DATA_DIR`, bound read-write in a strict namespace so the
 *   CLI's own refresh persists in place (it serializes refresh with a lock file
 *   there). Nobody else's directory, the account's HOME, the daemon's
 *   configuration and the Host user's HOME are not bound. The Run keeps its own
 *   HOME and runtime profile.
 * - Lifetime. The lark-cli lease and the account use are held until `release`,
 *   which the daemon calls when the Run's process has exited (or when a launch
 *   never spawned). While held, the binary cannot be installed over or removed,
 *   and the account's setup, login and logout are refused.
 *
 * - No personal account (none, busy, unsupported, tool unavailable): the Run
 *   still gets explicit `LARKSUITE_CLI_CONFIG_DIR`/`DATA_DIR`, pointing at
 *   empty directories created fresh for this launch attempt under the Run
 *   directory. lark-cli then finds
 *   nothing and says it is not configured, instead of falling back to the Host
 *   user's default `~/.lark-cli` login. The Runtime HOME and profile are not
 *   touched; the directories go with the Run directory.
 *
 * `RAINVER_ORDINARY_TOOLS` tells the Run what it actually has; it carries no
 * path or credential.
 */

export function ordinaryToolsRunCapability(): { protocol: typeof ORDINARY_TOOLS_RUN_PROTOCOL } {
  return { protocol: ORDINARY_TOOLS_RUN_PROTOCOL };
}

/** What `strictNamespace.ts` binds read-only from the Host as system roots. */
export const STRICT_SYSTEM_ROOTS = ["/usr/", "/bin/", "/sbin/", "/lib/", "/lib64/"];

/**
 * Whether an executable at `command` resolves entirely inside the given roots
 * — what a strict namespace can actually run without binding anything else.
 *
 * Every path component is resolved, directories as well as the file: a
 * `/usr/local/bin` that links to `/opt/bridge` (and from there back to
 * `/usr/bin`) is not visible inside the namespace, because `/opt/bridge` is
 * not bound there. Each intermediate path, after each link, must itself be
 * inside a root. Too many links, a dangling link or a non-file fails closed.
 */
export function resolvesWithin(command: string, roots: readonly string[]): boolean {
  const inside = (path: string) => roots.some((root) => path === root.replace(/\/+$/, "") || path.startsWith(root));
  // The directories leading to a root exist in the namespace as well (bwrap
  // creates them to bind the root); a link among them is still followed and
  // its target checked like any other component.
  const towardRoot = (path: string) => roots.some((root) => root.startsWith(path === "/" ? "/" : `${path}/`));
  if (!command.startsWith("/")) return false;
  let pending = command.split("/").filter(Boolean);
  let current = "/";
  let links = 0;
  while (pending.length > 0) {
    const part = pending.shift()!;
    if (part === ".") continue;
    const next = part === ".." ? dirname(current) : (current === "/" ? `/${part}` : `${current}/${part}`);
    if (!inside(next) && !towardRoot(next)) return false;
    let isLink: boolean;
    try {
      isLink = lstatSync(next).isSymbolicLink();
    } catch {
      return false;
    }
    if (!isLink) {
      current = next;
      continue;
    }
    if (++links > 40) return false;
    let target: string;
    try {
      target = readlinkSync(next);
    } catch {
      return false;
    }
    // An absolute target restarts from `/`; a relative one from the link's directory.
    if (target.startsWith("/")) current = "/";
    pending = [...target.split("/").filter(Boolean), ...pending];
  }
  try {
    return inside(realpathSync(current)) && lstatSync(current).isFile();
  } catch {
    return false;
  }
}
/** Ambient variables that select a lark-cli identity, credential or workspace; never inherited by a Run. */
export const AMBIENT_TOOL_SELECTORS = /^(LARKSUITE_CLI_|OPENCLAW_|HERMES_)|^LARK_CHANNEL$/;

type ToolState = "available" | "missing" | "not_in_sandbox";
type AccountState = "personal" | "none" | "busy" | "unsupported" | "tool_unavailable";

export interface RunOrdinaryTools {
  /** Variables this Run receives; applied after every ambient source. */
  env: Record<string, string>;
  /** Directories to put first on PATH. */
  pathPrefix: string[];
  /** Strict namespace only. */
  binds: StrictBind[];
  release: () => void;
}

export interface PrepareRunOrdinaryToolsOptions {
  /**
   * The daemon's own directory for this Run (`runs/<id>`). A launch attempt
   * without a personal account gets a fresh, empty state directory created
   * inside it; it must be a real directory, not a link.
   */
  scratchParent: string;
  platform?: NodeJS.Platform;
  /** Tests substitute a temporary system root; production uses the namespace's. */
  systemRoots?: readonly string[];
}

export async function prepareRunOrdinaryTools(
  request: HostLaunchOrdinaryTools | undefined,
  strict: boolean,
  options: PrepareRunOrdinaryToolsOptions,
): Promise<RunOrdinaryTools | null> {
  const platform = options.platform ?? process.platform;
  const systemRoots = options.systemRoots ?? STRICT_SYSTEM_ROOTS;
  if (!request) return null;
  const releases: Array<() => void> = [];
  const release = () => { for (const fn of releases.splice(0)) fn(); };
  try {
    const tools: Partial<Record<OrdinaryToolId, ToolState>> = {};
    const pathPrefix: string[] = [];
    const binds: StrictBind[] = [];
    let larkCommand: string | null = null;
    for (const id of ORDINARY_TOOL_IDS) {
      let copy: { source: "managed" | "registered" | "path"; command: string } | null;
      if (id === "lark_cli") {
        // Held for the Run's lifetime: the binary must not change under it.
        const lease = await leaseOrdinaryToolCommand(id).catch(() => null);
        if (lease) releases.push(lease.release);
        copy = lease ? await resolveOrdinaryToolCopy(id) : null;
        if (copy && copy.command !== lease!.command) copy = { ...copy, command: lease!.command };
      } else {
        copy = await resolveOrdinaryToolCopy(id);
      }
      if (!copy) { tools[id] = "missing"; continue; }
      // The managed tree is bound itself; anything else must resolve within
      // the system roots the namespace already has.
      const inSystemRoot = resolvesWithin(copy.command, systemRoots);
      if (strict && !inSystemRoot && copy.source !== "managed") { tools[id] = "not_in_sandbox"; continue; }
      if (copy.source !== "path" || !inSystemRoot) {
        const dir = dirname(copy.command);
        if (strict) binds.push({ path: dir, access: "read_only" });
        if (!pathPrefix.includes(dir)) pathPrefix.push(dir);
      }
      tools[id] = "available";
      if (id === "lark_cli") larkCommand = copy.command;
    }

    const env: Record<string, string> = {};
    let account: AccountState = "none";
    const requested = request.accounts.find((entry) => entry.tool_id === "lark_cli");
    if (requested) {
      if (!ordinaryToolAccountsCapability(platform).supported) account = "unsupported";
      else if (!larkCommand) account = "tool_unavailable";
      else {
        const use = await acquireRunAccountUse(requested.tool_id, requested.account_key);
        if (!use.ok) account = "busy";
        else {
          releases.push(use.release);
          account = "personal";
          env.LARKSUITE_CLI_CONFIG_DIR = use.config;
          env.LARKSUITE_CLI_DATA_DIR = use.data;
          env.LARKSUITE_CLI_NO_SKILLS_NOTIFIER = "1";
          if (strict) binds.push({ path: use.config, access: "read_write" }, { path: use.data, access: "read_write" });
        }
      }
    }
    if (account !== "personal") {
      // Never the Host user's default lark-cli state, nor anyone else's, nor
      // what an earlier attempt of the same Run left. `mkdtemp` makes a new
      // directory for this attempt, so nothing in it — no file, no link — can
      // predate it.
      await mkdir(options.scratchParent, { recursive: true, mode: 0o700 });
      const parent = await lstat(options.scratchParent);
      if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("The Run directory is not a plain directory.");
      const attempt = await mkdtemp(join(options.scratchParent, "ordinary-tools-"));
      const config = join(attempt, "config");
      const data = join(attempt, "data");
      for (const dir of [config, data]) await mkdir(dir, { mode: 0o700 });
      env.LARKSUITE_CLI_CONFIG_DIR = config;
      env.LARKSUITE_CLI_DATA_DIR = data;
      env.LARKSUITE_CLI_NO_SKILLS_NOTIFIER = "1";
      if (strict) binds.push({ path: config, access: "read_write" }, { path: data, access: "read_write" });
    }
    env.RAINVER_ORDINARY_TOOLS = JSON.stringify({
      tools: Object.fromEntries(ORDINARY_TOOL_IDS.map((id) => [ORDINARY_TOOL_CATALOG[id].executable, tools[id] ?? "missing"])),
      accounts: { "lark-cli": account },
    });
    return { env, pathPrefix, binds, release };
  } catch (error) {
    release();
    throw error;
  }
}

/**
 * The final environment of a Run that received an `ordinary_tools` field:
 * inherited tool selectors removed, this Run's own values applied last, and
 * its tool directories first on PATH.
 */
export function applyRunOrdinaryToolsEnv(env: Record<string, string>, tools: RunOrdinaryTools): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (!AMBIENT_TOOL_SELECTORS.test(key)) result[key] = value;
  Object.assign(result, tools.env);
  if (tools.pathPrefix.length > 0) result.PATH = [...tools.pathPrefix, ...(result.PATH ? [result.PATH] : [])].join(":");
  return result;
}
