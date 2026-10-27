import type { OwnCopyCandidate, RuntimeProbe } from "@rainver/protocol";
import { basename } from "node:path";
import {
  listRuntimeAdapterSpecs,
  type RuntimeAdapterSpec,
  type RuntimeDistribution,
} from "../runtimeAdapters/index.js";
import { SERVER_OPENCODE_RELEASE } from "../runtimeAdapters/opencodeRelease.js";
import { renderCommandTemplate } from "../runs/cliCommandRendering.js";
import { REMOTE_HOST_ACP_CWD_PLACEHOLDER } from "../runs/remoteHostCliAdapter.js";
import { resolvedRegistryEntry } from "../acpAgents/registry.js";

function acpSpecs(): RuntimeAdapterSpec[] {
  return listRuntimeAdapterSpecs().filter((spec) =>
    spec.runtime_kind === "local_cli"
    && spec.implementation_status === "implemented"
    && spec.invocation?.protocol === "acp"
    && spec.executable?.command);
}

/**
 * Which machine the probe is for. The built-in Server Host installs what this
 * Rainver release pins; a paired Host installs what the ACP registry publishes
 * and upgrades only when its owner says so.
 */
export type ProbeHostKind = "server" | "remote";

/**
 * A builtin adapter's managed copy is whatever the ACP registry publishes
 * for it, as last resolved by the acpAgents refresh loop — never fetched
 * here, on a daemon's hello.
 *
 * The one exception is the Server Host's OpenCode, which the release pins
 * (ADR 0022): the release constant answers here so that the
 * install path has a single resolved distribution to send, instead of a
 * second branch deciding the same thing again at the route.
 */
function resolveDistribution(
  spec: RuntimeAdapterSpec,
  hostKind: ProbeHostKind,
): { distribution: RuntimeDistribution | null; version: string | null } {
  if (hostKind === "server" && spec.runtime_key === "opencode") {
    return { distribution: SERVER_OPENCODE_RELEASE.distribution, version: SERVER_OPENCODE_RELEASE.version };
  }
  const declared = spec.distribution;
  if (!declared) return { distribution: null, version: null };
  // A snapshot carries its version beside the distribution (`distribution_version`); nothing is parsed out of a package string.
  if (!("registry_id" in declared)) return { distribution: declared, version: spec.distribution_version ?? null };
  const entry = resolvedRegistryEntry(declared.registry_id);
  return entry ? { distribution: entry.distribution, version: entry.version } : { distribution: null, version: null };
}

/**
 * What a person who installed this agent themselves would have on PATH, as
 * far as the registry says. A binary target names its executable (`./goose`,
 * `./bin/devin`, `./dist-package/cursor-agent`); the file name is what the
 * machine would carry, with the entry's launch arguments. An npm package's
 * command names live in its own `bin` field, which the daemon reads from a
 * global install. ACP has no discovery of its own, so this is inference —
 * the daemon reports a copy only once it answers `initialize`.
 */
export function ownCopyCandidates(distribution: RuntimeDistribution): OwnCopyCandidate[] {
  if (distribution.kind === "npx") {
    return [{ kind: "npm", package: packageNameOf(distribution.package), args: distribution.args }];
  }
  if (distribution.kind === "uvx") {
    // `uv tool install` exposes a command named after the project.
    return [{ kind: "binary", command: distribution.package.split(/[=<>!~\[]/)[0]!.trim(), args: distribution.args }];
  }
  const seen = new Map<string, OwnCopyCandidate>();
  for (const target of Object.values(distribution.platforms)) {
    const command = basename(target.cmd.replace(/\\/g, "/"));
    if (!command || command === "." || seen.has(command)) continue;
    seen.set(command, { kind: "binary", command, args: target.args });
  }
  return [...seen.values()];
}

/** `@scope/name@1.2.3` → `@scope/name`; `name@1.2.3` → `name`. */
function packageNameOf(spec: string): string {
  const at = spec.lastIndexOf("@");
  return at > 0 ? spec.slice(0, at) : spec;
}

/**
 * `hostKind` defaults to `"remote"` because that is what a probe means with no
 * machine named: the registry's answer for a paired Host. Only the Server
 * Host's own install path names `"server"`.
 */
export function acpRuntimeProbes(hostKind: ProbeHostKind = "remote"): RuntimeProbe[] {
  return acpSpecs().map((spec) => {
    const remoteHostOnly = spec.invocation!.remote_host_only === true;
    const resolved = resolveDistribution(spec, hostKind);
    return {
      runtime_key: spec.runtime_key,
      runtime: remoteHostOnly ? null : (spec.invocation!.remote_capability_probe ?? spec.executable!.command!),
      // A builtin names its PATH binary above; a registry agent has none, so
      // the daemon is told where such a copy might be and verifies by handshake.
      ...(remoteHostOnly && resolved.distribution ? { own_candidates: ownCopyCandidates(resolved.distribution) } : {}),
      argv: renderCommandTemplate(spec.invocation!.headless_command_template, {
        executable: spec.executable!.command!,
        sandbox_cwd: REMOTE_HOST_ACP_CWD_PLACEHOLDER,
      }),
      distribution: resolved.distribution,
      version: resolved.version,
      login: spec.credentials.login ?? null,
      state: spec.credentials.state ?? null,
      remote_host_only: remoteHostOnly,
    };
  });
}

/** The probe for one adapter on one machine, for an install request. */
export function acpRuntimeProbe(runtimeKey: string, hostKind: ProbeHostKind = "remote"): RuntimeProbe | null {
  return acpRuntimeProbes(hostKind).find((probe) => probe.runtime_key === runtimeKey) ?? null;
}
