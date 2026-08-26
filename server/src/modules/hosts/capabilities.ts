import {
  HostCapabilitiesSchema,
  OWN_INSTALLATION,
  type HostCapabilities,
  type RuntimeInstallation,
  type RuntimeOptionChoice,
  type RuntimeOptions,
} from "@rainver/protocol";
import { getLocalCliRuntimeAdapterSpec, listRuntimeAdapterSpecs, type LocalCliRuntimeAdapterSpec } from "../runtimeAdapters/index.js";

/**
 * What a host can run, in the one shape every reader uses. A runtime on a
 * host has one identity — the adapter type and the copy (`own` or
 * `managed:<version>`) — and everything about a copy (version, login state,
 * the options it reports) lives on the copy.
 *
 * Normalized once, when a daemon's hello/heartbeat is recorded, so the
 * daemon's wire format and its history are this module's concern alone: a
 * daemon that predates `installations` reported PATH binaries plus per-binary
 * option maps, and that is translated here into the `own` copies it meant.
 */
export type { HostCapabilities, RuntimeInstallation, RuntimeOptionChoice, RuntimeOptions } from "@rainver/protocol";
export { OWN_INSTALLATION } from "@rainver/protocol";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
function stringMap(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(record(value)).filter((pair): pair is [string, string] => typeof pair[1] === "string"));
}
function choices(value: unknown): RuntimeOptionChoice[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const entry = record(item);
        return typeof entry.value === "string"
          ? [{ value: entry.value, name: typeof entry.name === "string" ? entry.name : null, description: typeof entry.description === "string" ? entry.description : null }]
          : [];
      })
    : [];
}
function options(value: unknown): RuntimeOptions | null {
  if (!value || typeof value !== "object") return null;
  const entry = record(value);
  return {
    models: choices(entry.models),
    current_model: typeof entry.current_model === "string" ? entry.current_model : null,
    efforts: choices(entry.efforts),
    current_effort: typeof entry.current_effort === "string" ? entry.current_effort : null,
  };
}
function installation(value: unknown): RuntimeInstallation | null {
  const entry = record(value);
  if (typeof entry.id !== "string") return null;
  return {
    id: entry.id,
    version: typeof entry.version === "string" ? entry.version : null,
    logged_in: typeof entry.logged_in === "boolean" ? entry.logged_in : null,
    options: options(entry.options),
  };
}

/** The PATH binary a spec's own copy is detected by. */
function probeBinary(spec: LocalCliRuntimeAdapterSpec): string | null {
  return spec.invocation.remote_host_only ? null : (spec.invocation.remote_capability_probe ?? spec.executable.command);
}

export function normalizeHostCapabilities(raw: unknown): HostCapabilities {
  const source = record(raw);
  const runtimes = strings(source.runtimes);
  const versions = stringMap(source.versions);
  const installations: Record<string, RuntimeInstallation[]> = {};
  if (source.installations && typeof source.installations === "object") {
    for (const [adapterType, copies] of Object.entries(record(source.installations))) {
      const parsed = Array.isArray(copies) ? copies.flatMap((copy) => { const entry = installation(copy); return entry ? [entry] : []; }) : [];
      if (parsed.length > 0) installations[adapterType] = parsed;
    }
    return HostCapabilitiesSchema.parse({ runtimes, versions, installations });
  }
  // A daemon that predates installations: each ACP adapter whose binary is on
  // PATH is one `own` copy, with whatever that daemon knew about it.
  const legacyOptions = record(source.options);
  const legacyModels = stringMap(source.models);
  const legacyReasoning = stringMap(source.reasoning);
  for (const spec of listRuntimeAdapterSpecs()) {
    const local = getLocalCliRuntimeAdapterSpec(spec.adapter_type);
    if (!local || local.implementation_status !== "implemented" || local.invocation.protocol !== "acp") continue;
    const binary = probeBinary(local);
    if (!binary || !runtimes.includes(binary)) continue;
    const asked = options(legacyOptions[binary]);
    installations[local.adapter_type] = [{
      id: OWN_INSTALLATION,
      version: versions[binary] ?? null,
      logged_in: null,
      options: asked ?? (legacyModels[binary] || legacyReasoning[binary]
        ? { models: [], current_model: legacyModels[binary] ?? null, efforts: [], current_effort: legacyReasoning[binary] ?? null }
        : null),
    }];
  }
  return HostCapabilitiesSchema.parse({ runtimes, versions, installations });
}

/** The copies of a runtime a host reports, by id. */
export function hostInstallationIds(capabilities: unknown, adapterType: string): string[] {
  return (normalizeHostCapabilities(capabilities).installations[adapterType] ?? []).map((copy) => copy.id);
}
