import { link as link_, lstat, mkdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import type { ProviderBindingFrame } from "./execution.js";

/** Replaced with the absolute profile directory when files are written. */
export const PROFILE_ROOT_PLACEHOLDER = "{{RAINVER_RUN_PROFILE}}";

/**
 * Environment a run **bound to a ModelProvider** inherits from this machine.
 *
 * A run on the machine's own login goes through `clearStateRootEnv` instead:
 * B67's closing rule leaves it the machine's environment, and only its state
 * root moves.
 *
 * An allowlist, not a denylist, because B67 states the rule that way round:
 * backend selection comes only from what the control plane injects, so the
 * question is what a runtime legitimately needs from the machine — not which
 * of the machine's variables we remembered to name. The deleted server-host
 * path reached the same conclusion; a denylist here would have let
 * `CLAUDE_CODE_OAUTH_TOKEN`, `XDG_DATA_HOME` and `NODE_OPTIONS` through, each
 * of which redirects a run somewhere the control plane did not choose.
 *
 * On a **trusted** host, a run on the machine's own login does **not** come
 * through here; it keeps the machine's environment minus the state-root
 * variables above, which is what B67's closing rule says and what leaves a
 * paired machine's git and ssh configuration reachable. On a **strict** host
 * that exemption does not apply: `planStrictLaunch` filters every run's
 * environment through this same allowlist, bound or not, because the container
 * is nobody's machine.
 */
const ALLOWED_AMBIENT_KEYS = new Set([
  "PATH",
  "TERM",
  "SHELL",
  "LANG",
  "TZ",
  "TMPDIR",
  "TEMP",
  "TMP",
  "USER",
  "USERNAME",
  "LOGNAME",
  // Selects no backend, and without it an agent that pushes inside the
  // workspace fails on a bound run for reasons unrelated to the binding.
  "SSH_AUTH_SOCK",
  // Windows needs these to resolve anything at all.
  "SYSTEMROOT",
  "COMSPEC",
  "PATHEXT",
  "WINDIR",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
]);

/**
 * What a run on this machine's **own** login drops from the machine's
 * environment. Everything else it keeps — B67's closing rule, and what leaves
 * `~/.gitconfig`, `~/.ssh/config`, the proxy variables and the language
 * toolchains reaching a Task run on a paired machine.
 *
 * Two closed sets, for two different reasons, and neither is the B67 question
 * (B67 is about a *bound* run, where a denylist is explicitly not a sufficient
 * reading — this run has no binding to protect):
 *
 * - **State roots.** A variable that would move a runtime's sessions and
 *   auto-memory back out of the profile it was just given. The profile
 *   supplies `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and the XDG roots itself, so
 *   these are covered by the vendor prefixes below plus `XDG_*`.
 * - **Credentials the machine has lying around.** The whole point of this run
 *   is that it spends the owner's *subscription*, linked into the profile. An
 *   ambient `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` would be
 *   preferred by the runtime over that login and bill an API account instead —
 *   B67's second named failure, "a subscription login converted into API
 *   billing by a leftover key", and the thing the ACP replatform was told to
 *   verify before shipping. None of these is anything git, ssh or a toolchain
 *   needs, so dropping them costs nothing this rule is protecting.
 */
const ALL_VENDOR_CREDENTIAL_PREFIXES = [
  "ANTHROPIC_",
  "CLAUDE_",
  "CODEX_",
  "OPENAI_",
  "OPENCODE_",
  "GEMINI_",
  "GOOGLE_",
];

/**
 * Per **launched runtime**, not one list for all: only the variables the
 * runtime being started reads as a credential or a state root can hijack its
 * login or move its state, and dropping the rest takes real things away from
 * a Task run on a paired machine — `GOOGLE_APPLICATION_CREDENTIALS` and
 * `GOOGLE_CLOUD_PROJECT` are how gcloud and a GCS toolchain authenticate, and
 * Claude Code reads neither. OpenCode routes to whichever provider it finds a
 * key for, so for it every vendor prefix is a credential; Gemini CLI reads the
 * `GOOGLE_` family to choose between API-key and Vertex billing, so for it the
 * whole prefix is a backend choice. A runtime this daemon does not know keeps
 * the full list: over-dropping costs a tool, under-dropping bills an account.
 */
const HOST_LOGIN_DROPPED_PREFIXES_BY_RUNTIME: Record<string, readonly string[]> = {
  claude_code: ["ANTHROPIC_", "CLAUDE_"],
  codex_cli: ["OPENAI_", "CODEX_"],
  gemini_cli: ["GEMINI_", "GOOGLE_"],
  opencode: ALL_VENDOR_CREDENTIAL_PREFIXES,
};

/**
 * The XDG **roots** by name, not the whole `XDG_` prefix. `XDG_RUNTIME_DIR` is
 * how a git credential helper reaches the keyring and how rootless podman
 * finds its socket, and dropping it would break a Task run that pushes or
 * builds — the same class of regression as moving `HOME`.
 */
const HOST_LOGIN_DROPPED_KEYS = new Set([
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
]);

export function clearStateRootEnv(ambient: NodeJS.ProcessEnv, adapterType: string): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(clearVendorCredentialEnv(ambient, adapterType))) {
    if (HOST_LOGIN_DROPPED_KEYS.has(key.toUpperCase())) continue;
    kept[key] = value;
  }
  return kept;
}

/**
 * The credential half alone: the machine's environment minus the vendor keys
 * the launched runtime would prefer over its own login. For a runtime whose
 * state root cannot move — a registry agent, logged in inside its managed
 * tree — this is all an unbound run drops; its `HOME` and the XDG roots stay
 * exactly as they were at login, because that is where its login state is.
 */
export function clearVendorCredentialEnv(ambient: NodeJS.ProcessEnv, adapterType: string): Record<string, string> {
  const prefixes = HOST_LOGIN_DROPPED_PREFIXES_BY_RUNTIME[adapterType] ?? ALL_VENDOR_CREDENTIAL_PREFIXES;
  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(ambient)) {
    if (value === undefined) continue;
    if (prefixes.some((prefix) => key.toUpperCase().startsWith(prefix))) continue;
    kept[key] = value;
  }
  return kept;
}

/**
 * The environment for a daemon-side helper process — an adapter installer, a
 * version or capability probe, an ACP `session/list`.
 *
 * The machine's environment minus the vendor credentials, which is the same
 * rule a host-login Run takes: these run on the owner's machine and need its
 * PATH, its git and ssh configuration and its toolchain, but none of them has
 * any business picking up an `ANTHROPIC_API_KEY` that happens to be exported —
 * a probe that did would bill an account nobody asked it to, and an ACP
 * `session/list` that did would read sessions under a different identity than
 * the one the daemon is logged in as.
 *
 * Each of these used to spread `process.env` whole, or delete two named keys
 * beside it. One builder rather than a hand-written subset per call site.
 *
 * @param adapterType the runtime this helper serves, or `""` for one that
 * serves none (an installer), which drops every vendor prefix.
 */
export function helperProcessEnv(
  ambient: NodeJS.ProcessEnv,
  adapterType = "",
  options: { keepStateRoots?: boolean } = {},
): Record<string, string> {
  const cleared = clearVendorCredentialEnv(ambient, adapterType);
  if (!options.keepStateRoots) return cleared;
  // A helper that reads the machine's *own* history needs to be pointed at
  // where that history is. The prefixes above are credential prefixes, but a
  // vendor puts its state root under the same one — `CLAUDE_CONFIG_DIR`,
  // `CODEX_HOME` — so clearing by prefix sends an ambient `session/list` to the
  // default location and it reports the machine as having no history at all,
  // which is the opposite of what that feature is for.
  for (const key of VENDOR_STATE_ROOT_KEYS) {
    const value = ambient[key];
    if (value !== undefined) cleared[key] = value;
  }
  return cleared;
}

/**
 * Vendor variables that name *where state lives*, not a credential.
 *
 * Listed by name rather than matched by prefix, because that is the whole
 * distinction: `CLAUDE_CONFIG_DIR` and `CLAUDE_API_KEY` share a prefix and are
 * opposite kinds of thing.
 */
const VENDOR_STATE_ROOT_KEYS = [
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "OPENCODE_CONFIG",
  "GEMINI_CONFIG_DIR",
] as const;

export function filterAmbientEnv(ambient: NodeJS.ProcessEnv): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(ambient)) {
    if (value === undefined) continue;
    // Windows reports its own casing (`Path`, `SystemRoot`, `ComSpec`), so an
    // exact-match allowlist would strip a bound run's PATH there and it would
    // not spawn at all. The key is preserved as the OS spells it.
    const canonical = key.toUpperCase();
    if (ALLOWED_AMBIENT_KEYS.has(canonical) || canonical.startsWith("LC_")) safe[key] = value;
  }
  return safe;
}

/**
 * Writes the profile the control plane specified and returns the environment
 * pointing at it. For an unbound run there is nothing to write but the login
 * link — the frame carries no files and no literal environment.
 *
 * The daemon deliberately knows nothing about Codex TOML or OpenCode JSON: it
 * creates a directory, writes the bytes it was handed, and reports the paths
 * back as environment. Every runtime-shaped decision stays on the server,
 * where the server-host path already makes it — one implementation, not two
 * that drift.
 *
 * The directory is reused across runs and is never deleted: it holds the
 * runtime's conversation state, which the next turn resumes. Only the files
 * named in the frame are (re)written, because each run's lease token differs.
 *
 * Two consequences worth stating rather than discovering:
 *
 * - A written config outlives its run, carrying that run's lease token. The
 *   token is revoked when the run ends, so what remains on disk is a dead
 *   credential in a 0700 directory on the user's own machine. The provider's
 *   real API key is never here — it stays inside the server process.
 * - Two runs of the same Agent, in the same container, on the same adapter and
 *   backend share this directory, so the second to start rewrites the first's
 *   config. Both name the same upstream, so a run can only end up using a
 *   *sibling* run's lease; usage then attributes to that run rather than to
 *   itself. Two Agents, or one Agent in two Rooms, no longer share it at all.
 */
export async function materializeProviderBinding(
  binding: ProviderBindingFrame,
  profileRoot: string,
  loginHome: string | null,
  log: (line: string) => void = () => {},
): Promise<Record<string, string>> {
  const root = resolve(profileRoot);
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (binding.login_link) await linkLoginCredential(root, binding.login_link, loginHome, log);

  for (const file of binding.files) {
    const target = resolveInsideProfile(root, file.relative_path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    // A config that must name an absolute path inside the profile (Codex's
    // model catalog) can only be completed here, where the path is known.
    // On Windows that path contains backslashes, which a TOML basic string
    // reads as escapes — so it is encoded for the file it lands in.
    const substitution = file.escape === "toml_basic_string" ? tomlBasicStringBody(root) : root;
    const contents = file.contents.split(PROFILE_ROOT_PLACEHOLDER).join(substitution);
    await writeFile(target, contents, { encoding: "utf8", mode: 0o600 });
  }
  const env: Record<string, string> = { ...binding.env };
  for (const [key, relative] of Object.entries(binding.profile_env)) {
    env[key] = relative === "." ? root : resolveInsideProfile(root, relative);
  }
  return env;
}

/**
 * Points this profile at the one login this installation has.
 *
 * A **link**, never a copy and never a token in the environment. Passing the
 * credential through `CLAUDE_CODE_OAUTH_TOKEN` or its equivalents would mean
 * something read a credential and injected it into a subprocess, which is the
 * shape ADR 0008 forbids; copying it would mean this daemon held the bytes.
 * With a link the CLI opens its own file and nothing here ever reads it — the
 * only calls made are `symlink`/`link` and a `lstat` to see whether a link is
 * already in place.
 *
 * A symlink first, a hard link as the fallback: Windows refuses `symlink`
 * without Developer Mode or elevation, and `link` needs neither on the same
 * volume. Both share the file rather than duplicating it, which is what makes
 * one login serve every profile on the machine.
 *
 * Missing login file → no link, and the first dispatch surfaces the runtime's
 * own login prompt. That is the intended behavior, not an error to fail the
 * run with: a person who has not logged this runtime in should be told so by
 * the runtime. A link that *fails* is different and does throw — a headless
 * dispatch cannot answer a login prompt, so a profile silently left without a
 * credential fails the run with no reason anybody can act on.
 *
 * **Not verified on a real paired host** (this plan's open verification item):
 * whether each runtime refreshes an expired credential in place or by
 * temp-file rename. A rename replaces this link with a private copy, and that
 * profile then keeps its own credential while the others keep the shared one.
 * Each stays usable; what is unknown is whether a rotating refresh token would
 * invalidate the siblings.
 */
async function linkLoginCredential(
  profileRoot: string,
  link: NonNullable<ProviderBindingFrame["login_link"]>,
  loginHome: string | null,
  log: (line: string) => void,
): Promise<void> {
  if (!loginHome) return;
  const source = resolveInsideProfile(resolve(loginHome), join(link.home_subdir, link.credential_file));
  const sourceInfo = await stat(source).catch(() => null);
  const target = resolveInsideProfile(profileRoot, join(link.home_subdir, link.credential_file));
  // `lstat`, not `existsSync`, which follows a link and would say "there" for
  // a dangling one left by a login home that has since been removed.
  const current = await lstat(target).catch(() => null);
  if (!sourceInfo) {
    // No login here yet. Not an error: the first dispatch surfaces the
    // runtime's own login prompt, which is who should be asking. What must
    // not stay is a symlink into a login home that no longer has one — the
    // runtime's own login would then write through it into a removed
    // directory and fail with ENOENT instead of logging in. A regular file is
    // a credential this profile holds itself and is left alone.
    if (current?.isSymbolicLink()) {
      await rm(target, { force: true });
      log(`profile ${profileRoot}: removed a login link whose login home has no credential`);
    }
    return;
  }
  if (current) {
    if (current.isSymbolicLink()) {
      // A symlink follows a re-login in the login home on its own — but only
      // while it still points at *this* login home. A profile first
      // materialized under `managed:<version>` links into that copy's tree,
      // and the profile key carries no installation, so the same directory is
      // reached again after the Agent is moved to `own` or the managed copy is
      // replaced. Then the link is either dangling or authenticating as the
      // wrong installation, and nothing else on the machine would repair it.
      const resolved = await stat(target).catch(() => null);
      if (resolved && resolved.ino === sourceInfo.ino && resolved.dev === sourceInfo.dev) return;
      await rm(target, { force: true });
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await linkOrHardLink(source, target);
      return;
    }
    // A regular file is either the Windows hard-link fallback or a credential
    // the runtime wrote here itself by refreshing. Both look the same on disk
    // once a temp-file rename has dropped the shared inode's link count, so
    // inode identity cannot tell them apart — but recency can, and it answers
    // the question that actually matters: which of the two credentials is
    // current. A login home re-authenticated after this file was linked is
    // newer and this profile must follow it, or it stays pinned to an
    // orphaned inode silently and forever. A profile that refreshed itself
    // later is newer and must be left alone, or the relink would undo it.
    if (sourceInfo.mtimeMs <= current.mtimeMs) {
      // A private copy newer than the login home is the one state nothing
      // else on the machine would ever surface: this profile stopped sharing
      // the login, most likely because the runtime refreshed its token by
      // temp-file rename. Said here so an operator can tell which profile
      // diverged; a hard link to the same inode is the Windows fallback and
      // is not divergence.
      if (current.ino !== sourceInfo.ino || current.dev !== sourceInfo.dev) {
        log(`profile ${profileRoot}: keeps its own ${link.credential_file}, newer than the login home's; it no longer shares that login`);
      }
      return;
    }
    await rm(target, { force: true });
  }
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await linkOrHardLink(source, target);
}

/**
 * Windows without Developer Mode refuses `symlink`; `link` needs neither that
 * nor elevation on the same volume. A failure is reported rather than
 * swallowed: a headless dispatch cannot answer a login prompt, so a profile
 * with no credential fails the run anyway — with a reason nobody can act on
 * unless it is said here.
 */
async function linkOrHardLink(source: string, target: string): Promise<void> {
  try {
    await symlink(source, target);
  } catch {
    await link_(source, target);
  }
}

/** The inside of a TOML basic string: escapes only, no surrounding quotes. */
function tomlBasicStringBody(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

/**
 * The frame comes from the control plane, but this daemon runs unsandboxed on
 * a machine the user owns, so a path that escapes the profile would write
 * anywhere. Refuse rather than trust the sender. Used for the login home too,
 * where the same reasoning applies to `home_subdir`.
 */
function resolveInsideProfile(root: string, relativePath: string): string {
  if (isAbsolute(relativePath)) {
    throw new Error(`Provider binding file path must be relative: ${relativePath}`);
  }
  const target = resolve(root, normalize(relativePath));
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`Provider binding file path escapes the run profile: ${relativePath}`);
  }
  return target;
}

/**
 * Removes the directories of runs that are not running here any more.
 *
 * A run directory holds this run's outputs and its work surface — the Skill it
 * was given — and an earlier daemon also scoped a provider profile into it.
 * The same run id never comes back, so nothing else would ever remove one: a
 * daemon killed mid-run would otherwise leave it forever.
 */
export async function sweepOrphanedRunDirectories(runsRoot: string, activeRunIds: Set<string>): Promise<number> {
  const { readdir } = await import("node:fs/promises");
  let removed = 0;
  let entries: string[];
  try {
    entries = await readdir(runsRoot);
  } catch {
    return 0;
  }
  for (const runId of entries) {
    if (activeRunIds.has(runId)) continue;
    try {
      await rm(join(runsRoot, runId), { recursive: true, force: true });
      removed += 1;
    } catch {
      // A directory we cannot remove is worth neither crashing nor retrying.
    }
  }
  return removed;
}
