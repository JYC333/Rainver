export type RuntimeAdapterType =
  | "capability"
  | "model_api"
  | "ts_agent_host"
  | "claude_code"
  | "codex_cli"
  | "opencode"
  | "gemini_cli"
  | "custom";

export type RuntimeKind = "native" | "local_cli" | "managed_api" | "custom";
export type RuntimeExecutorFamily = "native" | "local_cli" | "managed_api" | "custom";
export type ImplementationStatus = "implemented" | "planned" | "disabled";
export type ContextFileType = "CLAUDE.md" | "AGENTS.md" | "prompt.md" | "custom";
export type CredentialMode = "none" | "cli_profile" | "cli_profile_or_model_provider" | "model_provider_api_key";
export type CredentialReleaseChannel = "server_runtime_host";
type RuntimeConfigValue = string | number | boolean | Record<string, string>;

export interface RuntimeAdapterSpec {
  adapter_type: RuntimeAdapterType;
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
    argument_rendering_strategy: "argv_template" | "stdin" | "ndjson_rpc";
    protocol?: "codex_app_server" | "acp";
  };
  context: {
    context_file_type: ContextFileType;
    context_target_format: string;
    writes_vendor_context_file: boolean;
  };
  credentials: {
    credential_mode: CredentialMode;
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
    usage_parser_type: string;
  };
  output: {
    output_parser_type: "plain_text" | "generic";
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
    argument_rendering_strategy: "argv_template" | "stdin" | "ndjson_rpc";
    protocol?: "codex_app_server" | "acp";
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
    context: {
      context_file_type: "custom",
      context_target_format: "generic",
      writes_vendor_context_file: false,
    },
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
      usage_parser_type: "generic",
    },
    output: {
      output_parser_type: "generic",
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
    context: {
      context_file_type: "custom",
      context_target_format: "generic",
      writes_vendor_context_file: false,
    },
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
      usage_parser_type: "generic",
    },
    output: {
      output_parser_type: "plain_text",
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
    context: {
      context_file_type: "custom",
      context_target_format: "host_request",
      writes_vendor_context_file: false,
    },
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
      usage_parser_type: "generic",
    },
    output: {
      output_parser_type: "plain_text",
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
    structured_output: "unknown",
    // Measured 2026-07-26: `--resume <session-id>` restored conversation state
    // in a separate process. Session ids are UUIDs, exposed in the
    // stream-json output.
    checkpoint_resume: "runtime_session",
    cancellation_reliability: "best_effort",
    observability_level: "opaque",
    side_effect_level: "workspace",
    data_exposure: "provider",
    baseline_trust_level: "low",
    executable: { command: "claude", allow_path_override: true },
    invocation: {
      headless_command_template: [
        "{executable}",
        "--print",
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--verbose",
        "{prompt}",
      ],
      resume_command_template: [
        "{executable}",
        "--print",
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--resume",
        "{resume_session_id}",
        "{prompt}",
      ],
      interactive_command_template: ["{executable}"],
      argument_rendering_strategy: "argv_template",
    },
    context: {
      context_file_type: "CLAUDE.md",
      context_target_format: "claude",
      writes_vendor_context_file: true,
    },
    credentials: {
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
    },
    permissions: {
      supports_permission_bypass: true,
      permission_bypass_arg_template: ["--dangerously-skip-permissions"],
      permission_bypass_policy_key: "allow_permission_bypass",
    },
    usage: {
      usage_accuracy: "precise",
      supports_usage_probe: false,
      usage_probe_kind: "cached_claude_quota",
      usage_parser_type: "generic",
    },
    output: {
      output_parser_type: "generic",
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
    // Codex app-server resumes an opaque thread id through `thread/resume`.
    // The server keeps the corresponding `.codex` state in the conversation's
    // isolated HOME and subtracts restored cumulative usage from the next turn.
    checkpoint_resume: "runtime_session",
    cancellation_reliability: "best_effort",
    observability_level: "opaque",
    side_effect_level: "workspace",
    data_exposure: "provider",
    baseline_trust_level: "low",
    executable: { command: "codex", allow_path_override: true },
    invocation: {
      headless_command_template: [
        "{executable}",
        "app-server",
        "--stdio",
      ],
      argument_rendering_strategy: "ndjson_rpc",
      protocol: "codex_app_server",
    },
    context: {
      context_file_type: "AGENTS.md",
      context_target_format: "codex_cli",
      writes_vendor_context_file: true,
    },
    credentials: {
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
    },
    permissions: { supports_permission_bypass: false },
    usage: {
      usage_accuracy: "precise",
      supports_usage_probe: false,
      usage_parser_type: "generic",
    },
    output: {
      output_parser_type: "generic",
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
      deny_path: ["agent", "agent-space-locked", "permission", "task"],
      denied_value: { "*": "deny" },
      required_values: [
        { path: ["default_agent"], value: "agent-space-locked", value_mode: "exact" },
        { path: ["subagent_depth"], value: 0, value_mode: "exact" },
        { path: ["agent", "agent-space-locked", "mode"], value: "primary", value_mode: "exact" },
        { path: ["agent", "agent-space-locked", "permission", "edit"], value: { "*": "allow" } },
        { path: ["agent", "agent-space-locked", "permission", "bash"], value: { "*": "allow" } },
        { path: ["agent", "agent-space-locked", "permission", "webfetch"], value: "deny", value_mode: "exact" },
      ],
    },
    executable: { command: "opencode", allow_path_override: true },
    invocation: {
      headless_command_template: [
        "{executable}",
        "acp",
        "--cwd",
        "{sandbox_cwd}",
      ],
      argument_rendering_strategy: "ndjson_rpc",
      protocol: "acp",
    },
    context: {
      context_file_type: "AGENTS.md",
      context_target_format: "generic",
      writes_vendor_context_file: false,
    },
    credentials: {
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
    },
    permissions: { supports_permission_bypass: false },
    usage: {
      usage_accuracy: "precise",
      supports_usage_probe: false,
      usage_parser_type: "generic",
    },
    output: {
      output_parser_type: "generic",
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
      argument_rendering_strategy: "argv_template",
    },
    context: {
      context_file_type: "AGENTS.md",
      context_target_format: "generic",
      writes_vendor_context_file: false,
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
      usage_parser_type: "generic",
    },
    output: {
      output_parser_type: "generic",
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
    context: {
      context_file_type: "custom",
      context_target_format: "custom",
      writes_vendor_context_file: false,
    },
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
      usage_parser_type: "generic",
    },
    output: {
      output_parser_type: "generic",
      patch_strategy: "git_diff",
      artifact_path_strategy: "none",
    },
    limits: { default_timeout_seconds: 300, max_timeout_seconds: 3600 },
  },
};

export function listRuntimeAdapterSpecs(): RuntimeAdapterSpec[] {
  return Object.values(BUILTIN_RUNTIME_ADAPTER_SPECS);
}

export function getRuntimeAdapterSpec(adapterType: string | null | undefined): RuntimeAdapterSpec | null {
  if (!adapterType) return null;
  return BUILTIN_RUNTIME_ADAPTER_SPECS[adapterType as RuntimeAdapterType] ?? null;
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

export function isVendorCliAdapter(adapterType: string | null | undefined): boolean {
  const spec = getRuntimeAdapterSpec(adapterType);
  return spec?.runtime_kind === "local_cli" && spec.implementation_status === "implemented";
}

export function targetFormatForAdapter(adapterType: string | null | undefined): string | null {
  return getRuntimeAdapterSpec(adapterType)?.context.context_target_format ?? null;
}
