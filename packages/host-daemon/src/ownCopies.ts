import { accessSync, constants, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { OwnCopyCandidate } from "@rainver/protocol";
import { probeAcpIdentity } from "./acpProbe.js";
import { npmGlobalRoots } from "./userPath.js";

/**
 * A registry agent the owner installed themselves.
 *
 * ACP has no discovery: nothing in the protocol or the registry says what an
 * installed agent is called on a machine. What the registry does say is how
 * the agent is launched once obtained — an executable name and arguments for
 * a binary, a package for npm — and the server passes that down as
 * candidates (`own_candidates`). This module turns a candidate into a path
 * on PATH and keeps only what answers an ACP `initialize`: a same-named
 * binary that speaks something else is not a copy, and is not reported.
 *
 * The verified launch is remembered per runtime key so a Run or a login for
 * the `own` copy starts the same executable the probe found, rather than
 * the runtime key the server's launch template names.
 */
export interface OwnCopyLaunch {
  command: string;
  args: string[];
}

export interface OwnCopy extends OwnCopyLaunch {
  /** What the agent said in `initialize`'s `agentInfo`; null when it gave none. */
  version: string | null;
}

const ownLaunches = new Map<string, OwnCopyLaunch>();

/** The verified launch of a runtime's own copy, for `resolveAcpLaunch`. */
export function ownLaunchFor(runtimeKey: string): OwnCopyLaunch | null {
  return ownLaunches.get(runtimeKey) ?? null;
}

/**
 * Each verification starts an agent process, so a result stands for a while:
 * a found copy until the next catalog change or restart would plausibly move
 * it, an absence long enough that a heartbeat does not spawn every
 * candidate on the machine each minute.
 */
const FOUND_TTL_MS = 15 * 60 * 1000;
const ABSENT_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { at: number; value: OwnCopy | null }>();

/** Exported for tests: forget every verified copy. */
export function __clearOwnCopies(): void {
  cache.clear();
  ownLaunches.clear();
}

export async function findOwnCopy(
  runtimeKey: string,
  candidates: readonly OwnCopyCandidate[],
  log: (line: string) => void = () => {},
  verify: (command: string, args: string[]) => Promise<{ version: string | null } | null> = verifyByHandshake,
): Promise<OwnCopy | null> {
  const key = `${runtimeKey}:${JSON.stringify(candidates)}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < (cached.value ? FOUND_TTL_MS : ABSENT_TTL_MS)) return cached.value;
  let found: OwnCopy | null = null;
  for (const launch of resolveCandidates(candidates)) {
    const identity = await verify(launch.command, launch.args);
    if (!identity) {
      log(`${runtimeKey}: ${launch.command} is on PATH but did not answer ACP initialize; not a copy of this agent`);
      continue;
    }
    found = { ...launch, version: identity.version };
    break;
  }
  cache.set(key, { at: Date.now(), value: found });
  if (found) ownLaunches.set(runtimeKey, { command: found.command, args: found.args });
  else ownLaunches.delete(runtimeKey);
  return found;
}

/** Every candidate that resolves to an executable on this machine, in the server's order. */
export function resolveCandidates(
  candidates: readonly OwnCopyCandidate[],
  env: NodeJS.ProcessEnv = process.env,
): OwnCopyLaunch[] {
  const launches: OwnCopyLaunch[] = [];
  const seen = new Set<string>();
  const add = (name: string, args: string[]) => {
    const command = findOnPath(name, env);
    if (!command || seen.has(command)) return;
    seen.add(command);
    launches.push({ command, args });
  };
  for (const candidate of candidates) {
    if (candidate.kind === "binary") {
      add(candidate.command, candidate.args);
      continue;
    }
    for (const name of npmBinNames(candidate.package)) add(name, candidate.args);
  }
  return launches;
}

/**
 * The commands an npm package exposes: its `bin` field, read from a global
 * install when one exists; otherwise the package's unscoped name, which is
 * what a package with one command is usually called.
 */
function npmBinNames(packageName: string): string[] {
  const names = new Set<string>();
  for (const root of npmGlobalRoots()) {
    try {
      const manifest = JSON.parse(readFileSync(join(root, ...packageName.split("/"), "package.json"), "utf8")) as { bin?: unknown; name?: unknown };
      if (typeof manifest.bin === "string") names.add(unscoped(typeof manifest.name === "string" ? manifest.name : packageName));
      else if (manifest.bin && typeof manifest.bin === "object") for (const name of Object.keys(manifest.bin)) names.add(name);
    } catch {
      // Not installed under this root.
    }
  }
  if (names.size === 0) names.add(unscoped(packageName));
  return [...names];
}

function unscoped(packageName: string): string {
  const slash = packageName.lastIndexOf("/");
  return slash >= 0 ? packageName.slice(slash + 1) : packageName;
}

/** `which`, over this process's PATH; a Windows name is tried with its PATHEXT suffixes too. */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  // A candidate is a bare name from the registry; a path separator in it
  // would let a registry entry point at an arbitrary file on the machine.
  if (name.includes("/") || name.includes("\\")) return null;
  const suffixes = platform() === "win32"
    ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)]
    : [""];
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    for (const suffix of suffixes) {
      const candidate = join(directory, name + suffix);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Keep looking.
      }
    }
  }
  return null;
}

async function verifyByHandshake(command: string, args: string[]): Promise<{ version: string | null } | null> {
  // Never a real workspace: some agents index whatever they are opened in.
  const cwd = await mkdtemp(join(tmpdir(), "rainver-own-copy-"));
  try {
    return await probeAcpIdentity(command, args, {}, cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
