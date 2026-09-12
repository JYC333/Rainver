import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import type { HostLaunchIsolation } from "@rainver/protocol";

/**
 * The strict-mode namespace: one rootless bubblewrap mount/PID namespace per
 * Run, ported from `sandbox/runner.mjs`'s `buildNamespaceCommand`.
 *
 * ADR 0016 says the server host and a paired personal host are the same thing,
 * and this is where that becomes true: the isolation that used to be a
 * property of a separate Runner service colocated with the server is now a
 * trust mode of the one daemon. A `strict` host wraps every Run; a `trusted`
 * host spawns natively and never reaches this file.
 *
 * **One deliberate deviation from the Runner it replaces.** The Runner mapped
 * every authority root onto a canonical target (`/workspace`, `/home/sandbox`,
 * `/runtime-tool`) because the server addressed mounts by managed id and never
 * knew a real path. The daemon is the opposite: it is the only component that
 * resolves paths at all (B64), and every value it has already materialized for
 * the Run — `RAINVER_CLI`, `RAINVER_OUTPUT_DIR`, a runtime profile's state-root
 * variables, a managed copy's manifest command — is an absolute path on this
 * machine. So each path is bound **at its own path** rather than remapped. The
 * containment property is unchanged (an empty root plus an explicit allowlist);
 * what is dropped is a path translation that would have to be undone again in
 * every environment variable the daemon writes.
 */
export interface StrictBind {
  path: string;
  access: "read_only" | "read_write";
}

export interface StrictNamespaceRequest {
  command: string;
  args: string[];
  /** The Run's working directory on this machine; bound per `sandbox_mode`. */
  cwd: string;
  /** HOME inside the namespace — the Agent's runtime profile or the run's own home. */
  home: string;
  /** Everything else this Run must see: its run directory, a managed copy's tree, the daemon's own package. */
  binds: StrictBind[];
  isolation: HostLaunchIsolation;
  env: Record<string, string>;
}

export const BWRAP_PATH = "/usr/bin/bwrap";

/**
 * Base system paths. Bound read-only when present rather than unconditionally:
 * `/lib64` does not exist on arm64, and an absent bind target aborts bwrap
 * before the Run ever starts.
 */
const SYSTEM_ROOTS = ["/usr", "/bin", "/sbin", "/lib", "/lib64"];

/**
 * The minimum an ordinary process needs to resolve users, time zones, DNS and
 * TLS roots. Copied from the Runner's list unchanged — it is the outcome of
 * real runs failing without each entry, not a guess.
 */
const ETC = [
  "/etc/alternatives",
  "/etc/ca-certificates.conf",
  "/etc/gai.conf",
  "/etc/group",
  "/etc/host.conf",
  "/etc/hostname",
  "/etc/hosts",
  "/etc/ld.so.cache",
  "/etc/ld.so.conf",
  "/etc/ld.so.conf.d",
  "/etc/localtime",
  "/etc/nsswitch.conf",
  "/etc/passwd",
  "/etc/resolv.conf",
  "/etc/ssl/certs",
  "/etc/ssl/openssl.cnf",
  "/etc/timezone",
];

/**
 * Environment a strict namespace always exports, whatever the runtime.
 *
 * `RAINVER_STRICT_SANDBOX` marks the namespace for anything downstream that
 * needs to know it is inside one. Codex does not read it; the daemon consumes
 * the same fact (`trust === "strict"`) by writing
 * `sandbox_mode = "workspace-write"` into that copy's `config.toml` before
 * spawn (`codexStrictSandbox.ts`), which is the switch measured to stop
 * Codex's default read-only sandbox stacking on top of this namespace.
 */
export const STRICT_SANDBOX_ENV: Readonly<Record<string, string>> = Object.freeze({
  RAINVER_STRICT_SANDBOX: "1",
});

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** A bind whose path is not absolute, or which escapes into `..`, is a bug on this side of the wire, not a Run failure to report later. */
function assertAbsolute(label: string, path: string): string {
  const resolved = resolve(path);
  if (path !== resolved) throw new Error(`strict namespace ${label} must be an absolute, normalized path: ${path}`);
  return resolved;
}

/**
 * Deduplicates binds by path, keeping the widest access.
 *
 * bwrap applies binds in order and a later one silently shadows an earlier
 * one, so a run directory bound read-write after the config directory was
 * bound read-only would look correct and be read-only. Resolving it here keeps
 * the argv a statement of intent.
 */
function mergeBinds(binds: StrictBind[]): StrictBind[] {
  const byPath = new Map<string, StrictBind["access"]>();
  for (const bind of binds) {
    const path = assertAbsolute("bind", bind.path);
    const existing = byPath.get(path);
    byPath.set(path, existing === "read_write" || bind.access === "read_write" ? "read_write" : "read_only");
  }
  // Parents before children: a child bound inside a parent must be applied
  // after it, or the parent's bind replaces the child's mountpoint.
  return [...byPath.entries()]
    .sort(([a], [b]) => (a.length === b.length ? a.localeCompare(b) : a.length - b.length))
    .map(([path, access]) => ({ path, access }));
}

/**
 * Builds the full `bwrap` argv for one Run.
 *
 * The child is started through `sh -c` so the namespace can report readiness
 * on fd 3 before `exec`ing the runtime — the same handshake the Runner used,
 * and the only way to tell "the namespace could not be built" apart from "the
 * runtime exited immediately", which are the same exit code otherwise.
 */
export function buildStrictNamespaceCommand(request: StrictNamespaceRequest): { command: string; args: string[] } {
  const cwd = assertAbsolute("cwd", request.cwd);
  const home = assertAbsolute("home", request.home);
  const args = [
    "--die-with-parent",
    "--new-session",
    "--unshare-pid",
    "--tmpfs",
    "/",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
  ];
  for (const root of SYSTEM_ROOTS) if (exists(root)) args.push("--ro-bind", root, root);
  for (const path of ETC) if (exists(path)) args.push("--ro-bind", path, path);
  // `none` receives a network namespace of its own, and is the only profile
  // that *confines* a Run's network. `default` and `install` keep the
  // container's stack and are pointed at the daemon's egress proxy with
  // `HTTP_PROXY` — policy and a record for a cooperating runtime, not a
  // boundary against one that opens its own socket (`egressProxy.ts`).
  if (request.isolation.egress_profile === "none") args.push("--unshare-net");

  const workspaceAccess = request.isolation.sandbox_mode === "read_only" ? "read_only" : "read_write";
  for (const bind of mergeBinds([{ path: cwd, access: workspaceAccess }, { path: home, access: "read_write" }, ...request.binds])) {
    // No `--dir` first: bwrap creates a missing destination for a bind, and an
    // explicit `--dir` on a path whose parent is also bound would replace that
    // parent's content with an empty directory.
    args.push(bind.access === "read_only" ? "--ro-bind" : "--bind", bind.path, bind.path);
  }

  args.push("--setenv", "HOME", home);
  for (const [key, value] of Object.entries({ ...request.env, ...STRICT_SANDBOX_ENV })) {
    args.push("--setenv", key, value);
  }
  args.push(
    "--chdir",
    cwd,
    "--",
    "/bin/sh",
    "-c",
    'printf \'ready\\n\' >&3; exec "$@"',
    "strict-launch",
    request.command,
    ...request.args,
  );
  return { command: BWRAP_PATH, args };
}
