import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import type { ProviderBindingFrame } from "./execution.js";

/** Replaced with the absolute profile directory when files are written. */
export const PROFILE_ROOT_PLACEHOLDER = "{{RAINVER_RUN_PROFILE}}";

/**
 * Environment a *bound* run inherits from this machine.
 *
 * An allowlist, not a denylist, because B67 states the rule that way round:
 * backend selection comes only from what the control plane injects, so the
 * question is what a runtime legitimately needs from the machine — not which
 * of the machine's variables we remembered to name. The server host reaches
 * the same conclusion in `runs/cliSubprocessEnv.ts`, and a denylist here would
 * have let `CLAUDE_CODE_OAUTH_TOKEN`, `XDG_DATA_HOME` and `NODE_OPTIONS`
 * through, each of which redirects a run somewhere the control plane did not
 * choose.
 *
 * A run with **no** binding does not come through here at all; it keeps the
 * machine's environment untouched, which is the pre-existing behavior.
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
 * pointing at it.
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
 * - Two runs sharing an adapter and provider share this directory, so the
 *   second to start rewrites the first's config. Both name the same upstream,
 *   so a run can only end up using a *sibling* run's lease; usage then
 *   attributes to that run rather than to itself.
 */
export async function materializeProviderBinding(
  binding: ProviderBindingFrame,
  profileRoot: string,
): Promise<Record<string, string>> {
  const root = resolve(profileRoot);
  await mkdir(root, { recursive: true, mode: 0o700 });

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

/** The inside of a TOML basic string: escapes only, no surrounding quotes. */
function tomlBasicStringBody(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

/**
 * The frame comes from the control plane, but this daemon runs unsandboxed on
 * a machine the user owns, so a path that escapes the profile would write
 * anywhere. Refuse rather than trust the sender.
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
 * Removes per-run profiles written by an earlier version of this daemon, which
 * scoped a profile to one run and deleted it when the run ended. Nothing
 * writes that layout any more, so on a machine that never ran the old daemon
 * this finds nothing; on one that did, it reclaims directories no run will
 * come back for.
 */
export async function sweepOrphanedProfiles(runsRoot: string, activeRunIds: Set<string>): Promise<number> {
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
    const profile = join(runsRoot, runId, "profile");
    try {
      const { stat } = await import("node:fs/promises");
      await stat(profile);
      await rm(profile, { recursive: true, force: true });
      removed += 1;
    } catch {
      // A profile we cannot remove is worth neither crashing nor retrying.
    }
  }
  return removed;
}
