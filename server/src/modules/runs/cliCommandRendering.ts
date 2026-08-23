import {
  assertRuntimeSubagentsDisabled,
  RuntimeSubagentConfigError,
  type LocalCliRuntimeAdapterSpec,
} from "../runtimeAdapters";

export interface RenderedCliCommand {
  argv: string[];
  redacted_argv: string[];
  stdin: string | null;
  permission_bypass_used: boolean;
}

export class CliRenderError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CliRenderError";
  }
}

export async function renderCliCommand(
  spec: LocalCliRuntimeAdapterSpec,
  input: {
    executable: string;
    prompt: string;
    mode: string;
    model: string | null;
    permission_bypass: boolean;
    runtime_policy_json?: Record<string, unknown>;
    risk_level: string;
    project_folder_id: string | null;
    sandbox_cwd: string | null;
    context_cwd?: string | null;
    resume_session_id?: string | null;
    required_sandbox_level?: string | null;
    /**
     * ADR 0016 P3: a remote execution host has no server-local sandbox path
     * for this check to inspect — the deny-config it verifies would have to
     * live in the daemon's actual workspace, not a path the server can see
     * or write to. Writing a compliant-looking file server-side and passing
     * its path here would prove nothing about what the remote CLI process
     * actually honors (security theater), so remote callers explicitly opt
     * out instead. Defaults to false, preserving today's behavior for every
     * existing (server-host) caller.
     */
    skip_subagent_disable_check?: boolean;
  },
): Promise<RenderedCliCommand> {
  if (!input.skip_subagent_disable_check) {
    try {
      await assertRuntimeSubagentsDisabled(spec, input.context_cwd ?? input.sandbox_cwd);
    } catch (error) {
      throw new CliRenderError(
        "runtime_subagents_not_disabled",
        error instanceof RuntimeSubagentConfigError
          ? error.message
          : "Runtime subagent disablement could not be verified.",
      );
    }
  }
  const template = input.resume_session_id && spec.invocation.resume_command_template
    ? spec.invocation.resume_command_template
    : input.mode === "interactive" && spec.invocation.interactive_command_template
      ? spec.invocation.interactive_command_template
      : spec.invocation.headless_command_template;
  const values = {
    executable: input.executable,
    prompt: input.prompt,
    sandbox_cwd: input.sandbox_cwd ?? "",
    resume_session_id: input.resume_session_id ?? "",
  };
  const argv = renderTemplate(template, values);
  const redacted = renderTemplate(template, { ...values, prompt: "[REDACTED_PROMPT]" });

  const extraArgs: string[] = [];
  // Model selection for an ACP adapter happens over the protocol
  // (`session/set_config_option`), never via a CLI arg — equivalent to the
  // former `argument_rendering_strategy !== "ndjson_rpc"` check (deleted:
  // execution-topology-and-project-control-plane-plan.md P0.6 — every
  // current adapter's `ndjson_rpc` rendering strategy coincided exactly
  // with `protocol: "acp"`, so the field only ever restated this).
  if (input.model && spec.invocation.protocol !== "acp") {
    if (!spec.model.supports_model_override || !spec.model.model_arg_template) {
      throw new CliRenderError("model_override_not_supported", `adapter_type '${spec.adapter_type}' does not support model override`);
    }
    extraArgs.push(...renderTemplate(spec.model.model_arg_template, { model: input.model }));
  }

  if (input.permission_bypass) {
    const permissionError = permissionBypassError(spec, input);
    if (permissionError) {
      throw new CliRenderError("permission_bypass_not_allowed", permissionError);
    }
    extraArgs.push(...(spec.permissions.permission_bypass_arg_template ?? []));
  }

  if (extraArgs.length > 0) {
    const insertAt = argv.findIndex((arg) => arg === input.prompt);
    argv.splice(insertAt >= 0 ? insertAt : argv.length, 0, ...extraArgs);
    const redactedInsertAt = redacted.findIndex((arg) => arg === "[REDACTED_PROMPT]");
    redacted.splice(redactedInsertAt >= 0 ? redactedInsertAt : redacted.length, 0, ...extraArgs);
  }

  // No current adapter ever set `argument_rendering_strategy: "stdin"` (the
  // deleted field's third value) — the prompt always stays an argv token.
  return {
    argv,
    redacted_argv: redacted,
    stdin: null,
    permission_bypass_used:
      input.permission_bypass &&
      (spec.permissions.permission_bypass_arg_template ?? []).every((arg) => argv.includes(arg)),
  };
}

function renderTemplate(template: string[], values: Record<string, string>): string[] {
  return template.map((part) =>
    part.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_match, name: string) => {
      const value = values[name];
      if (value === undefined) {
        throw new CliRenderError("unknown_template_variable", `unknown command template variable: ${name}`);
      }
      return value;
    }),
  );
}

function permissionBypassError(
  spec: LocalCliRuntimeAdapterSpec,
  input: {
    runtime_policy_json?: Record<string, unknown>;
    risk_level: string;
    project_folder_id: string | null;
    sandbox_cwd: string | null;
  },
): string | null {
  if (!spec.permissions.supports_permission_bypass) {
    return `Runtime adapter '${spec.adapter_type}' does not support permission bypass.`;
  }
  const key = spec.permissions.permission_bypass_policy_key ?? "allow_permission_bypass";
  if (input.runtime_policy_json?.[key] !== true) {
    return `runtime_policy_json.${key}=true is required for permission bypass.`;
  }
  if (!["high", "critical"].includes(input.risk_level)) {
    return "Permission bypass requires risk_level high or critical.";
  }
  if (!input.project_folder_id || !input.sandbox_cwd) {
    return "Permission bypass requires an existing worktree workspace.";
  }
  return null;
}
