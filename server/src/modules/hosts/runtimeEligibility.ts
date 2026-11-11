import { getRuntimeAdapterSpec, listRuntimeAdapterSpecs } from "../runtimeAdapters/index.js";

/** Runtime adapters a Host can install a managed copy of: implemented local ACP CLIs. */
export function remoteInstallableRuntimeKeys(): string[] {
  return listRuntimeAdapterSpecs()
    .filter((spec) =>
      spec.runtime_kind === "local_cli"
      && spec.implementation_status === "implemented"
      && spec.invocation?.protocol === "acp")
    .map((spec) => spec.runtime_key);
}

/**
 * Whether an unbound Host Run can use this adapter: it needs the state
 * contract that gives each Agent a separate state root without losing the
 * installation's login. Login itself may be a CLI command or ACP Agent Auth.
 */
export function isRemoteDispatchEligible(runtimeKey: string): boolean {
  const spec = getRuntimeAdapterSpec(runtimeKey);
  return spec?.runtime_kind === "local_cli"
    && spec.implementation_status === "implemented"
    && spec.invocation?.protocol === "acp"
    && spec.credentials?.state !== undefined;
}

/** `managed:<version>` → the version; anything else (including `own`) is not a managed copy. */
export function managedVersionOf(installation: string | null): string | null {
  return installation?.startsWith("managed:") ? installation.slice("managed:".length) : null;
}

export function posixAbsoluteCommandPath(path: string): boolean {
  return path.startsWith("/") && !path.includes("\0") && path.length <= 4096;
}
