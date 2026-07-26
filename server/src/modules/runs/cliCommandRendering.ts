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
  },
): Promise<RenderedCliCommand> {
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
  applyReadOnlyVendorSandbox(spec, argv, input.required_sandbox_level);
  applyReadOnlyVendorSandbox(spec, redacted, input.required_sandbox_level);

  const extraArgs: string[] = [];
  if (input.model && spec.invocation.argument_rendering_strategy !== "ndjson_rpc") {
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

  const stdin = spec.invocation.argument_rendering_strategy === "stdin" ? input.prompt : null;
  return {
    argv: stdin === null ? argv : argv.filter((arg) => arg !== input.prompt),
    redacted_argv: stdin === null ? redacted : redacted.filter((arg) => arg !== "[REDACTED_PROMPT]"),
    stdin,
    permission_bypass_used:
      input.permission_bypass &&
      (spec.permissions.permission_bypass_arg_template ?? []).every((arg) => argv.includes(arg)),
  };
}

function applyReadOnlyVendorSandbox(
  spec: LocalCliRuntimeAdapterSpec,
  argv: string[],
  sandboxLevel: string | null | undefined,
): void {
  if (spec.adapter_type !== "codex_cli" || sandboxLevel !== "read_only") return;
  const sandboxIndex = argv.indexOf("--sandbox");
  // Codex app-server carries the sandbox mode in thread/start rather than
  // process argv. Legacy direct-exec templates still use this flag.
  if (sandboxIndex < 0 || sandboxIndex + 1 >= argv.length) return;
  argv[sandboxIndex + 1] = "read-only";
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
