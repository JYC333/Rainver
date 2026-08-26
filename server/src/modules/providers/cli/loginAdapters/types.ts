import type { LoginRuntimeConfig } from "../loginEngine.js";
import { BUILTIN_RUNTIME_ADAPTER_SPECS, type RuntimeAdapterType } from "../../../runtimeAdapters/specs.js";

export interface CliLoginAdapter extends LoginRuntimeConfig {
  runtime: string;
  target_path: string;
}

/**
 * The login knowledge an adapter shares with the daemon's login terminal,
 * read from the runtime adapter spec so it is written once.
 */
export function loginFieldsFromSpec(adapterType: RuntimeAdapterType): Pick<LoginRuntimeConfig, "command" | "home_subdir" | "credential_file" | "hint_cli"> {
  const login = BUILTIN_RUNTIME_ADAPTER_SPECS[adapterType].credentials.login;
  if (!login) throw new Error(`${adapterType} declares no login in its runtime adapter spec`);
  return {
    command: login.command,
    home_subdir: login.home_subdir,
    credential_file: login.credential_file,
    ...(login.hint ? { hint_cli: login.hint } : {}),
  };
}
