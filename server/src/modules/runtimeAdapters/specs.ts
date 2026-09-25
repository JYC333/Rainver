import { getDynamicRuntimeAdapterSpec, listDynamicRuntimeAdapterSpecs } from "./dynamicSpecs.js";

export type RuntimeKey =
  | "capability"
  | "claude_code"
  | "codex_cli"
  | "opencode"
  | "gemini_cli"
  | "custom";

/**
 * The implemented vendor CLIs. The one closed list: every per-vendor table
 * (`Record<VendorCliRuntimeKey, …>`) keys on it so the compiler names each
 * place a new CLI needs a decision, instead of a literal check silently
 * treating it as "not a CLI". Membership *checks* go through
 * `isVendorCliAdapter` / `isAcpRuntimeAdapter`, which read the spec.
 */
export type VendorCliRuntimeKey = Extract<RuntimeKey, "claude_code" | "codex_cli" | "opencode">;

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
 * How a runtime is logged into, and how a login is recognised. The adapter
 * spec is the only source; the daemon's login terminal applies it and adds
 * nothing. `command` is the vendor CLI as it is named on PATH (an `own`
 * installation); `managed_command` addresses the same CLI inside a managed
 * tree, with `{tree}` the install directory, `{node}` this daemon's node,
 * `{platform}` the registry platform key (`linux-x86_64`), and
 * `{node_platform}` node's own `<platform>-<arch>` (`linux-x64`).
 */
export interface RuntimeLoginSpec {
  command: string[];
  managed_command?: string[];
  /** The vendor's logout in the same two forms; absent when the CLI has none. */
  logout_command?: string[];
  managed_logout_command?: string[];
  home_subdir: string;
  credential_file: string;
  /** Declared for a CLI that holds several accounts in its credential file (see the protocol schema). */
  accounts_format?: "json_object_by_provider";
  hint?: string;
}

export type RuntimeKind = "native" | "local_cli" | "custom";
export type RuntimeExecutorFamily = "native" | "local_cli" | "custom";
export type ImplementationStatus = "implemented" | "planned" | "disabled";
export type CredentialMode = "none" | "cli_profile" | "cli_profile_or_model_provider";
export type CredentialReleaseChannel = "server_runtime_host";
type RuntimeConfigValue = string | number | boolean | Record<string, string>;

export interface RuntimeAdapterSpec {
  /** A builtin type, or a dynamic adapter's own id (`acp_<registry id>`). */
  runtime_key: RuntimeKey | (string & {});
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
  /** Fixed argv inside a managed tree that prints the bundled vendor CLI version. */
  managed_runtime_version_command?: string[];
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
  /**
   * ACP session options to force when this runtime executes on a **strict**
   * host, where the daemon's bubblewrap namespace is already the boundary
   * (ADR 0016 section 2). A vendor sandbox nested there does not fail — it
   * stacks its own policy over the Run's own workspace, so a Run runs and
   * silently cannot write. Only strict: on a paired machine the owner's
   * approval settings are theirs, and overriding them would be exactly the
   * relaxation B62 forbids.
   */
  strict_session_config?: ReadonlyArray<{
    id: string;
    type: "select" | "boolean";
    value: string | boolean;
    category: string | null;
  }>;
  model: {
    supports_model_override: boolean;
    model_arg_template?: string[];
    model_config_behavior: "uses_model" | "not_applicable" | "unsupported";
    /**
     * Which ModelProvider endpoint a CLI can be pointed at — the
     * `<provider_api>_base_url` a binding needs. Only meaningful for vendor
     * CLIs that accept a provider. `vendor` means the CLI speaks either
     * protocol and the binding follows the bound ModelProvider's own vendor
     * protocol (`providers/vendors.ts`); `runs/adapterProviderRequirement.ts`
     * resolves it per provider.
     */
    provider_api?: "claude_compatible" | "openai_compatible" | "vendor";
  };
  permissions: {
    supports_permission_bypass: boolean;
    permission_bypass_arg_template?: string[];
    permission_bypass_policy_key?: string;
  };
  /**
   * How this runtime asks the person a question of its own mid-turn
   * (`modules/runtime-adapters.md`). Rainver has nobody to answer during a
   * Run, so the ACP controller translates such a question into the turn's
   * reply (`runs/vendorQuestion.ts`) instead of approving or failing it. A
   * runtime without a declaration keeps the generic rule: any interactive
   * request that is not a tool permission is a question.
   */
  interaction?: {
    question_detector: {
      /**
       * The runtime's question tool is offered only to a client that
       * advertises ACP form elicitation (`elicitation/create`), so the
       * controller advertises it for this runtime. Claude Code disables
       * AskUserQuestion otherwise; Codex answers request_user_input with
       * nothing and carries on.
       */
      form_elicitation?: {
        /**
         * Which field of a one-question form carries the question text:
         * Claude puts it in the request's `message` (the field's title is a
         * short header); Codex puts it in the field's `title`.
         */
        question_text: "message" | "field_title";
      };
      /** A `session/request_permission` that names no tool call is a question, not a tool permission. */
      permission_without_tool_call?: boolean;
    };
  };
  usage: {
    usage_accuracy: "precise" | "estimated" | "unknown";
    supports_usage_probe: boolean;
    usage_probe_kind?: string;
    /**
     * How this runtime says it refused because the subscription's window is
     * used up: case-insensitive regular expressions over a failed Run's error
     * text. A match is classified `subscription_quota_exhausted`
     * (`runs/retryPolicy.ts`) — not retried, and a discussion stops at it as
     * at a cap (`modules/rooms.md`, "Quota exhaustion is a cap").
     */
    quota_exhausted_patterns?: readonly string[];
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

export const BUILTIN_RUNTIME_ADAPTER_SPECS: Readonly<Record<RuntimeKey, RuntimeAdapterSpec>> = {
  capability: {
    runtime_key: "capability",
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
  claude_code: {
    runtime_key: "claude_code",
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
    managed_runtime_version_command: ["{tree}/node_modules/@anthropic-ai/claude-agent-sdk-{node_platform}/claude", "--version"],
    invocation: {
      headless_command_template: ["{executable}"],
      resume_command_template: ["{executable}"],
      protocol: "acp",
      remote_capability_probe: "claude",
    },
    credentials: {
      login: {
        command: ["claude", "/login"],
        logout_command: ["claude", "/logout"],
        // The bundled SDK ships the vendor binary per platform.
        managed_command: ["{tree}/node_modules/@anthropic-ai/claude-agent-sdk-{node_platform}/claude", "/login"],
        managed_logout_command: ["{tree}/node_modules/@anthropic-ai/claude-agent-sdk-{node_platform}/claude", "/logout"],
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
    // claude-agent-acp 0.70 (read 2026-09-24): AskUserQuestion becomes a form
    // elicitation — one question in `message`, several as `question_<n>`
    // fields with the question in `description`.
    interaction: {
      question_detector: {
        form_elicitation: { question_text: "message" },
        permission_without_tool_call: true,
      },
    },
    usage: {
      usage_accuracy: "precise",
      supports_usage_probe: false,
      usage_probe_kind: "cached_claude_quota",
      // "Claude AI usage limit reached|<epoch>", "5-hour limit reached ∙
      // resets 3pm", "You've hit your limit · resets 3pm".
      quota_exhausted_patterns: [
        "usage limit reached",
        // Not the Opus limit: that one falls back to another model, it does not refuse.
        "(5-hour|five-hour|weekly) limit reached",
        "you['’]ve hit your (usage )?limit",
      ],
    },
    output: {
      patch_strategy: "git_diff",
      artifact_path_strategy: "none",
    },
    limits: { default_timeout_seconds: 300, max_timeout_seconds: 3600 },
  },
  codex_cli: {
    runtime_key: "codex_cli",
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
    managed_runtime_version_command: ["{node}", "{tree}/node_modules/@openai/codex/bin/codex.js", "--version"],
    invocation: {
      headless_command_template: ["{executable}"],
      protocol: "acp",
      remote_capability_probe: "codex",
    },
    credentials: {
      login: {
        command: ["codex", "login", "--device-auth"],
        managed_command: ["{node}", "{tree}/node_modules/@openai/codex/bin/codex.js", "login", "--device-auth"],
        logout_command: ["codex", "logout"],
        managed_logout_command: ["{node}", "{tree}/node_modules/@openai/codex/bin/codex.js", "logout"],
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
    // Codex's `mode` defaults to `agent`, which keeps its own sandbox and
    // approval gate. Inside the strict namespace that gate has nothing left to
    // protect and its policy makes the Run's own workspace read-only, so the
    // one boundary is ours. Verified on the built-in host 2026-09-08.
    strict_session_config: [{ id: "mode", type: "select", value: "agent-full-access", category: "mode" }],
    model: {
      supports_model_override: false,
      model_config_behavior: "not_applicable",
      provider_api: "openai_compatible",
    },
    permissions: { supports_permission_bypass: false },
    // codex-acp 1.12 (read 2026-09-24): request_user_input becomes a form
    // elicitation whose generic `message` is "Codex needs your input to
    // continue."; each question is a field whose `title` is the question.
    interaction: {
      question_detector: {
        form_elicitation: { question_text: "field_title" },
      },
    },
    usage: {
      usage_accuracy: "precise",
      supports_usage_probe: false,
      // `usage_limit_reached`; "You've hit your usage limit. … try again in 2 hours".
      quota_exhausted_patterns: [
        "usage_limit_reached",
        "you['’]ve (hit|reached) your usage limit",
      ],
    },
    output: {
      patch_strategy: "git_diff",
      artifact_path_strategy: "none",
    },
    limits: { default_timeout_seconds: 300, max_timeout_seconds: 3600 },
  },
  opencode: {
    runtime_key: "opencode",
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
        // `auth logout` is a picker over the stored providers: removing one
        // account of several, which is what a multi-account CLI needs.
        logout_command: ["opencode", "auth", "logout"],
        managed_logout_command: ["{tree}/opencode", "auth", "logout"],
        accounts_format: "json_object_by_provider",
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
      supports_model_override: true,
      model_arg_template: ["--model", "{model}"],
      model_config_behavior: "uses_model",
      // OpenCode loads an AI SDK package per provider, so it can register an
      // Anthropic-protocol vendor as `@ai-sdk/anthropic` and keep that
      // vendor's prompt caching rather than forcing it through an
      // OpenAI-compatible bridge.
      provider_api: "vendor",
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
    runtime_key: "gemini_cli",
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
    runtime_key: "custom",
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

export function getRuntimeAdapterSpec(runtimeKey: string | null | undefined): RuntimeAdapterSpec | null {
  if (!runtimeKey) return null;
  return BUILTIN_RUNTIME_ADAPTER_SPECS[runtimeKey as RuntimeKey] ?? getDynamicRuntimeAdapterSpec(runtimeKey);
}

export function isImplementedRuntimeAdapter(runtimeKey: string | null | undefined): boolean {
  return getRuntimeAdapterSpec(runtimeKey)?.implementation_status === "implemented";
}

export function isLocalCliRuntimeAdapter(runtimeKey: string | null | undefined): boolean {
  return getRuntimeAdapterSpec(runtimeKey)?.runtime_kind === "local_cli";
}

export function getLocalCliRuntimeAdapterSpec(
  runtimeKey: string | null | undefined,
): LocalCliRuntimeAdapterSpec | null {
  const spec = getRuntimeAdapterSpec(runtimeKey);
  if (!spec || spec.runtime_kind !== "local_cli") return null;
  return spec as LocalCliRuntimeAdapterSpec;
}

export function isVendorCliAdapter(runtimeKey: string | null | undefined): runtimeKey is VendorCliRuntimeKey {
  const spec = getRuntimeAdapterSpec(runtimeKey);
  return spec?.runtime_kind === "local_cli" && spec.implementation_status === "implemented";
}

/** A vendor CLI driven over the Agent Client Protocol — what a remote host can run. */
export function isAcpRuntimeAdapter(runtimeKey: string | null | undefined): runtimeKey is VendorCliRuntimeKey {
  return isVendorCliAdapter(runtimeKey) && getLocalCliRuntimeAdapterSpec(runtimeKey)?.invocation.protocol === "acp";
}
