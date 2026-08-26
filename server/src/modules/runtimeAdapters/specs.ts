import { getDynamicRuntimeAdapterSpec, listDynamicRuntimeAdapterSpecs } from "./dynamicSpecs.js";

export type RuntimeAdapterType =
  | "capability"
  | "model_api"
  | "ts_agent_host"
  | "claude_code"
  | "codex_cli"
  | "opencode"
  | "gemini_cli"
  | "custom";

/**
 * The implemented vendor CLIs. The one closed list: every per-vendor table
 * (`Record<VendorCliAdapterType, …>`) keys on it so the compiler names each
 * place a new CLI needs a decision, instead of a literal check silently
 * treating it as "not a CLI". Membership *checks* go through
 * `isVendorCliAdapter` / `isAcpRuntimeAdapter`, which read the spec.
 */
export type VendorCliAdapterType = Extract<RuntimeAdapterType, "claude_code" | "codex_cli" | "opencode">;

/**
 * How a managed copy of a runtime is obtained on an execution host — the
 * ACP registry's vocabulary (`modules/acpAgents/registry.ts`). A builtin
 * adapter names its registry entry and the server resolves the current
 * distribution at install time; a registry agent carries a snapshot.
 */
export interface RuntimeBinaryTarget {
  archive: string;
  cmd: string;
  args: string[];
  sha256: string | null;
  env: Record<string, string>;
}
export type RuntimeDistribution =
  | { kind: "npx"; package: string; args: string[]; env: Record<string, string> }
  | { kind: "uvx"; package: string; args: string[]; env: Record<string, string> }
  | { kind: "binary"; platforms: Record<string, RuntimeBinaryTarget> };

/**
 * How a runtime is logged into, and how a login is recognised. Shared by the
 * server-host login engine and the daemon's login terminal, so the knowledge
 * lives once. `command` is the vendor CLI as it is named on PATH (an `own`
 * installation); `managed_command` addresses the same CLI inside a managed
 * tree, with `{tree}` the install directory, `{node}` this daemon's node,
 * `{platform}` the registry platform key (`linux-x86_64`), and
 * `{node_platform}` node's own `<platform>-<arch>` (`linux-x64`).
 */
export interface RuntimeLoginSpec {
  command: string[];
  managed_command?: string[];
  home_subdir: string;
  credential_file: string;
  hint?: string;
}

export type RuntimeKind = "native" | "local_cli" | "managed_api" | "custom";
export type RuntimeExecutorFamily = "native" | "local_cli" | "managed_api" | "custom";
export type ImplementationStatus = "implemented" | "planned" | "disabled";
export type CredentialMode = "none" | "cli_profile" | "cli_profile_or_model_provider" | "model_provider_api_key";
export type CredentialReleaseChannel = "server_runtime_host";
type RuntimeConfigValue = string | number | boolean | Record<string, string>;

export interface RuntimeAdapterSpec {
  /** A builtin type, or a dynamic adapter's own id (`acp_<registry id>`). */
  adapter_type: RuntimeAdapterType | (string & {});
  display_name: string;
  runtime_kind: RuntimeKind;
  executor_family: RuntimeExecutorFamily;
  implementation_status: ImplementationStatus;
  enabled_by_default: boolean;
  subagent_support: "none" | "runtime_internal" | "unknown";
  subagent_disable_mechanism: "not_applicable" | "runtime_config" | "unsupported" | "unknown";
  subagent_disable_config?: {
    relative_path: string;
    deny_path: string[];
    denied_value: RuntimeConfigValue;
    required_values?: Array<{
      path: string[];
      value: RuntimeConfigValue;
      value_mode?: "array_contains" | "exact";
    }>;
  };
  delegation_controllability: "none" | "server_policy" | "runtime_config" | "unknown";
  structured_output: "none" | "provider_response" | "native_event_stream" | "unknown";
  checkpoint_resume: "none" | "runtime_session" | "unknown";
  cancellation_reliability: "confirmed" | "best_effort" | "unknown";
  observability_level: "structured" | "phase" | "opaque";
  side_effect_level: "none" | "workspace" | "external";
  data_exposure: "none" | "provider" | "space" | "unknown";
  baseline_trust_level: "low" | "medium" | "high";
  executable?: {
    command?: string;
    allow_path_override?: boolean;
  };
  invocation?: {
    headless_command_template: string[];
    resume_command_template?: string[];
    interactive_command_template?: string[];
    protocol?: "acp";
    /**
     * ACP runtime replatform P3: the daemon-probed vendor binary name to
     * check `capabilities_json.runtimes` against for remote eligibility,
     * when it differs from `executable.command`. An ACP adapter package
     * (e.g. `codex-acp`) is our own bundled client, not something a trusted
     * host has installed — the daemon's capability probe checks for the
     * underlying vendor CLI (`codex`) instead (see A6, hosts.md). Unset for
     * adapters whose vendor CLI natively speaks the wire protocol we use
     * (opencode: the daemon probes for "opencode" and that is also
     * `executable.command`).
     */
    remote_capability_probe?: string;
    /**
     * Runs only on a paired execution host, never on the server host: the
     * daemon installs and launches it from its own managed tools directory.
     * Set for ACP-registry adapters, which have no server-side runtime tool,
     * credential profile, or ModelProvider binding.
     */
    remote_host_only?: boolean;
  };
  /** How an execution host obtains a managed copy; absent = only the machine's own install. */
  distribution?: RuntimeDistribution | { registry_id: string };
  credentials: {
    credential_mode: CredentialMode;
    login?: RuntimeLoginSpec;
    credential_release_channel?: CredentialReleaseChannel;
    credential_runtime_name?: string;
    default_target_path?: string;
    supports_oauth_login_state?: boolean;
  };
  sandbox: {
    requires_file_access: boolean;
    minimum_sandbox_level: "none" | "dry_run" | "ephemeral" | "read_only" | "worktree" | "one_shot_docker";
    supports_worktree: boolean;
    supports_one_shot_docker: boolean;
    requires_workspace_for_execution: boolean;
  };
  model: {
    model_provider_mode: "none" | "optional" | "required";
    supports_model_override: boolean;
    model_arg_template?: string[];
    model_config_behavior: "uses_model" | "not_applicable" | "unsupported";
    /**
     * Which ModelProvider endpoint a CLI can be pointed at — the
     * `<provider_api>_base_url` a binding needs. Only meaningful for vendor
     * CLIs that accept a provider.
     */
    provider_api?: "claude_compatible" | "openai_compatible";
  };
  permissions: {
    supports_permission_bypass: boolean;
    permission_bypass_arg_template?: string[];
    permission_bypass_policy_key?: string;
  };
  usage: {
    usage_accuracy: "precise" | "estimated" | "unknown";
    supports_usage_probe: boolean;
    usage_probe_kind?: string;
  };
  output: {
    patch_strategy: "none" | "git_diff";
    artifact_path_strategy: "none";
  };
  limits: {
    default_timeout_seconds: number;
    max_timeout_seconds: number;
  };
}

export interface LocalCliRuntimeAdapterSpec extends RuntimeAdapterSpec {
  runtime_kind: "local_cli";
  executable: {
    command: string;
    allow_path_override?: boolean;
  };
  invocation: {
    headless_command_template: string[];
    resume_command_template?: string[];
    interactive_command_template?: string[];
    protocol?: "acp";
    remote_capability_probe?: string;
    remote_host_only?: boolean;
  };
  credentials: RuntimeAdapterSpec["credentials"] & {
    credential_mode: "cli_profile" | "cli_profile_or_model_provider";
    credential_runtime_name: string;
  };
}

const noFiles: RuntimeAdapterSpec["sandbox"] = {
  requires_file_access: false,
  minimum_sandbox_level: "none",
  supports_worktree: false,
  supports_one_shot_docker: false,
  requires_workspace_for_execution: false,
};

const worktreeCli: RuntimeAdapterSpec["sandbox"] = {
  requires_file_access: true,
  minimum_sandbox_level: "worktree",
  supports_worktree: true,
  supports_one_shot_docker: true,
  requires_workspace_for_execution: false,
};

export const BUILTIN_RUNTIME_ADAPTER_SPECS: Readonly<Record<RuntimeAdapterType, RuntimeAdapterSpec>> = {
  capability: {
    adapter_type: "capability",
    display_name: "Capability",
    runtime_kind: "native",
    executor_family: "native",
    implementation_status: "planned",
    enabled_by_default: false,
    subagent_support: "none",
    subagent_disable_mechanism: "not_applicable",
    delegation_controllability: "none",
    structured_output: "none",
    checkpoint_resume: "none",
    cancellation_reliability: "unknown",
    observability_level: "opaque",
    side_effect_level: "none",
    data_exposure: "none",
    baseline_trust_level: "low",
    credentials: { credential_mode: "none" },
    sandbox: noFiles,
    model: {
      model_provider_mode: "none",
      supports_model_override: false,
      model_config_behavior: "not_applicable",
    },
    permissions: { supports_permission_bypass: false },
    usage: {
      usage_accuracy: "unknown",
      supports_usage_probe: false,
    },
    output: {
      patch_strategy: "none",
      artifact_path_strategy: "none",
    },
    limits: { default_timeout_seconds: 300, max_timeout_seconds: 3600 },
  },
  model_api: {
    adapter_type: "model_api",
    display_name: "Model API",
    runtime_kind: "managed_api",
    executor_family: "managed_api",
    implementation_status: "implemented",
    enabled_by_default: true,
    subagent_support: "none",
    subagent_disable_mechanism: "not_applicable",
    delegation_controllability: "server_policy",
    structured_output: "provider_response",
    checkpoint_resume: "none",
    cancellation_reliability: "best_effort",
    observability_level: "structured",
    side_effect_level: "external",
    data_exposure: "provider",
    baseline_trust_level: "high",
    credentials: { credential_mode: "model_provider_api_key" },
    sandbox: noFiles,
    model: {
      model_provider_mode: "required",
      supports_model_override: false,
      model_config_behavior: "uses_model",
    },
    permissions: { supports_permission_bypass: false },
    usage: {
      usage_accuracy: "estimated",
      supports_usage_probe: false,
    },
    output: {
      patch_strategy: "none",
      artifact_path_strategy: "none",
    },
    limits: { default_timeout_seconds: 300, max_timeout_seconds: 3600 },
  },
  ts_agent_host: {
    adapter_type: "ts_agent_host",
    display_name: "Server Agent Host",
    runtime_kind: "managed_api",
    executor_family: "managed_api",
    implementation_status: "implemented",
    enabled_by_default: false,
    subagent_support: "none",
    subagent_disable_mechanism: "not_applicable",
    delegation_controllability: "server_policy",
    structured_output: "provider_response",
    checkpoint_resume: "none",
    cancellation_reliability: "best_effort",
    observability_level: "structured",
    side_effect_level: "external",
    data_exposure: "provider",
    baseline_trust_level: "high",
    credentials: {
      credential_mode: "model_provider_api_key",
      credential_release_channel: "server_runtime_host",
    },
    sandbox: noFiles,
    model: {
      model_provider_mode: "required",
      supports_model_override: false,
      model_config_behavior: "uses_model",
    },
    permissions: { supports_permission_bypass: false },
    usage: {
      usage_accuracy: "estimated",
      supports_usage_probe: false,
    },
    output: {
      patch_strategy: "none",
      artifact_path_strategy: "none",
    },
    limits: { default_timeout_seconds: 300, max_timeout_seconds: 3600 },
  },
  claude_code: {
    adapter_type: "claude_code",
    display_name: "Claude Code",
    runtime_kind: "local_cli",
    executor_family: "local_cli",
    implementation_status: "implemented",
    enabled_by_default: true,
    subagent_support: "runtime_internal",
    subagent_disable_mechanism: "runtime_config",
    subagent_disable_config: {
      relative_path: ".claude/settings.json",
      deny_path: ["permissions", "deny"],
      denied_value: "Task",
    },
    delegation_controllability: "runtime_config",
    structured_output: "native_event_stream",
    // ACP runtime replatform P4: Claude's opaque ACP session id is resumed by
    // the general AcpController, not by vendor-specific `--resume` argv.
    checkpoint_resume: "runtime_session",
    cancellation_reliability: "best_effort",
    observability_level: "structured",
    side_effect_level: "workspace",
    data_exposure: "provider",
    baseline_trust_level: "low",
    executable: { command: "claude-agent-acp", allow_path_override: true },
    distribution: { registry_id: "claude-acp" },
    invocation: {
      headless_command_template: ["{executable}"],
      resume_command_template: ["{executable}"],
      protocol: "acp",
      remote_capability_probe: "claude",
    },
    credentials: {
      login: {
        command: ["claude", "/login"],
        // The bundled SDK ships the vendor binary per platform.
        managed_command: ["{tree}/node_modules/@anthropic-ai/claude-agent-sdk-{node_platform}/claude", "/login"],
        home_subdir: ".claude",
        // `claude /login` exits non-zero from its REPL; the credential file is
        // the reliable success signal.
        credential_file: ".credentials.json",
        hint: "A browser URL will appear - open it to authorize your Claude.ai account.",
      },
      credential_mode: "cli_profile",
      credential_runtime_name: "claude_code",
      default_target_path: "/home/agent/.claude",
      supports_oauth_login_state: true,
    },
    sandbox: worktreeCli,
    model: {
      model_provider_mode: "none",
      supports_model_override: true,
      model_arg_template: ["--model", "{model}"],
      model_config_behavior: "uses_model",
      provider_api: "claude_compatible",
    },
    permissions: {
      // ACP's permission requests are answered by the controller. Keep the
      // policy key and an empty argv template so existing high-risk dispatch
      // policy remains valid without reviving Claude's CLI-only bypass flag.
      supports_permission_bypass: true,
      permission_bypass_arg_template: [],
      permission_bypass_policy_key: "allow_permission_bypass",
    },
    usage: {
      usage_accuracy: "precise",
      supports_usage_probe: false,
      usage_probe_kind: "cached_claude_quota",
    },
    output: {
      patch_strategy: "git_diff",
      artifact_path_strategy: "none",
    },
    limits: { default_timeout_seconds: 300, max_timeout_seconds: 3600 },
  },
  codex_cli: {
    adapter_type: "codex_cli",
    display_name: "Codex CLI",
    runtime_kind: "local_cli",
    executor_family: "local_cli",
    implementation_status: "implemented",
    enabled_by_default: true,
    subagent_support: "runtime_internal",
    subagent_disable_mechanism: "unknown",
    delegation_controllability: "unknown",
    structured_output: "unknown",
    // ACP runtime replatform P3: codex resumes an opaque session id through
    // `session/resume` (A7) — the general AcpController, not a bespoke
    // thread/resume RPC. The server keeps the corresponding `.codex` state in
    // the conversation's isolated HOME; each turn's usage is per-turn
    // already (session/prompt's own result.usage), no baseline subtraction
    // needed the way the deleted codex_app_server controller required.
    checkpoint_resume: "runtime_session",
    cancellation_reliability: "best_effort",
    observability_level: "opaque",
    side_effect_level: "workspace",
    data_exposure: "provider",
    baseline_trust_level: "low",
    // `codex-acp` is our own pinned ACP adapter (A6), not the vendor CLI
    // itself — it bundles a compatible `@openai/codex` and, absent
    // `CODEX_PATH`, spawns that bundled copy directly. `remote_capability_probe`
    // below still points capability checks at the vendor CLI name a trusted
    // host actually reports.
    executable: { command: "codex-acp", allow_path_override: true },
    distribution: { registry_id: "codex-acp" },
    invocation: {
      headless_command_template: ["{executable}"],
      protocol: "acp",
      remote_capability_probe: "codex",
    },
    credentials: {
      login: {
        command: ["codex", "login", "--device-auth"],
        managed_command: ["{node}", "{tree}/node_modules/@openai/codex/bin/codex.js", "login", "--device-auth"],
        home_subdir: ".codex",
        credential_file: "auth.json",
        hint: "Open the device-auth URL and enter the code shown.",
      },
      credential_mode: "cli_profile",
      credential_runtime_name: "codex_cli",
      default_target_path: "/home/agent/.codex",
      supports_oauth_login_state: true,
    },
    sandbox: worktreeCli,
    model: {
      model_provider_mode: "none",
      supports_model_override: false,
      model_config_behavior: "not_applicable",
      provider_api: "openai_compatible",
    },
    permissions: { supports_permission_bypass: false },
    usage: {
      usage_accuracy: "precise",
      supports_usage_probe: false,
    },
    output: {
      patch_strategy: "git_diff",
      artifact_path_strategy: "none",
    },
    limits: { default_timeout_seconds: 300, max_timeout_seconds: 3600 },
  },
  opencode: {
    adapter_type: "opencode",
    display_name: "OpenCode",
    runtime_kind: "local_cli",
    executor_family: "local_cli",
    implementation_status: "implemented",
    enabled_by_default: false,
    subagent_support: "runtime_internal",
    subagent_disable_mechanism: "runtime_config",
    delegation_controllability: "runtime_config",
    structured_output: "native_event_stream",
    checkpoint_resume: "runtime_session",
    cancellation_reliability: "best_effort",
    observability_level: "structured",
    side_effect_level: "workspace",
    data_exposure: "provider",
    baseline_trust_level: "low",
    subagent_disable_config: {
      relative_path: "opencode.json",
      deny_path: ["agent", "rainver-locked", "permission", "task"],
      denied_value: { "*": "deny" },
      required_values: [
        { path: ["default_agent"], value: "rainver-locked", value_mode: "exact" },
        { path: ["subagent_depth"], value: 0, value_mode: "exact" },
        { path: ["agent", "rainver-locked", "mode"], value: "primary", value_mode: "exact" },
        { path: ["agent", "rainver-locked", "permission", "edit"], value: { "*": "allow" } },
        { path: ["agent", "rainver-locked", "permission", "bash"], value: { "*": "allow" } },
        { path: ["agent", "rainver-locked", "permission", "webfetch"], value: "deny", value_mode: "exact" },
      ],
    },
    executable: { command: "opencode", allow_path_override: true },
    distribution: { registry_id: "opencode" },
    invocation: {
      headless_command_template: [
        "{executable}",
        "acp",
        "--cwd",
        "{sandbox_cwd}",
      ],
      protocol: "acp",
    },
    credentials: {
      login: {
        command: ["opencode", "auth", "login"],
        managed_command: ["{tree}/opencode", "auth", "login"],
        home_subdir: ".local/share/opencode",
        credential_file: "auth.json",
        hint: "Follow the prompts to complete login.",
      },
      credential_mode: "cli_profile_or_model_provider",
      credential_runtime_name: "opencode",
      default_target_path: "/home/agent/.local/share/opencode",
      supports_oauth_login_state: true,
    },
    sandbox: worktreeCli,
    model: {
      model_provider_mode: "none",
      supports_model_override: true,
      model_arg_template: ["--model", "{model}"],
      model_config_behavior: "uses_model",
      provider_api: "openai_compatible",
    },
    permissions: { supports_permission_bypass: false },
    usage: {
      usage_accuracy: "precise",
      supports_usage_probe: false,
    },
    output: {
      patch_strategy: "git_diff",
      artifact_path_strategy: "none",
    },
    limits: { default_timeout_seconds: 300, max_timeout_seconds: 3600 },
  },
  gemini_cli: {
    adapter_type: "gemini_cli",
    display_name: "Gemini CLI",
    runtime_kind: "local_cli",
    executor_family: "local_cli",
    implementation_status: "planned",
    enabled_by_default: false,
    subagent_support: "unknown",
    subagent_disable_mechanism: "unsupported",
    delegation_controllability: "unknown",
    structured_output: "unknown",
    checkpoint_resume: "none",
    cancellation_reliability: "unknown",
    observability_level: "opaque",
    side_effect_level: "workspace",
    data_exposure: "provider",
    baseline_trust_level: "low",
    executable: { command: "gemini", allow_path_override: true },
    invocation: {
      headless_command_template: [],
    },
    credentials: {
      credential_mode: "cli_profile",
      credential_runtime_name: "gemini_cli",
    },
    sandbox: worktreeCli,
    model: {
      model_provider_mode: "none",
      supports_model_override: false,
      model_config_behavior: "not_applicable",
    },
    permissions: { supports_permission_bypass: false },
    usage: {
      usage_accuracy: "unknown",
      supports_usage_probe: false,
    },
    output: {
      patch_strategy: "git_diff",
      artifact_path_strategy: "none",
    },
    limits: { default_timeout_seconds: 300, max_timeout_seconds: 3600 },
  },
  custom: {
    adapter_type: "custom",
    display_name: "Custom Runtime Adapter",
    runtime_kind: "custom",
    executor_family: "custom",
    implementation_status: "planned",
    enabled_by_default: false,
    subagent_support: "unknown",
    subagent_disable_mechanism: "unknown",
    delegation_controllability: "unknown",
    structured_output: "unknown",
    checkpoint_resume: "unknown",
    cancellation_reliability: "unknown",
    observability_level: "opaque",
    side_effect_level: "external",
    data_exposure: "unknown",
    baseline_trust_level: "low",
    credentials: { credential_mode: "none" },
    sandbox: {
      requires_file_access: true,
      minimum_sandbox_level: "worktree",
      supports_worktree: true,
      supports_one_shot_docker: false,
      requires_workspace_for_execution: true,
    },
    model: {
      model_provider_mode: "optional",
      supports_model_override: false,
      model_config_behavior: "unsupported",
    },
    permissions: { supports_permission_bypass: false },
    usage: {
      usage_accuracy: "unknown",
      supports_usage_probe: false,
    },
    output: {
      patch_strategy: "git_diff",
      artifact_path_strategy: "none",
    },
    limits: { default_timeout_seconds: 300, max_timeout_seconds: 3600 },
  },
};

export function listRuntimeAdapterSpecs(): RuntimeAdapterSpec[] {
  return [...Object.values(BUILTIN_RUNTIME_ADAPTER_SPECS), ...listDynamicRuntimeAdapterSpecs()];
}

export function getRuntimeAdapterSpec(adapterType: string | null | undefined): RuntimeAdapterSpec | null {
  if (!adapterType) return null;
  return BUILTIN_RUNTIME_ADAPTER_SPECS[adapterType as RuntimeAdapterType] ?? getDynamicRuntimeAdapterSpec(adapterType);
}

export function isImplementedRuntimeAdapter(adapterType: string | null | undefined): boolean {
  return getRuntimeAdapterSpec(adapterType)?.implementation_status === "implemented";
}

export function isLocalCliRuntimeAdapter(adapterType: string | null | undefined): boolean {
  return getRuntimeAdapterSpec(adapterType)?.runtime_kind === "local_cli";
}

export function getLocalCliRuntimeAdapterSpec(
  adapterType: string | null | undefined,
): LocalCliRuntimeAdapterSpec | null {
  const spec = getRuntimeAdapterSpec(adapterType);
  if (!spec || spec.runtime_kind !== "local_cli") return null;
  return spec as LocalCliRuntimeAdapterSpec;
}

export function isVendorCliAdapter(adapterType: string | null | undefined): adapterType is VendorCliAdapterType {
  const spec = getRuntimeAdapterSpec(adapterType);
  return spec?.runtime_kind === "local_cli" && spec.implementation_status === "implemented";
}

/** A vendor CLI driven over the Agent Client Protocol — what a remote host can run. */
export function isAcpRuntimeAdapter(adapterType: string | null | undefined): adapterType is VendorCliAdapterType {
  return isVendorCliAdapter(adapterType) && getLocalCliRuntimeAdapterSpec(adapterType)?.invocation.protocol === "acp";
}
