import {
  HostCapabilitiesSchema,
  type HostCapabilities,
  type RuntimeInstallation,
  type RuntimeAuthMethod,
  type RuntimeOptionChoice,
  type RuntimeOptions,
  type RuntimeSessionConfigOption,
} from "@rainver/protocol";

/**
 * What a host can run, in the one shape every reader uses. A runtime on a
 * host has one identity — the adapter type and the copy (`own` or
 * `managed:<version>`) — and everything about a copy (version, login state,
 * the options it reports) lives on the copy.
 *
 * Normalized once when a daemon's hello/heartbeat is recorded. The daemon and
 * server ship together, so obsolete capability layouts are rejected instead
 * of maintaining a second interpretation path.
 */
export type { HostCapabilities, RuntimeAuthMethod, RuntimeInstallation, RuntimeOptionChoice, RuntimeOptions, RuntimeSessionConfigOption } from "@rainver/protocol";
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
          ? [{ value: entry.value, name: typeof entry.name === "string" ? entry.name : null, description: typeof entry.description === "string" ? entry.description : null, group: typeof entry.group === "string" ? entry.group : null }]
          : [];
      })
    : [];
}
function configOptions(value: unknown): RuntimeSessionConfigOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): RuntimeSessionConfigOption[] => {
    const entry = record(item);
    if (typeof entry.id !== "string" || typeof entry.name !== "string") return [];
    const base = {
      id: entry.id,
      name: entry.name,
      description: typeof entry.description === "string" ? entry.description : null,
      category: typeof entry.category === "string" ? entry.category : null,
    };
    if (entry.type === "boolean" && typeof entry.current_value === "boolean") {
      return [{ ...base, type: "boolean" as const, current_value: entry.current_value }];
    }
    if (entry.type === "select" && typeof entry.current_value === "string") {
      return [{ ...base, type: "select" as const, current_value: entry.current_value, options: choices(entry.options) }];
    }
    return [];
  });
}
function authMethods(value: unknown): RuntimeAuthMethod[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): RuntimeAuthMethod[] => {
    const entry = record(item);
    if (typeof entry.id !== "string" || typeof entry.name !== "string" || (entry.type !== "agent" && entry.type !== "terminal")) return [];
    return [{
      id: entry.id,
      name: entry.name,
      description: typeof entry.description === "string" ? entry.description : null,
      type: entry.type,
      args: strings(entry.args),
      env: stringMap(entry.env),
    }];
  });
}
function options(value: unknown): RuntimeOptions | null {
  if (!value || typeof value !== "object") return null;
  const entry = record(value);
  return Array.isArray(entry.config_options)
    ? {
        config_options: configOptions(entry.config_options),
        auth_methods: authMethods(entry.auth_methods),
        cli_login_available: entry.cli_login_available === true,
        authenticated: typeof entry.authenticated === "boolean" ? entry.authenticated : null,
      }
    : null;
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

export function normalizeHostCapabilities(raw: unknown): HostCapabilities {
  const source = record(raw);
  const runtimes = strings(source.runtimes);
  const versions = stringMap(source.versions);
  const installations: Record<string, RuntimeInstallation[]> = {};
  for (const [adapterType, copies] of Object.entries(record(source.installations))) {
    const parsed = Array.isArray(copies) ? copies.flatMap((copy) => { const entry = installation(copy); return entry ? [entry] : []; }) : [];
    if (parsed.length > 0) installations[adapterType] = parsed;
  }
  return HostCapabilitiesSchema.parse({ runtimes, versions, installations });
}

/** The copies of a runtime a host reports, by id. */
export function hostInstallationIds(capabilities: unknown, adapterType: string): string[] {
  return (normalizeHostCapabilities(capabilities).installations[adapterType] ?? []).map((copy) => copy.id);
}

export function hostInstallationOptions(
  capabilities: unknown,
  adapterType: string,
  installationId: string,
): RuntimeSessionConfigOption[] {
  return normalizeHostCapabilities(capabilities).installations[adapterType]
    ?.find((copy) => copy.id === installationId)?.options?.config_options ?? [];
}

export function hostInstallationAuthMethods(
  capabilities: unknown,
  adapterType: string,
  installationId: string,
): RuntimeAuthMethod[] {
  return normalizeHostCapabilities(capabilities).installations[adapterType]
    ?.find((copy) => copy.id === installationId)?.options?.auth_methods ?? [];
}

export function hostInstallationCliLoginAvailable(
  capabilities: unknown,
  adapterType: string,
  installationId: string,
): boolean {
  return normalizeHostCapabilities(capabilities).installations[adapterType]
    ?.find((copy) => copy.id === installationId)?.options?.cli_login_available === true;
}
