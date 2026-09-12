import { REMOTE_CWD_PLACEHOLDER, WORK_SKILL_PATH_PLACEHOLDER, type HostDaemonFrame, type HostLaunchFrame, type HostLaunchIsolation, type HostLaunchProviderBinding, type HostLaunchWorkSurface, type HostServerFrameOf } from "@rainver/protocol";
import { spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { configDir, requireConfig, workspacesRoot } from "./config.js";
import { buildStrictNamespaceCommand, type StrictBind } from "./strictNamespace.js";
import { uploadRunDiff, uploadRunOutputs } from "./api.js";
import { captureWorkspaceDiff } from "./gitDiff.js";
import { collectOutputFiles } from "./outputFiles.js";
import { clearStateRootEnv, clearVendorCredentialEnv, filterAmbientEnv, materializeProviderBinding, sweepOrphanedRunDirectories } from "./providerBinding.js";
import { OWN_INSTALLATION, readToolManifestSync } from "./tools.js";
import { ensureManagedWorkspace, runtimeProfileContainerPath, type ManagedWorkspaceContainer } from "./managedWorkspaces.js";
import { isPackagedAdapter, resolvePackagedAdapter } from "./adapterInstallation.js";
import { egressProxyEnv, proxyBypassHosts, type EgressProfile, type EgressProxyHandle } from "./egressProxy.js";
import { ensureCodexStrictSandboxConfig } from "./codexStrictSandbox.js";

export interface LaunchWorkspace {
  kind: "location" | "managed";
  workspace_location_id?: string;
  /** Set only for a built-in-host Location; see the wire contract for why that is the one case. */
  workspace_relative_path?: string;
  agent_id?: string;
  container?: ManagedWorkspaceContainer;
}

/**
 * A Location's directory on this machine.
 *
 * A registered path from this daemon's own config first: that is how a paired
 * host resolves every Location, and it is the only place such a path is ever
 * written down. Failing that, a path the control plane named relative to the
 * instance workspace root — which exists only on the built-in host, whose
 * Locations the control plane created there and which never runs
 * `workspace add`. Refused if it escapes that root; the daemon does not take a
 * path from a frame, it takes a name and resolves it.
 */
export function resolveLocationCwd(
  workspaces: Record<string, string>,
  locationId: string | undefined,
  relativePath: string | undefined,
  root: string | null,
): string | null {
  const registered = locationId ? workspaces[locationId] : undefined;
  if (registered) return registered;
  if (!relativePath || !root) return null;
  const target = resolve(root, relativePath);
  if (target !== resolve(root) && !target.startsWith(resolve(root) + sep)) return null;
  return target;
}

/**
 * The wire's `launch` frame (`HostLaunchFrameSchema` in `@rainver/protocol`)
 * as this daemon executes it. Every field is the contract's own — nothing is
 * declared here that the server does not send — and the only difference is
 * the managed-workspace container, renamed to this daemon's `{ kind, id }`
 * form by `commands/run.ts`. See the contract for what each field means.
 */
export type LaunchFrame = Omit<HostLaunchFrame, "type" | "workspace"> & { workspace?: LaunchWorkspace };
export type WorkSurfaceFrame = HostLaunchWorkSurface;
export type ProviderBindingFrame = HostLaunchProviderBinding;
export type StdinFrame = Pick<HostServerFrameOf<"stdin">, "run_id" | "value">;
export type StdinCloseFrame = Pick<HostServerFrameOf<"stdin_close">, "run_id">;
export type TerminateFrame = Pick<HostServerFrameOf<"terminate">, "run_id"> & { force?: boolean };

interface ActiveRun {
  child: ChildProcess;
  cwd: string;
  /** The control plane's nonce for this dispatch, echoed on every frame this run sends. */
  launchId: string;
  /** What the control plane wrote where a value only this machine knows belongs. */
  placeholders: Record<string, string>;
  /** Which runtime this run is executing, so an upgrade of that copy can drain it. */
  adapterType: string | null;
  timedOut: boolean;
  /** Whether something asked this run to stop, as opposed to it stopping on its own. */
  terminationRequested: boolean;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * What a `complete` frame says went wrong, when anything did.
 *
 * A strict run reports on fd 3 the moment its namespace is built, so a run
 * that never reported is a namespace that never came up — and saying so is
 * the only way to tell that apart from a runtime that exited immediately,
 * which produces the same exit code. But a run killed before that chunk was
 * read never reported either, and blaming its namespace would be a plain
 * misattribution: a cancel and a timeout are both something that happened
 * *to* a working run.
 */
export function launchFailureMessage(input: {
  namespaceReady: boolean;
  timedOut: boolean;
  terminationRequested: boolean;
  exitCode: number;
  stderrTail: string;
}): string | null {
  if (!input.namespaceReady && !input.timedOut && !input.terminationRequested) {
    return `This run's isolation namespace failed to start.${input.stderrTail ? ` ${input.stderrTail}` : ""}`;
  }
  return input.exitCode !== 0 && !input.timedOut ? (input.stderrTail || null) : null;
}

/**
 * ACP runtime replatform P2 (A2): the daemon must not become a vendor
 * protocol translator, so it never parses the ACP JSON-RPC frames it relays
 * — but a remote ACP session still needs to tell the agent its real working
 * directory, and only the daemon (not the server, per ADR 0016 B64) knows
 * that path. This is the one deliberate exception: a plain, protocol-agnostic
 * text substitution on the outgoing byte stream, not JSON parsing or ACP
 * method awareness. The server embeds this exact literal wherever it would
 * otherwise need to write a real filesystem path
 * (`server/src/modules/runs/remoteHostCliAdapter.ts`'s
 * `REMOTE_HOST_ACP_CWD_PLACEHOLDER`); every run's registered workspace path
 * substitutes cleanly since every remote dispatch is workspace-bound
 * (phase 2 C9).
 *
 * Accepted risk (P2 discovery review, documented not fixed): this is a
 * blind substring replace over the outgoing byte stream, not a substitution
 * scoped to a specific JSON field. A registered workspace path containing a
 * character JSON must escape (`"`, `\`) would corrupt every ACP frame for
 * that workspace — the paths a user registers on their own paired machine
 * are operator-controlled, not attacker input, so this is judged low-risk
 * for now. If it is ever hit in practice, the fix is to serialize the
 * substituted value with `JSON.stringify` and splice it in as a JSON string
 * literal rather than a raw text swap.
 */
export { REMOTE_CWD_PLACEHOLDER };

export function substituteCwd(value: string, cwd: string): string {
  return substitutePlaceholders(value, { [REMOTE_CWD_PLACEHOLDER]: cwd });
}

/** Every placeholder the control plane may have written, in argv, stdin, or a prompt. */
export function substitutePlaceholders(value: string, placeholders: Record<string, string>): string {
  let result = value;
  for (const [placeholder, replacement] of Object.entries(placeholders)) {
    result = result.split(placeholder).join(replacement);
  }
  return result;
}

/**
 * ACP runtime replatform P3/P4: the bundled ACP adapter commands are not
 * binaries a trusted host has on PATH — they are pinned dependencies of THIS
 * package (an ACP adapter is our client, not the vendor runtime). The daemon
 * resolves its own installed copy and spawns it through `node` rather than
 * relying on PATH lookup.
 */
/** Exported for direct testing; not part of this package's public API surface. */
export function resolveAcpEntrypoint(command: string): string | null {
  return resolvePackagedAdapter(command);
}

/** What actually gets spawned for an ACP argv: the vendor CLI as-is, or a bundled adapter through `node`. */
export interface AcpLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * One place for the bundled-vs-vendor distinction, used both to run a job and
 * to ask a runtime for its options. Throws when the argv names a bundled
 * adapter this daemon does not have; a vendor CLI is spawned as named and
 * resolves via the child's own PATH, same as the capability probe's lookup.
 */
export function resolveAcpLaunch(
  rawCommand: string,
  args: string[],
  installation: string = OWN_INSTALLATION,
  /** Required for a managed copy: the tools directory is keyed by adapter, and the command name (`claude-agent-acp`) is not it. */
  adapterType: string = rawCommand,
): AcpLaunch {
  if (installation !== OWN_INSTALLATION) {
    // A managed copy: launched from its manifest with its own HOME, never
    // looked up on PATH (`tools.ts`).
    const tool = readToolManifestSync(adapterType, installation);
    if (!tool) throw new Error(`This daemon does not have ${adapterType} ${installation} installed.`);
    return { command: tool.command, args: [...tool.args, ...args], env: { ...tool.env, HOME: tool.home } };
  }
  if (!isPackagedAdapter(rawCommand)) return { command: rawCommand, args, env: {} };
  const entrypoint = resolveAcpEntrypoint(rawCommand);
  if (!entrypoint) throw new Error(`This daemon does not have the ${rawCommand} adapter installed.`);
  const env: Record<string, string> = {};
  if (rawCommand === "codex-acp") {
    // NO_BROWSER: this daemon has no browser to open for ChatGPT login.
    // CODEX_PATH: drive the trusted host's own installed `codex` (found by
    // this same daemon's capability probe) rather than codex-acp's bundled
    // copy — hosts.md's rule is that a trusted host runs whatever it already
    // has, and running two divergent codex installs on one machine invites
    // confusing drift.
    env.CODEX_PATH = "codex";
    env.NO_BROWSER = "1";
  } else if (rawCommand === "claude-agent-acp") {
    // Bundle the ACP bridge, not a second vendor runtime. Capability probing
    // already finds the trusted host's own Claude installation on PATH.
    env.CLAUDE_CODE_EXECUTABLE = "claude";
  }
  return { command: process.execPath, args: [entrypoint, ...args], env };
}

/**
 * Keyed by run_id, not by connection: a run outlives a WebSocket reconnect
 * (control-center-plan.md §5 — "an interrupted connection while a run is
 * active keeps the process alive"). Same reasoning as
 * `sharedHostConnectionRegistry` on the server side — one instance for the
 * daemon process's lifetime.
 */
const activeRuns = new Map<string, ActiveRun>();
/** Runs whose launch frame has arrived but whose child is not registered yet. */
const launchingRuns = new Set<string>();
/**
 * Runs whose child has exited but whose directory is still being read.
 *
 * The diff and output uploads happen after the child is gone and take as long
 * as the network does. A reconnect in that window would otherwise let
 * `sweepStaleRunProfiles` — which now removes the whole run directory — delete
 * the outputs out from under `collectOutputFiles`, losing the deliverables
 * silently and turning every `artifact.submit` declaration into "declared but
 * not delivered".
 */
const finishingRuns = new Set<string>();
let registrationRevoked = false;

/** A release updater may restart the daemon only after all Run work is settled. */
export function hasInFlightRuns(): boolean {
  return activeRuns.size > 0 || launchingRuns.size > 0 || finishingRuns.size > 0;
}

/**
 * Adapters whose copy is being replaced right now.
 *
 * Draining is only half of it: a drain that reports "quiet" and then spends a
 * minute downloading is a window in which a new dispatch starts against the
 * copy about to be deleted. So the replacement holds this for its whole
 * duration and every launch of that adapter is refused while it does — a
 * refusal the control plane can retry, rather than a binary pulled out from
 * under a running session.
 */
const replacingAdapters = new Set<string>();

/** Whether a launch of this adapter must be refused because its copy is being replaced. */
export function adapterIsBeingReplaced(adapterType: string | null | undefined): boolean {
  return typeof adapterType === "string" && replacingAdapters.has(adapterType);
}

/**
 * Work that runs a copy without being a Run: a verification recipe, a C3
 * probe, a usage probe, an open login terminal.
 *
 * They are in neither run registry, so a drain that only counted Runs reported
 * "quiet" and then deleted the directory one of them was executing from. The
 * closed door alone is not enough either — it only orders *replacement before
 * work*, and this is the other order. Counted per adapter because that is what
 * a replacement holds.
 */
const adapterHolders = new Map<string, number>();

/**
 * Marks one copy as in use until the returned function is called, so a
 * replacement waits for it. Used directly by work with no single call to wrap
 * — an open login terminal, which ends on its own child's exit.
 */
export function holdAdapter(adapterType: string): () => void {
  adapterHolders.set(adapterType, (adapterHolders.get(adapterType) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (adapterHolders.get(adapterType) ?? 1) - 1;
    if (remaining > 0) adapterHolders.set(adapterType, remaining);
    else adapterHolders.delete(adapterType);
  };
}

/**
 * Marks one copy as in use for the duration of `work`, so a replacement waits
 * for it. Returns `work`'s result; the count is released even if it throws.
 */
export async function holdingAdapter<T>(adapterType: string | null | undefined, work: () => Promise<T>): Promise<T> {
  if (typeof adapterType !== "string") return work();
  const release = holdAdapter(adapterType);
  try {
    return await work();
  } finally {
    release();
  }
}

/**
 * Holds one adapter closed, drains its Runs, and runs `replace` with nothing
 * able to start against it.
 *
 * Nothing is killed: a drain that does not converge abandons the replacement,
 * which loses an upgrade rather than someone's work. `launchingRuns` counts as
 * busy across all adapters — a dispatch whose child is not registered yet is a
 * Run about to use some copy, and which one is not known until it is.
 * Work that is not a Run — verification recipes, usage probes,
 * an open login terminal — registers through `holdingAdapter`, so it is drained
 * for as well as refused afterwards.
 */
export async function withAdapterDrained<T>(
  adapterType: string,
  timeoutMs: number,
  replace: () => Promise<T>,
): Promise<T> {
  if (replacingAdapters.has(adapterType)) {
    throw new Error(`Another change to ${adapterType} is already in progress on this host`);
  }
  replacingAdapters.add(adapterType);
  try {
    const deadline = Date.now() + timeoutMs;
    const busy = () => launchingRuns.size > 0
      || (adapterHolders.get(adapterType) ?? 0) > 0
      || [...activeRuns.values()].some((run) => run.adapterType === adapterType);
    while (busy()) {
      if (Date.now() >= deadline) {
        throw new Error(`Runs are still using ${adapterType}; try again once they finish`);
      }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 500);
        timer.unref?.();
      });
    }
    return await replace();
  } finally {
    replacingAdapters.delete(adapterType);
  }
}

/** A revoked host must stop every trusted-host process, including its process group, immediately. */
export function stopAllRunsForRevocation(log: (line: string) => void = () => {}): void {
  registrationRevoked = true;
  for (const [runId, active] of activeRuns) {
    log(`run ${runId}: terminating because this host was revoked`);
    // Like every other deliberate stop: without it, a strict run killed here
    // before its namespace reported would be blamed on the namespace. Not
    // reachable today — a strict daemon re-adopts its credential instead of
    // being revoked — which is exactly why it should be right before it is.
    active.terminationRequested = true;
    terminateWithEscalation(active.child, true, log);
  }
}

/**
 * Removes run directories left behind by a daemon that was killed mid-run.
 * Each holds that run's outputs and work surface, and an older layout also put
 * a live lease token there; nothing else would ever remove one, because the
 * same run id never comes back.
 */
export async function sweepStaleRunProfiles(): Promise<number> {
  // `launchingRuns` as well as `activeRuns`: a reconnect can land between a
  // launch frame arriving and its child being registered, and deleting that
  // run's profile mid-launch is the exact silent-unbinding this phase exists
  // to prevent.
  return sweepOrphanedRunDirectories(
    join(configDir(), "runs"),
    new Set([...activeRuns.keys(), ...launchingRuns, ...finishingRuns]),
  );
}

function runOutputsDir(runId: string): string {
  return join(runDir(runId), "outputs");
}

/**
 * This run's own directory. Already swept for orphans by
 * `sweepOrphanedRunDirectories`, so anything materialized here is removed with
 * the run — including a work surface carrying its tool token.
 */
function runDir(runId: string): string {
  // The Runner this replaces resolved every mount id below a managed root and
  // refused one that escaped it. The daemon addresses paths directly, so the
  // equivalent guard is here: a run id is one path segment, and `join` would
  // otherwise turn `../..` into a real parent directory that `resolve()` then
  // considers perfectly normal — and in strict mode that directory becomes a
  // read-write bind carrying this daemon's own registration.
  if (!RUN_ID_SEGMENT.test(runId)) throw new Error(`run id is not a usable directory name: ${runId}`);
  return join(configDir(), "runs", runId);
}

/** Same shape `sandbox/runner.mjs` validated its run and scope ids against. */
const RUN_ID_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;

/** Exported for the containment test; not part of this package's public API. */
export const runDirForTests = runDir;

/**
 * Writes the run's work surface and returns the environment it contributes.
 *
 * `RAINVER_CLI` is resolved here, not sent by the control plane: it is a path
 * on this machine, and the command ships with this daemon so the two versions
 * cannot disagree. It is passed by absolute path rather than installed onto
 * `PATH` — the daemon puts nothing into the machine's global tool space
 * (ADR 0016 §7).
 */
async function materializeWorkSurface(
  surface: WorkSurfaceFrame,
  runId: string,
): Promise<Record<string, string>> {
  const root = runDir(runId);
  for (const file of surface.files) {
    const target = resolveInsideDir(root, file.relative_path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, file.contents, { encoding: "utf8", mode: 0o600 });
  }
  const env: Record<string, string> = { ...surface.env };
  for (const [key, relativePath] of Object.entries(surface.dir_env)) {
    env[key] = relativePath === "." ? root : resolveInsideDir(root, relativePath);
  }
  env.RAINVER_CLI = await writeCliLauncher(root);
  return env;
}

/**
 * A launcher for the `rainver` command, written into this run's directory.
 *
 * The command itself is a `.js` file inside this package, and `tsc` emits it
 * without an executable bit — so pointing `RAINVER_CLI` straight at it makes
 * `$RAINVER_CLI list` fail with `EACCES` on any host running the daemon from a
 * checkout, and fail on Windows regardless. A generated launcher settles both:
 * it runs under the same Node that runs this daemon, needs nothing on `PATH`
 * (ADR 0016 §7), and is removed with the run.
 */
async function writeCliLauncher(root: string): Promise<string> {
  const cli = rainverCliPath();
  const windows = process.platform === "win32";
  // Inside `rainver/`, beside the Skill: the run directory also holds
  // `outputs/`, and a launcher named for the directory it sits next to would
  // collide with it.
  const target = join(root, "rainver", windows ? "rainver.cmd" : "rainver");
  const contents = windows
    ? `@echo off\r\n"${process.execPath}" "${cli}" %*\r\n`
    : `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(cli)} "$@"\n`;
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, contents, { encoding: "utf8", mode: 0o700 });
  return target;
}

/** Single-quoted for `sh`, so a path containing spaces survives. */
function shellQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}

/** Refuses a control-plane path that would write outside the run directory. */
function resolveInsideDir(root: string, relativePath: string): string {
  const target = resolve(root, relativePath);
  const prefix = resolve(root) + sep;
  if (target !== resolve(root) && !target.startsWith(prefix)) {
    throw new Error(`work surface path escapes the run directory: ${relativePath}`);
  }
  return target;
}

/**
 * The `rainver` command, from the package that owns it.
 *
 * `@rainver/agent-cli` is a workspace package with no runtime dependencies,
 * consumed by whoever has to put the command in front of a runtime — this
 * daemon for a paired machine, the server for a sandboxed run. One copy, so
 * the two paths cannot hand an agent different commands.
 *
 * The built entry is preferred; the source is the fallback for running this
 * daemon from a checkout under a TypeScript loader, where nothing is built.
 */
function rainverCliPath(): string {
  // `createRequire`, not `import.meta.resolve`: the ESM resolver maps the
  // export without checking the file is there, so a checkout with nothing
  // built would get a `dist/` path that does not exist — and Vitest's module
  // runner does not implement it at all. `require.resolve` honours the same
  // `exports` map and fails when the target is missing, which is what makes
  // the fallback correct. Same choice, same reason, as the ACP entrypoint
  // resolution above.
  const require = createRequire(import.meta.url);
  try {
    return require.resolve("@rainver/agent-cli");
  } catch {
    return require.resolve("@rainver/agent-cli/source");
  }
}

/**
 * Where a run's runtime keeps its profile: its login, the conversation state
 * it will resume next turn, and whatever the vendor CLI remembers on its own.
 *
 * The key is
 * `agents/<agent_id>/<container_kind>/<container_id>/<adapter>/<provider|ambient>`,
 * and the directory follows it with a `profiles/` level inserted so it sits
 * beside — not inside — the Agent's managed workspaces. It is not under
 * `runs/`: a profile deleted when its run exits takes with it the session the
 * next turn is about to resume.
 *
 * Every segment is validated before a path is built from it. The daemon runs
 * unsandboxed on a machine the user owns, so the control plane is not trusted
 * to have sent a key that stays inside the config directory.
 */
export function providerProfileDir(profileKey: string): string {
  const segments = profileKey.split("/");
  const [agents, agentId, containerKind, containerId, adapterType, providerId] = segments;
  if (segments.length !== 6 || agents !== "agents") {
    throw new Error(`runtime profile key has an unusable shape: ${profileKey}`);
  }
  if (containerKind !== "direct" && containerKind !== "conversation" && containerKind !== "location") {
    throw new Error(`runtime profile key has an unusable container kind: ${profileKey}`);
  }
  for (const segment of [agentId, containerId, adapterType, providerId]) {
    if (!segment || !/^[A-Za-z0-9._-]+$/.test(segment) || segment.startsWith(".")) {
      throw new Error(`runtime profile key has an unusable segment: ${profileKey}`);
    }
  }
  // Derived from the container path rather than rebuilt: archive, restore and
  // reset all move the container level, and a second construction of the same
  // five segments that drifted would leave launches working while every
  // archive silently moved nothing.
  return join(
    runtimeProfileContainerPath(agentId!, containerKind, containerId!),
    adapterType!,
    providerId!,
  );
}

/**
 * The HOME whose login state this installation uses.
 *
 * One login per host × installation, which is the whole point of linking the
 * credential rather than logging in per profile: an Agent × container profile
 * per Room would otherwise multiply logins by Agents × Rooms. `own` is the
 * machine's own home directory — the CLI the user already logged into — and a
 * managed adapter has a stable private HOME so its login never mixes with the
 * machine's.
 */
function loginHomeFor(adapterType: string, installation: string): string | null {
  if (installation === OWN_INSTALLATION) return homedir();
  return readToolManifestSync(adapterType, installation)?.home ?? null;
}

/**
 * What a strict namespace applies when the dispatch stated no policy.
 *
 * Fail-closed on both axes: a read-only workspace and no network at all. The
 * Runner this replaces refused a launch whose egress profile did not match the
 * channels it actually carried, so a request that named no channel could not
 * obtain a network; the daemon has no typed channels to cross-check against,
 * so the equivalent is to give an unpolicied Run nothing. A Run that needs
 * either says so, and a control plane that forgets to says nothing — which
 * must fail visibly rather than quietly hand a shared host the container's
 * network.
 */
const DEFAULT_STRICT_ISOLATION = { sandbox_mode: "read_only", egress_profile: "none" } as const;

/**
 * The host's egress proxy, once per daemon.
 *
 * Held here rather than passed down every call: it is a listening socket the
 * whole daemon shares, and a Run's launch needs only the environment that
 * points at it. Absent on a paired host — a trusted machine's Runs use the
 * machine's own network, which is the trust its owner already extends (ADR
 * 0016 §2).
 */
let egressProxy: EgressProxyHandle | null = null;
/** This daemon's own control plane, which no Run should ever reach through the proxy. */
let controlPlaneUrl: string | null = null;

export function setEgressProxy(handle: EgressProxyHandle | null, serverUrl: string | null = null): void {
  egressProxy = handle;
  controlPlaneUrl = serverUrl;
}

/** What a Run reached, and what it was refused; empty when this host runs no proxy. */
export function runEgressLog(runId: string) {
  return egressProxy?.log(runId) ?? [];
}

/**
 * Registers this Run's egress policy and returns the environment that points
 * it at the proxy.
 *
 * `none` gets nothing: its namespace is unshared, so there is no proxy to
 * reach and no policy to register. A host with no proxy — every paired
 * machine — also gets nothing, and the Run uses the machine's own network.
 */
function grantRunEgress(
  runId: string,
  profile: EgressProfile,
  /**
   * Everything the control plane is handing this Run that could name one of
   * its own addresses: the environment, and the config files a provider
   * binding writes — which is where two of the three CLI adapters receive
   * their lease URL.
   */
  sources: readonly string[],
): Record<string, string> {
  if (!egressProxy || profile === "none") return {};
  const grant = egressProxy.grant(runId, profile);
  const bypass = proxyBypassHosts([...sources, ...(controlPlaneUrl ? [controlPlaneUrl] : [])]);
  return egressProxyEnv(egressProxy.address, grant.token, bypass);
}

/**
 * The directory tree this daemon and everything it launches live in.
 *
 * A strict namespace starts from an empty root, so the ACP adapter this daemon
 * spawns through `node` — and the `rainver` command it points a Run at — have
 * to be bound in explicitly. Resolving the *install* root rather than this
 * package's own directory is what makes it work under pnpm: the adapter and
 * `@rainver/agent-cli` are siblings under the same `node_modules`, not files
 * inside this package.
 */
export function daemonRuntimeRoot(moduleUrl: string = import.meta.url): string {
  const dir = dirname(fileURLToPath(moduleUrl));
  const segments = dir.split(sep);
  // `.../<install root>/node_modules/@rainver/host-daemon/dist` → the install
  // root. The *first* `node_modules`, because a nested one is inside it.
  const index = segments.indexOf("node_modules");
  if (index > 0) return segments.slice(0, index).join(sep) || sep;
  // Otherwise this daemon runs from a directory layout — the container puts it
  // at `/app/packages/host-daemon/dist` with dependency trees at both
  // `/app/packages/host-daemon/node_modules` and `/app/node_modules`. The
  // highest ancestor that has one is the root that contains them all; stopping
  // at the package's own parent would leave the ACP adapter and the `rainver`
  // command outside the namespace.
  let root = resolve(dir, "..");
  for (let candidate = root; candidate !== dirname(candidate); candidate = dirname(candidate)) {
    if (existsSync(join(candidate, "node_modules"))) root = candidate;
  }
  return root;
}

/**
 * Everything besides the workspace and HOME that a strict Run must be able to
 * see. Anything absent from this list is absent from the namespace.
 */
export function strictBindsForRun(input: {
  runDir: string;
  profileDir: string | null;
  loginHome: string | null;
  toolTree: string | null;
  runtimeRoot: string;
}): StrictBind[] {
  const binds: StrictBind[] = [
    // Its outputs, its work surface, and the `rainver` launcher written there.
    { path: input.runDir, access: "read_write" },
    // The adapter this daemon spawns and the CLI it hands the Run.
    { path: input.runtimeRoot, access: "read_only" },
  ];
  // The Agent's own sessions and vendor memory (B68) — read-write, because
  // that is where this runtime keeps the conversation the next turn resumes.
  if (input.profileDir) binds.push({ path: input.profileDir, access: "read_write" });
  // The profile links the credential file out of the login home, and a symlink
  // whose target is outside the namespace resolves to nothing inside it.
  //
  // Read-only, and it stays read-only even though a runtime may want to
  // refresh its own token through that link: on a shared host this is the
  // instance's single subscription login, and a Run that could rewrite it
  // could point every other member's Runs at an account of its own choosing.
  // A refresh that fails surfaces as the runtime's login prompt, which an
  // instance admin answers through the host card — outside any namespace.
  if (input.loginHome) binds.push({ path: input.loginHome, access: "read_only" });
  // A managed copy's `home/` sits inside its tree, so the tree covers it.
  if (input.toolTree) binds.push({ path: input.toolTree, access: "read_only" });
  return binds;
}

/**
 * Everything a strict launch decides, as one value.
 *
 * Extracted rather than written inline in `launchRun` because this is where a
 * shared host's isolation is actually determined — which environment the agent
 * process receives, which HOME it writes into, and what is bound — and none of
 * that is reachable by a test that has to spawn `bwrap` to observe it.
 */
export interface StrictLaunch {
  command: string;
  args: string[];
  home: string;
  env: Record<string, string>;
}

export function planStrictLaunch(input: {
  runId: string;
  runDir: string;
  command: string;
  args: string[];
  cwd: string;
  /** What the daemon itself built for this Run: its output dir, binding, work surface. */
  derivedEnv: Record<string, string>;
  /** This container's own environment; never passed through as-is. */
  ambient: NodeJS.ProcessEnv;
  isolation: HostLaunchIsolation | undefined;
  /** Where this Run's egress is pointed, when its profile has any. */
  egress: Record<string, string>;
  profileDir: string | null;
  loginHome: string | null;
  toolTree: string | null;
  runtimeRoot: string;
}): StrictLaunch {
  // **The container contributes nothing.** A trusted host keeps the machine's
  // environment because it is the owner's machine; a strict host is not
  // anyone's machine, and its environment is the instance's. Compose no longer
  // hands this container the control plane's internal token — `.runner.env`
  // and `SANDBOX_RUNNER_TOKEN` went with the Runner — so this filter is not
  // what stops that token reaching a Run. It stops the next variable to land
  // in the container's environment from doing so: this namespace shares the
  // instance's network, every Space's Runs pass through it, and none of them
  // has any claim on what the instance configured itself with. The Runner this
  // replaces `--setenv`-ed a hand-written allowlist and nothing else; this is
  // the same rule, reusing the allowlist the bound-run path already applies
  // for B67.
  const home = join(input.runDir, "home");
  const env: Record<string, string> = {
    ...filterAmbientEnv(input.ambient),
    // Before `derivedEnv`, so a provider binding's own proxy variables — which
    // point at the provider proxy for one upstream — win over the general
    // egress proxy rather than being overwritten by it.
    ...input.egress,
    ...input.derivedEnv,
    // Last, and per Run. A managed copy's launch env points HOME at that
    // copy's shared login home, and an unbound run would otherwise inherit
    // the container's — one directory that every Run of every Space writes
    // its vendor history and scratch files into, read-write. The runtime
    // reaches its own state through the profile's state-root variables, which
    // is what B68 keys by Agent × container in the first place.
    HOME: home,
  };
  const { command, args } = buildStrictNamespaceCommand({
    command: input.command,
    args: input.args,
    cwd: input.cwd,
    home,
    binds: strictBindsForRun({
      runDir: input.runDir,
      profileDir: input.profileDir,
      loginHome: input.loginHome,
      toolTree: input.toolTree,
      runtimeRoot: input.runtimeRoot,
    }),
    isolation: input.isolation ?? DEFAULT_STRICT_ISOLATION,
    env,
  });
  return { command, args, home, env };
}

/**
 * Spawns the rendered command, streams stdout back as `output` frames, and
 * on exit uploads the workspace diff and output-directory contents before
 * sending `complete`. `send` is the frame sink for whichever connection is
 * live when a frame needs to go out — if the socket has since closed,
 * run.ts's wrapper drops the frame rather than throwing; the process is
 * still tracked and its artifacts still uploaded over plain HTTP.
 */
export async function handleLaunch(
  frame: LaunchFrame,
  send: (frame: HostDaemonFrame) => void,
  log: (line: string) => void,
): Promise<void> {
  if (registrationRevoked) {
    send({ type: "complete", run_id: frame.run_id, launch_id: frame.launch_id, exit_code: 1, timed_out: false, error: "This host registration was revoked." });
    return;
  }
  // Refused rather than raced: this copy is being replaced, and starting
  // against a directory that is about to be renamed away is the failure the
  // drain exists to prevent (ADR 0016 §9).
  if (adapterIsBeingReplaced(frame.adapter_type)) {
    send({
      type: "complete",
      run_id: frame.run_id,
      launch_id: frame.launch_id,
      exit_code: 1,
      timed_out: false,
      error: `${frame.adapter_type} is being upgraded on this host; retry in a moment.`,
    });
    return;
  }
  launchingRuns.add(frame.run_id);
  try {
    await launchRun(frame, send, log);
  } finally {
    launchingRuns.delete(frame.run_id);
  }
}

async function launchRun(
  frame: LaunchFrame,
  send: (frame: HostDaemonFrame) => void,
  log: (line: string) => void,
): Promise<void> {
  const config = await requireConfig();
  let cwd: string | undefined;
  try {
    if (frame.workspace?.kind === "managed") {
      if (!frame.workspace.agent_id || !frame.workspace.container) {
        throw new Error("managed launch workspace is incomplete");
      }
      cwd = await ensureManagedWorkspace(frame.workspace.agent_id, frame.workspace.container);
    } else {
      cwd = resolveLocationCwd(
        config.workspaces,
        frame.workspace?.workspace_location_id ?? frame.workspace_location_id,
        frame.workspace?.workspace_relative_path,
        workspacesRoot(),
      ) ?? undefined;
    }
  } catch (error) {
    send({
      type: "complete",
      run_id: frame.run_id,
      launch_id: frame.launch_id,
      exit_code: 1,
      timed_out: false,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  if (!cwd) {
    send({
      type: "complete",
      run_id: frame.run_id,
      launch_id: frame.launch_id,
      exit_code: 1,
      timed_out: false,
      error: "This daemon has no local path registered for that workspace.",
    });
    return;
  }
  let attachedWorkspaceEnv: Record<string, string> = {};
  if (frame.workspace_access && frame.workspace_access.length > 0) {
    const attached = [] as Array<{ workspace_location_id: string; access_mode: "read" | "write"; path: string }>;
    for (const attachment of frame.workspace_access) {
      const path = config.workspaces[attachment.workspace_location_id];
      if (!path) {
        send({
          type: "complete",
          run_id: frame.run_id,
          launch_id: frame.launch_id,
          exit_code: 1,
          timed_out: false,
          error: `This daemon has no local path registered for attached workspace ${attachment.workspace_location_id}.`,
        });
        return;
      }
      attached.push({ ...attachment, path });
    }
    // The daemon is the only component that can resolve physical paths. Keep
    // the control-plane authorization explicit for the child without ever
    // accepting an arbitrary path from the launch frame.
    attachedWorkspaceEnv.RAINVER_WORKSPACE_ACCESS = JSON.stringify(attached);
  }
  const [rawCommand, ...args] = frame.argv.map((arg) => substituteCwd(arg, cwd));
  if (!rawCommand) {
    send({ type: "complete", run_id: frame.run_id, launch_id: frame.launch_id, exit_code: 1, timed_out: false, error: "Empty command." });
    return;
  }

  let launch: AcpLaunch;
  try {
    launch = resolveAcpLaunch(rawCommand, args, frame.installation ?? OWN_INSTALLATION, frame.adapter_type ?? rawCommand);
  } catch (error) {
    send({
      type: "complete",
      run_id: frame.run_id,
      launch_id: frame.launch_id,
      exit_code: 1,
      timed_out: false,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  const { command, args: spawnArgs } = launch;
  const acpAdapterEnv = { ...launch.env };

  const outputsDir = runOutputsDir(frame.run_id);
  await mkdir(outputsDir, { recursive: true });

  // Two different rules, told apart by `credential_source`.
  //
  // B67, for a run bound to a ModelProvider: the executing machine contributes
  // nothing to which backend, credential or upstream the runtime reaches, so
  // the ambient environment is filtered to an allowlist rather than merged
  // over, and the runtime is pointed at a control-plane-provided profile.
  //
  // For a run on this machine's own login, B67's closing rule stands — it is
  // "not affected" — so the machine's environment is kept and only the
  // runtime's *state root* moves into the Agent's profile. Filtering here
  // instead would take `~/.gitconfig`, `~/.ssh/config` and the proxy variables
  // away from every Task run on a paired machine, which no part of this was
  // meant to do.
  //
  // The default is the credential-cleared environment, not `process.env` whole.
  // Every branch below narrows, so the bare spread was reachable only when a
  // frame carries no `provider_binding` — which the wire contract allows and
  // today's single producer never sends. Reachable or not, the default for
  // "we do not yet know what this run is" must not be the one that hands the
  // runtime an ambient `ANTHROPIC_API_KEY`. This keeps `~/.gitconfig`,
  // `~/.ssh/config` and the proxy variables: it drops vendor prefixes only.
  // `?? ""` means "drop every vendor prefix", which is the right answer for a
  // frame that does not say what it is running — and the wrong one to arrive at
  // by accident, since it also takes `GOOGLE_APPLICATION_CREDENTIALS` from a
  // Task run that needs gcloud. Today's single producer always sends a real
  // adapter type; the wire contract allows it to be absent, and this is what
  // that case gets.
  let baseEnv: Record<string, string> = clearVendorCredentialEnv(process.env, frame.adapter_type ?? "");
  let bindingEnv: Record<string, string> = {};
  let workSurfaceEnv: Record<string, string> = {};
  // Kept out of the binding block so the strict namespace below can bind them:
  // a profile that is not in the namespace is a runtime with no login.
  let profileDir: string | null = null;
  let loginHome: string | null = null;
  if (frame.work_surface) {
    try {
      workSurfaceEnv = await materializeWorkSurface(frame.work_surface, frame.run_id);
    } catch (error) {
      // Without its work surface the agent cannot report anything back, and a
      // run whose result never reaches Rainver is worse than one that did not
      // start: it looks finished and advanced nothing.
      send({
        type: "complete",
        run_id: frame.run_id,
        launch_id: frame.launch_id,
        exit_code: 1,
        timed_out: false,
        error: `Could not prepare this run's Rainver work surface: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
  }
  if (frame.provider_binding) {
    try {
      const adapterType = frame.adapter_type ?? rawCommand;
      const binding = frame.provider_binding;
      // A frame that writes nothing, points at nothing and links nothing is
      // the credential half alone — a runtime whose state root cannot move
      // (a registry agent, logged in inside its managed tree). It gets no
      // profile directory and keeps its `HOME`; only the ambient vendor keys
      // go.
      const relocatesState = Object.keys(binding.profile_env).length > 0
        || binding.files.length > 0 || binding.login_link !== null;
      if (relocatesState) {
        profileDir = providerProfileDir(binding.profile_key);
        loginHome = loginHomeFor(adapterType, frame.installation ?? OWN_INSTALLATION);
      }
      bindingEnv = relocatesState
        ? await materializeProviderBinding(binding, profileDir!, loginHome, log)
        : {};
      if (binding.credential_source === "provider_lease") {
        baseEnv = filterAmbientEnv(process.env);
      } else if (relocatesState) {
        baseEnv = clearStateRootEnv(process.env, adapterType);
        // A managed copy is launched with `HOME` pointing inside its own tree
        // so its login never mixes with the machine's. That reason is gone
        // once the credential is linked into the profile and the state root is
        // the profile's own variable — and leaving it would take
        // `~/.gitconfig` and `~/.ssh/config` away from exactly the runs this
        // branch exists to keep them for.
        delete acpAdapterEnv.HOME;
      } else {
        baseEnv = clearVendorCredentialEnv(process.env, adapterType);
      }
    } catch (error) {
      send({
        type: "complete",
        run_id: frame.run_id,
        launch_id: frame.launch_id,
        exit_code: 1,
        timed_out: false,
        error: `Could not prepare the selected model backend: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
  }

  if (registrationRevoked) {
    await rm(runDir(frame.run_id), { recursive: true, force: true });
    send({ type: "complete", run_id: frame.run_id, launch_id: frame.launch_id, exit_code: 1, timed_out: false, error: "This host registration was revoked." });
    return;
  }

  // The work surface is applied after the binding for the same reason the
  // binding is applied after the ambient environment: it is control-plane
  // authority, and this machine does not get to override which Rainver a run
  // reports to.
  const derivedEnv: Record<string, string> = { RAINVER_OUTPUT_DIR: outputsDir, ...attachedWorkspaceEnv, ...acpAdapterEnv, ...bindingEnv, ...workSurfaceEnv };

  let spawnCommand = command;
  let spawnCommandArgs = spawnArgs;
  let spawnEnv: Record<string, string> = { ...baseEnv, ...derivedEnv };
  const strict = config.trust === "strict";
  if (strict && frame.adapter_type === "codex_cli") {
    // This Run's own profile — the Agent × container one (`profileDir`), never
    // the login home. `profileDir` is set in the same branch that resolves
    // `loginHome`, so the old third fallback could not be reached — and had it
    // been, this would have rewritten the config the managed login shares
    // across every Agent and every Room on this installation.
    const codexHome = derivedEnv.CODEX_HOME
      ?? (profileDir ? join(profileDir, ".codex") : null);
    if (codexHome) {
      try {
        await ensureCodexStrictSandboxConfig(codexHome);
      } catch (error) {
        send({
          type: "complete",
          run_id: frame.run_id,
          launch_id: frame.launch_id,
          exit_code: 1,
          timed_out: false,
          error: `Could not relax Codex's vendor sandbox inside this host's namespace: ${error instanceof Error ? error.message : String(error)}`,
        });
        return;
      }
    }
  }
  // fd 3 carries the namespace's readiness handshake; a trusted host has no
  // fourth stream and keeps the three it always had.
  let stdio: Array<"pipe"> = ["pipe", "pipe", "pipe"];
  let namespaceReady = !strict;
  if (strict) {
    try {
      const tool = frame.installation && frame.installation !== OWN_INSTALLATION
        ? readToolManifestSync(frame.adapter_type ?? rawCommand, frame.installation)
        : null;
      const plan = planStrictLaunch({
        runId: frame.run_id,
        runDir: runDir(frame.run_id),
        command,
        args: spawnArgs,
        cwd,
        derivedEnv,
        ambient: process.env,
        isolation: frame.isolation,
        egress: grantRunEgress(frame.run_id, frame.isolation?.egress_profile ?? "none", [
          ...Object.values(derivedEnv),
          ...(frame.provider_binding?.files ?? []).map((file) => file.contents),
        ]),
        profileDir,
        loginHome,
        toolTree: tool ? dirname(tool.home) : null,
        runtimeRoot: daemonRuntimeRoot(),
      });
      await mkdir(plan.home, { recursive: true, mode: 0o700 });
      spawnCommand = plan.command;
      spawnCommandArgs = plan.args;
      // Every variable the run needs is already a `--setenv` inside the
      // namespace; what is left is only what `bwrap` itself needs to run.
      spawnEnv = { PATH: "/usr/local/bin:/usr/bin:/bin" };
      stdio = ["pipe", "pipe", "pipe", "pipe"];
    } catch (error) {
      // The grant was registered while building the plan; a Run that never
      // starts still has to give it back, or the daemon accumulates one entry
      // per failed launch for its whole lifetime.
      egressProxy?.revoke(frame.run_id);
      send({
        type: "complete",
        run_id: frame.run_id,
        launch_id: frame.launch_id,
        exit_code: 1,
        timed_out: false,
        error: `Could not build this run's isolation namespace: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
  }

  const child: ChildProcess = spawn(spawnCommand, spawnCommandArgs, {
    cwd,
    env: spawnEnv,
    stdio,
    detached: true,
  });
  if (strict) {
    // "The namespace could not be built" and "the runtime exited immediately"
    // are the same exit code; this handshake is what tells them apart, and it
    // is the reason the run is started through `sh -c` at all.
    (child.stdio[3] as NodeJS.ReadableStream | null)?.once("data", (value: Buffer) => {
      namespaceReady = value.toString("utf8").startsWith("ready");
      // The Runner killed a child that answered anything else, and so does
      // this: whatever is on the other side of that fd is not the launch
      // handshake, and letting it run to completion would report a namespace
      // failure about a process that ran.
      if (!namespaceReady) terminateWithEscalation(child, true, log);
    });
  }
  const active: ActiveRun = {
    child,
    cwd,
    launchId: frame.launch_id,
    placeholders: {
      [REMOTE_CWD_PLACEHOLDER]: cwd,
      ...(workSurfaceEnv.RAINVER_SKILL_PATH ? { [WORK_SKILL_PATH_PLACEHOLDER]: workSurfaceEnv.RAINVER_SKILL_PATH } : {}),
    },
    adapterType: frame.adapter_type ?? null,
    timedOut: false,
    terminationRequested: false,
    timeoutTimer: null,
  };
  // A retry of the same run id may arrive while the previous attempt's child
  // is still being torn down; the newest dispatch owns the id from here.
  activeRuns.set(frame.run_id, active);
  // ACP runtime replatform P2: the server must not write a `stdin` frame
  // (e.g. a controller's `initialize` request) until it knows this run is
  // actually registered here — `launch` and any immediately-following
  // `stdin` frame are two separate WS messages, and this handler reaches
  // this point only after two `await`s, so a same-tick follow-up `stdin`
  // frame's handler could otherwise run first and find no active run.
  send({ type: "launched", run_id: frame.run_id, launch_id: frame.launch_id });

  if (frame.stdin) child.stdin?.write(substitutePlaceholders(frame.stdin, active.placeholders));
  if (!frame.keep_stdin_open) child.stdin?.end();

  child.stdout?.on("data", (chunk: Buffer) => {
    send({ type: "output", run_id: frame.run_id, launch_id: frame.launch_id, chunk: chunk.toString("utf8") });
  });
  let stderrTail = "";
  child.on("error", (error) => {
    stderrTail = error.message.slice(-4000);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stderrTail = (stderrTail + text).slice(-4000);
    // control-center-phase2-plan.md P1 (C5): the full live stream, not just
    // the failure tail the `complete` frame still carries below — normalized
    // into diagnostic conversation events server-side.
    send({ type: "stderr", run_id: frame.run_id, launch_id: frame.launch_id, chunk: text });
  });

  if (frame.timeout_seconds && frame.timeout_seconds > 0) {
    active.timeoutTimer = setTimeout(() => {
      active.timedOut = true;
      active.terminationRequested = true;
      terminateWithEscalation(child, false, log);
    }, frame.timeout_seconds * 1000);
    active.timeoutTimer.unref?.();
  }

  child.on("close", (code) => {
    void (async () => {
      if (active.timeoutTimer) clearTimeout(active.timeoutTimer);
      // Only this attempt's own entry: a retry that took the run id over
      // while this child was dying must keep its registration.
      if (activeRuns.get(frame.run_id) === active) activeRuns.delete(frame.run_id);
      // Held until the directory is gone, so a reconnect mid-upload cannot
      // sweep the outputs this block is still reading.
      finishingRuns.add(frame.run_id);

      try {
        const diff = await captureWorkspaceDiff(cwd);
        if (diff !== null) {
          await uploadRunDiff(config.server_url, config.token, frame.run_id, { diff, truncated: false });
        }
      } catch (error) {
        log(`run ${frame.run_id}: diff upload failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        const files = await collectOutputFiles(outputsDir);
        await uploadRunOutputs(config.server_url, config.token, frame.run_id, files);
      } catch (error) {
        log(`run ${frame.run_id}: output upload failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      // The whole directory: its work surface carried this run's Skill. The
      // run id does come back — a supervisor retry reuses it within seconds —
      // and when a newer attempt already owns it, its work surface is in this
      // same directory, so this attempt leaves the cleanup to that one. A
      // failure here must not swallow the `complete` frame or pin the run id
      // in `finishingRuns` for this daemon's lifetime.
      const superseded = activeRuns.has(frame.run_id) || launchingRuns.has(frame.run_id);
      if (superseded) {
        log(`run ${frame.run_id}: a newer attempt owns the run directory; leaving it in place`);
      } else {
        await rm(runDir(frame.run_id), { recursive: true, force: true }).catch((error: unknown) => {
          log(`run ${frame.run_id}: run directory cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
      finishingRuns.delete(frame.run_id);
      // Read before revoking, and revoked here rather than on the child's exit:
      // a connection opened just before the process ended is still this Run's.
      // Not revoked at all when a newer attempt owns the id — the same
      // condition the run directory uses above. This close handler runs after
      // seconds of diff capture and upload, by which time a supervisor retry
      // may already hold the grant, and revoking then would 407 every request
      // the live attempt makes.
      const egress = runEgressLog(frame.run_id);
      // A superseded attempt keeps the grant (the live one holds it now) but
      // still gives up its entries, or the retry would report them again.
      if (superseded) egressProxy?.clearLog(frame.run_id);
      else egressProxy?.revoke(frame.run_id);

      send({
        type: "complete",
        run_id: frame.run_id,
        launch_id: frame.launch_id,
        exit_code: code ?? 1,
        timed_out: active.timedOut,
        ...(egress.length > 0 ? { egress } : {}),
        error: launchFailureMessage({
          namespaceReady,
          timedOut: active.timedOut,
          terminationRequested: active.terminationRequested,
          exitCode: code ?? 1,
          stderrTail,
        }),
      });
    })();
  });
}

export function handleTerminate(frame: TerminateFrame, log: (line: string) => void = () => {}): void {
  const active = activeRuns.get(frame.run_id);
  if (!active) return;
  active.terminationRequested = true;
  terminateWithEscalation(active.child, frame.force === true, log);
}

/** Writes a `stdin` frame's value to the run's child process, translating the cwd placeholder first. */
export function handleStdin(frame: StdinFrame): void {
  const active = activeRuns.get(frame.run_id);
  if (!active) return;
  active.child.stdin?.write(substitutePlaceholders(frame.value, active.placeholders));
}

/** Ends the run's child process stdin, mirroring the default (non-`keep_stdin_open`) behavior in `handleLaunch`. */
export function handleStdinClose(frame: StdinCloseFrame): void {
  const active = activeRuns.get(frame.run_id);
  active?.child.stdin?.end();
}

const KILL_ESCALATION_GRACE_MS = 5000;

/**
 * A CLI that ignores SIGTERM (or a process group SIGTERM that failed to
 * reach a wayward child) would otherwise run forever with nothing watching
 * it — this is the daemon's only backstop, since the server's own timeout
 * needs the WS connection up to deliver a forced-terminate frame at all.
 * Force-terminate skips straight to SIGKILL; a graceful one escalates only
 * if the process is still alive after the grace window.
 */
function terminateWithEscalation(child: ChildProcess, force: boolean, log: (line: string) => void): void {
  const sent = killProcessGroup(child, force ? "SIGKILL" : "SIGTERM");
  if (!sent) log(`could not signal process group for pid ${child.pid ?? "unknown"}`);
  if (force) return;
  const timer = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    log(`process for pid ${child.pid ?? "unknown"} ignored SIGTERM after ${KILL_ESCALATION_GRACE_MS}ms — escalating to SIGKILL`);
    if (!killProcessGroup(child, "SIGKILL")) log(`could not deliver escalated SIGKILL for pid ${child.pid ?? "unknown"}`);
  }, KILL_ESCALATION_GRACE_MS);
  timer.unref?.();
}

function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): boolean {
  if (typeof child.pid !== "number") return false;
  try {
    // Negative pid targets the whole process group `detached: true` created,
    // so a shell-spawned tool's children die too, not just the shell.
    process.kill(-child.pid, signal);
    return true;
  } catch {
    try {
      child.kill(signal);
      return true;
    } catch {
      return false;
    }
  }
}
