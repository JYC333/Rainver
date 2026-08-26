import {
  listRuntimeAdapterSpecs,
  type RuntimeAdapterSpec,
  type RuntimeDistribution,
  type RuntimeLoginSpec,
} from "../runtimeAdapters/index.js";
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
 */
export interface RuntimeProbe {
  adapter_type: string;
  /** The PATH binary of the machine's own install, or null when there is none to look for. */
  runtime: string | null;
  /** The launch argv, with the daemon's cwd placeholder where a workspace path goes. */
  argv: string[];
  /** How to obtain a managed copy; null when the registry could not say. */
  distribution: RuntimeDistribution | null;
  /** The pinned version a managed install gets, when the distribution names one. */
  version: string | null;
  login: RuntimeLoginSpec | null;
  remote_host_only: boolean;
}

function acpSpecs(): RuntimeAdapterSpec[] {
  return listRuntimeAdapterSpecs().filter((spec) =>
    spec.runtime_kind === "local_cli"
    && spec.implementation_status === "implemented"
    && spec.invocation?.protocol === "acp"
    && spec.executable?.command);
}

/**
 * A builtin adapter's managed copy is whatever the ACP registry publishes
 * for it, as last resolved by the acpAgents refresh loop — never fetched
 * here, on a daemon's hello.
 */
function resolveDistribution(spec: RuntimeAdapterSpec): { distribution: RuntimeDistribution | null; version: string | null } {
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

export function acpRuntimeProbes(): RuntimeProbe[] {
  return acpSpecs().map((spec) => {
    const remoteHostOnly = spec.invocation!.remote_host_only === true;
    const resolved = resolveDistribution(spec);
    return {
      adapter_type: spec.adapter_type,
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

/** The probe for one adapter, for an install request. */
export function acpRuntimeProbe(adapterType: string): RuntimeProbe | null {
  return acpRuntimeProbes().find((probe) => probe.adapter_type === adapterType) ?? null;
}
