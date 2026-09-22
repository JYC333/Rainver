import type { RuntimeProbe } from "@rainver/protocol";
import {
  listRuntimeAdapterSpecs,
  type RuntimeAdapterSpec,
  type RuntimeDistribution,
} from "../runtimeAdapters/index.js";
import { SERVER_OPENCODE_RELEASE } from "../runtimeAdapters/opencodeRelease.js";
import { renderCommandTemplate } from "../runs/cliCommandRendering.js";
import { REMOTE_HOST_ACP_CWD_PLACEHOLDER } from "../runs/remoteHostCliAdapter.js";
import { resolvedRegistryEntry } from "../acpAgents/registry.js";

/**
 * Everything a daemon needs to know about one runtime adapter, sent in
 * `hello_ack` so the adapter spec stays the only place that knows it: how
 * the machine's own copy is launched and asked for its options, how a
 * managed copy is obtained, and how either is logged into. The daemon holds
 * no list of its own; adding a runtime is a spec entry (or enabling a
 * registry agent), and the daemon needs no change.
 *
 * The shape is the wire's, not this module's: `RuntimeProbeSchema` in
 * `@rainver/protocol` declares the fields once and both ends type against it,
 * so a probe is built here and parsed there with nothing restating it.
 */
export type { RuntimeProbe };

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
 * (ADR 0022, Phase 2 §1): the release constant answers here so that the
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
  if (!("registry_id" in declared)) return { distribution: declared, version: versionOf(declared) };
  const entry = resolvedRegistryEntry(declared.registry_id);
  return entry ? { distribution: entry.distribution, version: entry.version } : { distribution: null, version: null };
}

/** `pkg@1.2.3` carries its own version; a registry snapshot's version lives on the agent. */
function versionOf(distribution: RuntimeDistribution): string | null {
  if (distribution.kind === "binary") return null;
  const at = distribution.package.lastIndexOf("@");
  return at > 0 ? distribution.package.slice(at + 1) : null;
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
      argv: renderCommandTemplate(spec.invocation!.headless_command_template, {
        executable: spec.executable!.command!,
        sandbox_cwd: REMOTE_HOST_ACP_CWD_PLACEHOLDER,
      }),
      distribution: resolved.distribution,
      version: resolved.version,
      login: spec.credentials.login ?? null,
      remote_host_only: remoteHostOnly,
    };
  });
}

/** The probe for one adapter on one machine, for an install request. */
export function acpRuntimeProbe(runtimeKey: string, hostKind: ProbeHostKind = "remote"): RuntimeProbe | null {
  return acpRuntimeProbes(hostKind).find((probe) => probe.runtime_key === runtimeKey) ?? null;
}
