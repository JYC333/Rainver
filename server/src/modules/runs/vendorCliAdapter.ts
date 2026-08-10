import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  RunAdapterResultEnvelope,
  RunInputEnvelope,
  RuntimeSemanticEvent,
  InvocationDelivery,
} from "@agent-space/protocol" with { "resolution-mode": "import" };
import type { ServerConfig } from "../../config";
import {
  CliCredentialBroker,
  type CredentialGrant,
} from "../providers/cli/credentialBroker";
import type { ProviderProxyLeaseRegistry } from "../providers/proxy/lease";
import {
  RuntimeToolError,
  RuntimeToolRegistry,
  type ResolvedRuntimeTool,
  type RuntimeToolResolverPort,
} from "../runtimeTools";
import {
  ensureRuntimeSubagentsDisabled,
  getLocalCliRuntimeAdapterSpec,
  type LocalCliRuntimeAdapterSpec,
} from "../runtimeAdapters";
import type { RunRecord } from "./repository";
import {
  redactEvidenceText,
  sanitizeEvidenceJson,
} from "./evidenceRedaction";
import {
  CliRenderError,
  renderCliCommand,
  type RenderedCliCommand,
} from "./cliCommandRendering";
import {
  type CliCommandExecutor,
  type CliExecutionResult,
  type CliProcessRegistry,
  type CliStdioController,
} from "./localCliExecution";
import { SandboxRunnerCliCommandExecutor } from "../sandboxRunner/client";
import {
  buildRuntimeProviderBinding,
  cleanupRuntimeProviderBinding,
  RuntimeProviderBindingError,
  type RuntimeProviderBinding,
  type RuntimeProviderResolverPort,
} from "./runtimeProviderBinding";
import {
  normalizeVendorEvents,
  terminalRuntimeEvents,
} from "./runtimeEventNormalization";
import { cliRunToolIdentities } from "./cliToolTransport";
import { buildSubprocessEnv } from "./cliSubprocessEnv";
import {
  envForNetworkProfile,
  resolveNetworkProfileRepository,
} from "../networkProfiles";
import { createCliConversationController } from "./cliConversationProtocol";
import {
  parseCliRuntimeMeasurement,
  type CliRuntimeMeasurement,
} from "./cliRuntimeMeasurement";
import { managedAdapterRequest } from "../runtimeContext";
import type { RunInvocationAttemptLifecycle } from "./runtimeContextAttempts";

export { buildSubprocessEnv } from "./cliSubprocessEnv";
export { renderCliCommand } from "./cliCommandRendering";
export {
  LocalCliProcessRegistry,
  type CliCommandExecutor,
  type CliExecutionResult,
  type CliProcessRegistry,
} from "./localCliExecution";

export type VendorCliAdapterType = "claude_code" | "codex_cli" | "opencode";
export type ExecutorMode = "worktree" | "docker";

export interface CliCredentialBrokerPort {
  grantForRun(
    runId: string,
    spaceId: string,
    runtime: string,
    executorMode: ExecutorMode,
    profileId?: string | null,
    options?: {
      conversation_state_key?: string | null;
      user_id?: string | null;
    },
  ): Promise<CredentialGrant>;
  prepareRunHome?(runId: string): Promise<string>;
  prepareConversationHome?(stateKey: string): Promise<string>;
  recordLiveQuota?(
    runtime: string,
    profileId: string,
    quota: NonNullable<CliRuntimeMeasurement["subscription_quota"]>,
  ): Promise<void>;
  cleanupRunHome?(runId: string): Promise<void>;
}

export interface VendorCliAdapterInput {
  run: RunRecord;
  run_input?: RunInputEnvelope;
  prompt?: string | null;
  mode?: string | null;
  model?: string | null;
  sandbox_cwd?: string | null;
  required_sandbox_level?: string | null;
  context_text?: string | null;
  adapter_config?: Record<string, unknown>;
  risk_level?: string | null;
  trigger_origin?: string | null;
  process_registry?: CliProcessRegistry;
  runtime_event_sink?: (event: RuntimeSemanticEvent) => Promise<void> | void;
  text_delta_sink?: (delta: string) => void;
  invocation_delivery?: InvocationDelivery;
  invocation_attempts?: RunInvocationAttemptLifecycle;
}

export interface VendorCliAdapterDeps {
  credentialBroker?: CliCredentialBrokerPort;
  executor?: CliCommandExecutor;
  toolRegistry?: RuntimeToolResolverPort;
  providerResolver?: RuntimeProviderResolverPort;
  providerLeaseRegistry?: ProviderProxyLeaseRegistry;
  providerProxyBaseUrl?: string;
}

const SECRET_COMMAND_KEYS = ["prompt", "context", "api_key", "token", "secret", "password"];

export async function executeVendorCliAdapter(
  config: ServerConfig,
  input: VendorCliAdapterInput,
  deps: VendorCliAdapterDeps = {},
): Promise<RunAdapterResultEnvelope> {
  let deliveryPrompts: string[] | null = null;
  if (input.invocation_delivery) {
    const accepted = await managedAdapterRequest(input.invocation_delivery);
    deliveryPrompts = renderCliDeliveryMessages(input.invocation_delivery);
    input.prompt = deliveryPrompts[0] ?? null;
    input.context_text = null;
    input.model = accepted.model;
    input.adapter_config = {
      ...(input.adapter_config ?? {}),
      ...(input.invocation_delivery.cli_session
        ? {
            conversation_runtime: {
              binding_id: input.invocation_delivery.cli_session.binding_ref.id,
              runtime_state_key: input.invocation_delivery.cli_session.runtime_state_key,
              runtime_session_id: input.invocation_delivery.cli_session.vendor_session_id,
              cli_known_cursor: input.invocation_delivery.cli_session.cursor_from,
              generation: input.invocation_delivery.cli_session.generation,
              rotation_reason: input.invocation_delivery.cli_session.rotation_reason,
            },
          }
        : {}),
    };
  }
  const startedAt = new Date().toISOString();
  const adapterType = input.run.adapter_type;
  const spec = getLocalCliRuntimeAdapterSpec(adapterType);
  if (!spec) {
    return cliFailure(input, "runtime_adapter_not_found", "Runtime adapter is not registered.", startedAt);
  }
  if (spec.implementation_status !== "implemented") {
    return cliFailure(input, "runtime_adapter_not_implemented", `Runtime adapter '${adapterType}' is not executable.`, startedAt, spec);
  }

  const sandboxError = validateSandbox(input, spec);
  if (sandboxError) {
    return cliFailure(input, sandboxError.code, sandboxError.message, startedAt, spec);
  }

  const credentialBroker = deps.credentialBroker ?? new CliCredentialBroker(config);
  const executorMode = executorModeFor(input);
  const toolGrants = input.run_input?.tool_grants ?? [];
  const credential = await grantCredential(input, spec, credentialBroker, executorMode);
  if (!credential.granted) {
    return cliFailure(
      input,
      "runtime_credential_profile_required",
      `Runtime adapter '${spec.adapter_type}' requires an explicit credential profile.`,
      startedAt,
      spec,
      { credential_profile_id: profileId(input), fallback_reason: credential.fallback_reason },
    );
  }

  try {
    await configureVendorSandbox(input, spec);
  } catch (error) {
    await cleanupCredential(input, credentialBroker);
    return cliFailure(
      input,
      "context_render_failed",
      error instanceof Error ? error.message : "CLI context rendering failed.",
      startedAt,
      spec,
    );
  }

  let tool: ResolvedRuntimeTool;
  try {
    const toolRegistry = deps.toolRegistry ?? new RuntimeToolRegistry(config);
    tool = await toolRegistry.resolveForExecution(
      spec.credentials.credential_runtime_name,
      stringValue(input.adapter_config?.runtime_tool_version),
    );
  } catch (error) {
    await cleanupCredential(input, credentialBroker);
    return cliFailure(
      input,
      error instanceof RuntimeToolError ? error.code : "cli_tool_unavailable",
      error instanceof Error ? error.message : `Runtime tool '${spec.credentials.credential_runtime_name}' is unavailable.`,
      startedAt,
      spec,
    );
  }

  const timeout = timeoutSeconds(input.adapter_config, spec, input.run);
  let runtimeBinding: RuntimeProviderBinding;
  try {
    runtimeBinding = await buildRuntimeProviderBinding(
      config,
      {
        run: input.run,
        model: input.model ?? null,
        sandbox_cwd: input.sandbox_cwd ?? null,
        invocation_audit_refs: input.invocation_delivery?.audit_refs ?? null,
      },
      spec,
      {
        credential,
        providerResolver: deps.providerResolver,
        leaseRegistry: deps.providerLeaseRegistry,
        proxyBaseUrl: deps.providerProxyBaseUrl,
        ttlSeconds: timeout + 300,
      },
    );
  } catch (error) {
    await cleanupCredential(input, credentialBroker);
    return cliFailure(
      input,
      error instanceof RuntimeProviderBindingError ? error.code : "cli_runtime_provider_config_failed",
      error instanceof Error ? error.message : "CLI runtime provider configuration failed.",
      startedAt,
      spec,
    );
  }

  const conversationRuntime = recordValue(input.adapter_config?.conversation_runtime);
  const runtimeSessionId = stringValue(conversationRuntime.runtime_session_id);
  let rendered: RenderedCliCommand;
  try {
    rendered = await renderCliCommand(spec, {
      executable: tool.executable_path,
      prompt: input.prompt ?? input.run.prompt ?? "",
      mode: input.mode ?? input.run.mode,
      // Codex receives the selected model through its run-scoped provider
      // config; it intentionally has no CLI model override flag.
      model: spec.adapter_type === "codex_cli" ? null : runtimeBinding.model ?? input.model ?? null,
      permission_bypass: Boolean(input.adapter_config?.permission_bypass),
      runtime_policy_json: recordValue(input.adapter_config?.runtime_policy_json),
      risk_level: input.risk_level ?? "low",
      project_folder_id: input.run.project_folder_id,
      sandbox_cwd: input.sandbox_cwd ?? null,
      context_cwd: vendorContextCwd(input),
      resume_session_id: runtimeSessionId,
      required_sandbox_level:
        input.required_sandbox_level ?? input.run.required_sandbox_level,
    });
  } catch (error) {
    await cleanupRuntimeProviderBinding(runtimeBinding);
    await cleanupCredential(input, credentialBroker);
    return cliFailure(
      input,
      error instanceof CliRenderError ? error.code : "cli_command_render_failed",
      error instanceof Error ? error.message : "CLI command render failed.",
      startedAt,
      spec,
    );
  }

  const toolToken = toolGrants.length > 0
    ? cliRunToolIdentities.issue(input.run, (timeout + 300) * 1000)
    : null;
  const toolUrl = toolToken
    ? `http://${config.sandboxRunnerServerHost}:${config.port}/internal/runs/${encodeURIComponent(input.run.id)}/mcp`
    : null;
  if (toolToken && toolUrl) {
    try {
      await configureCliToolTransport(spec, input, rendered, runtimeBinding, toolUrl, toolToken);
    } catch (error) {
      cliRunToolIdentities.revoke(toolToken);
      await cleanupRuntimeProviderBinding(runtimeBinding);
      await cleanupCredential(input, credentialBroker);
      return cliFailure(
        input,
        "cli_tool_transport_config_failed",
        error instanceof Error ? error.message : "CLI tool transport configuration failed.",
        startedAt,
        spec,
      );
    }
  }

  const sandboxLevel = input.required_sandbox_level ?? input.run.required_sandbox_level;
  const executor = deps.executor ?? new SandboxRunnerCliCommandExecutor(
    config,
    spec.adapter_type as VendorCliAdapterType,
  );
  let result: CliExecutionResult;
  let stream = spec.invocation.protocol
    ? null
    : createVendorEventStream(spec.adapter_type as VendorCliAdapterType);
  let textStream = spec.invocation.protocol
    ? null
    : createVendorTextDeltaStream(spec.adapter_type as VendorCliAdapterType);
  const pendingEvents: Promise<void>[] = [];
  let captureOutput = Boolean(spec.invocation.protocol || (deliveryPrompts?.length ?? 1) === 1);
  const emitTextDelta = (delta: string) => {
    if (!captureOutput) return;
    input.text_delta_sink?.(delta);
  };
  const emitProtocolEvent = (message: Record<string, unknown>) => {
    if (!captureOutput || !input.runtime_event_sink) return;
    for (const event of normalizeVendorEvents(
      spec.adapter_type,
      [message],
      new Date().toISOString(),
    )) {
      pendingEvents.push(Promise.resolve(input.runtime_event_sink(event)));
    }
  };
  const stdioController = spec.invocation.protocol
    ? createCliConversationController({
        adapter_type: spec.adapter_type as VendorCliAdapterType,
        prompts: deliveryPrompts ?? [input.prompt ?? input.run.prompt ?? ""],
        cwd: input.sandbox_cwd!,
        model: runtimeBinding.model ?? input.model ?? null,
        sandbox_mode: sandboxLevel === "read_only" ? "read-only" : "workspace-write",
        runtime_session_id: runtimeSessionId,
        before_next_prompt: input.invocation_delivery && input.invocation_attempts?.acknowledgeContext
          ? (sessionId) => input.invocation_attempts!.acknowledgeContext!(input.invocation_delivery!, sessionId)
          : undefined,
        on_text_delta: emitTextDelta,
        on_protocol_event: emitProtocolEvent,
      })
    : undefined;
  try {
    const cliNetworkEnv = await cliDefaultNetworkEnv(config, input.run.space_id, credential, runtimeBinding);
    const exchangeEnv = runExchangeEnv(input.adapter_config);
    const runRendered = (command: RenderedCliCommand, controller?: CliStdioController) => executor.runCommand({
      command: command.argv,
      cwd: input.sandbox_cwd ?? null,
      timeout_seconds: timeout,
      stall_timeout_seconds: stallTimeoutSeconds(input.adapter_config, timeout),
      env: buildSubprocessEnv(credential.env, {
        ...runtimeBinding.env,
        ...cliNetworkEnv,
        ...exchangeEnv,
        ...(toolToken && toolUrl
          ? { AGENT_SPACE_MCP_URL: toolUrl, AGENT_SPACE_TOOL_TOKEN: toolToken }
          : {}),
      }),
      run_id: input.run.id,
      scope_id: stringValue(
        recordValue(input.adapter_config?.conversation_runtime).runtime_state_key,
      ) ?? input.run.id,
      stdin: command.stdin,
      process_registry: input.process_registry,
      on_stdout_chunk: (chunk) => {
        for (const delta of textStream?.push(chunk) ?? []) emitTextDelta(delta);
        for (const event of stream?.push(chunk) ?? []) {
          if (captureOutput && input.runtime_event_sink) {
            pendingEvents.push(Promise.resolve(input.runtime_event_sink(event)));
          }
        }
      },
      stdio_controller: controller,
      egress_profile: runnerEgressProfile(
        Boolean(credential.profile_id || runtimeBinding.provider_id || credential.network_profile_id),
        Boolean(toolToken),
      ),
      read_only: sandboxLevel === "read_only"
        ? readOnlyExecutionOptions(
            config,
            input,
            credential,
            stringValue(input.adapter_config?.run_exchange_input_dir),
            stringValue(input.adapter_config?.run_exchange_output_dir),
          )
        : undefined,
    });
    result = await runRendered(rendered, stdioController);
    if (!spec.invocation.protocol && deliveryPrompts && deliveryPrompts.length > 1
      && result.returncode === 0 && !result.timed_out) {
      const firstMeasurement = parseCliRuntimeMeasurement(
        spec.adapter_type as VendorCliAdapterType,
        result.stdout,
      );
      const nextSessionId = firstMeasurement.external_session_id;
      if (!nextSessionId) {
        result = {
          ...result,
          returncode: 1,
          stderr: `${result.stderr}\nVendor CLI did not return a session id for the context phase.`.trim(),
        };
      } else {
        if (input.invocation_delivery && input.invocation_attempts?.acknowledgeContext) {
          await input.invocation_attempts.acknowledgeContext(input.invocation_delivery, nextSessionId);
        }
        rendered = await renderCliCommand(spec, {
          executable: tool.executable_path,
          prompt: deliveryPrompts.at(-1)!,
          mode: input.mode ?? input.run.mode,
          model: spec.adapter_type === "codex_cli" ? null : runtimeBinding.model ?? input.model ?? null,
          permission_bypass: Boolean(input.adapter_config?.permission_bypass),
          runtime_policy_json: recordValue(input.adapter_config?.runtime_policy_json),
          risk_level: input.risk_level ?? "low",
          project_folder_id: input.run.project_folder_id,
          sandbox_cwd: input.sandbox_cwd ?? null,
          context_cwd: vendorContextCwd(input),
          resume_session_id: nextSessionId,
          required_sandbox_level: sandboxLevel,
        });
        if (toolToken && toolUrl) {
          await configureCliToolTransport(spec, input, rendered, runtimeBinding, toolUrl, toolToken);
        }
        // The context process is a separate ordinary vendor turn. Discard its
        // complete and partial parser state before current-turn capture starts;
        // otherwise an unterminated bootstrap JSONL record can be completed by
        // the next process and be misattributed to the user turn.
        stream?.finish();
        textStream?.finish();
        stream = createVendorEventStream(spec.adapter_type as VendorCliAdapterType);
        textStream = createVendorTextDeltaStream(spec.adapter_type as VendorCliAdapterType);
        captureOutput = true;
        result = await runRendered(rendered);
      }
    }
  } finally {
    if (toolToken) cliRunToolIdentities.revoke(toolToken);
    await cleanupRuntimeProviderBinding(runtimeBinding);
    await cleanupCredential(input, credentialBroker);
  }
  for (const event of stream?.finish() ?? []) {
    if (captureOutput && input.runtime_event_sink) {
      pendingEvents.push(Promise.resolve(input.runtime_event_sink(event)));
    }
  }
  for (const delta of textStream?.finish() ?? []) emitTextDelta(delta);
  await Promise.allSettled(pendingEvents);

  const protocolResult = spec.invocation.protocol ? stdioController?.result() ?? null : null;
  const measurement: CliRuntimeMeasurement = protocolResult
      ? {
        external_session_id: protocolResult.external_session_id ?? null,
        usage: protocolResult.usage ?? null,
        model_usage: [],
        subscription_quota: null,
      }
    : parseCliRuntimeMeasurement(
        spec.adapter_type as VendorCliAdapterType,
        result.stdout,
      );
  const envelope = cliResultEnvelope(
    input,
    spec,
    rendered,
    result,
    timeout,
    credential,
    tool,
    startedAt,
    runtimeBinding,
    Boolean(input.runtime_event_sink),
    protocolResult,
    measurement,
  );
  if (input.invocation_delivery) {
    envelope.metadata_json = {
      ...recordValue(envelope.metadata_json),
      runtime_context_audit_refs: input.invocation_delivery.audit_refs,
    };
  }
  if (
    !runtimeBinding.provider_id
    && credential.profile_id
    && measurement.subscription_quota
    && credentialBroker.recordLiveQuota
  ) {
    await credentialBroker.recordLiveQuota(
      spec.credentials.credential_runtime_name,
      credential.profile_id,
      measurement.subscription_quota,
    );
  }
  return envelope;
}

function renderCliDeliveryMessages(delivery: InvocationDelivery): string[] {
  if (!delivery.cli_session) {
    return [delivery.message_blocks.map((block) => block.content).join("\n\n")];
  }
  const current = delivery.message_blocks.filter((block) => block.delivery_phase === "current_user");
  const context = delivery.message_blocks.filter((block) => block.delivery_phase !== "current_user");
  const contextLabel = delivery.mode === "full"
    ? "Agent Space context bootstrap"
    : "Agent Space context delta";
  return [
    ...(context.length > 0
      ? [[`[${contextLabel} — ordinary context message]`, ...context.map((block) => block.content)].join("\n\n")]
      : []),
    current.map((block) => block.content).join("\n\n"),
  ].filter((message) => message.trim());
}

async function configureCliToolTransport(
  spec: LocalCliRuntimeAdapterSpec,
  input: VendorCliAdapterInput,
  rendered: RenderedCliCommand,
  runtimeBinding: RuntimeProviderBinding,
  url: string,
  token: string,
): Promise<void> {
  if (!input.sandbox_cwd) throw new Error("Run-scoped CLI tools require a prepared sandbox.");
  const contextCwd = vendorContextCwd(input);
  if (!contextCwd) throw new Error("Run-scoped CLI tools require a writable context directory.");
  if (spec.adapter_type === "codex_cli") {
    const codexHome = stringValue(runtimeBinding.env.CODEX_HOME);
    if (!codexHome) throw new Error("Codex tool transport requires CODEX_HOME.");
    await appendFile(
      join(codexHome, "config.toml"),
      `\n[mcp_servers.agent_space]\nurl = ${JSON.stringify(url)}\nbearer_token_env_var = "AGENT_SPACE_TOOL_TOKEN"\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    return;
  }
  if (spec.adapter_type === "claude_code") {
    const stagedConfigPath = join(contextCwd, ".agent-space-mcp.json");
    await writeFile(stagedConfigPath, JSON.stringify({
      mcpServers: {
        "agent-space": {
          type: "http",
          url,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    }), { encoding: "utf8", mode: 0o600 });
    const configPath =
      (input.required_sandbox_level ?? input.run.required_sandbox_level) === "read_only"
        ? join(input.sandbox_cwd, ".agent-space-mcp.json")
        : stagedConfigPath;
    const insertAt = Math.max(1, rendered.argv.length - 1);
    rendered.argv.splice(insertAt, 0, "--mcp-config", configPath);
    rendered.redacted_argv.splice(insertAt, 0, "--mcp-config", configPath);
    return;
  }
  const configPath = join(contextCwd, "opencode.json");
  const existing = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  const mcp = recordValue(existing.mcp);
  existing.mcp = {
    ...mcp,
    "agent-space": {
      type: "remote",
      url,
      enabled: true,
      headers: { Authorization: "Bearer {env:AGENT_SPACE_TOOL_TOKEN}" },
    },
  };
  await writeFile(configPath, JSON.stringify(existing, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

function runExchangeEnv(config: Record<string, unknown> | undefined): Record<string, string> {
  const inputDir = stringValue(config?.run_exchange_input_dir);
  const outputDir = stringValue(config?.run_exchange_output_dir);
  if (!inputDir || !outputDir) return {};
  return {
    AGENT_SPACE_EXCHANGE_INPUT: join(inputDir, "run_input.json"),
    AGENT_SPACE_EXCHANGE_OUTPUT: outputDir,
  };
}

function vendorContextCwd(input: VendorCliAdapterInput): string | null {
  const readOnly = recordValue(input.adapter_config?.read_only_workspace);
  return stringValue(readOnly.context_cwd) ?? input.sandbox_cwd ?? null;
}

function readOnlyExecutionOptions(
  config: ServerConfig,
  input: VendorCliAdapterInput,
  credential: CredentialGrant,
  exchangeInputCwd: string | null,
  exchangeOutputCwd: string | null,
): {
  workspace_cwd: string;
  context_cwd: string;
  sandbox_root: string;
  agent_space_home: string;
  cli_tools_root: string;
  readable_paths: string[];
  writable_paths: string[];
} {
  const readOnly = recordValue(input.adapter_config?.read_only_workspace);
  const workspaceCwd = stringValue(readOnly.workspace_cwd);
  const contextCwd = stringValue(readOnly.context_cwd);
  if (!workspaceCwd || !contextCwd || workspaceCwd !== input.sandbox_cwd) {
    throw new Error("Read-only Project Folder execution options are invalid.");
  }
  return {
    workspace_cwd: workspaceCwd,
    context_cwd: contextCwd,
    sandbox_root: config.sandboxRoot,
    agent_space_home: config.agentSpaceHome,
    cli_tools_root: config.cliToolsRoot,
    readable_paths: [exchangeInputCwd].filter(
      (value): value is string => Boolean(value),
    ),
    writable_paths: [
      credential.temp_home,
      exchangeOutputCwd,
    ].filter((value): value is string => Boolean(value)),
  };
}

async function cliDefaultNetworkEnv(
  config: ServerConfig,
  spaceId: string,
  credential: CredentialGrant,
  binding: RuntimeProviderBinding,
): Promise<Record<string, string>> {
  if (binding.provider_id || !credential.network_profile_id) return {};
  try {
    const profile = await resolveNetworkProfileRepository(config).resolve(
      spaceId,
      credential.network_profile_id,
    );
    return envForNetworkProfile(profile);
  } catch {
    return {};
  }
}

function validateSandbox(
  input: VendorCliAdapterInput,
  spec: LocalCliRuntimeAdapterSpec,
): { code: string; message: string } | null {
  const level = input.required_sandbox_level ?? input.run.required_sandbox_level;
  if (level === "one_shot_docker" || level === "docker") {
    if (!spec.sandbox.supports_one_shot_docker) {
      return {
        code: "docker_sandbox_not_supported",
        message: `Runtime adapter '${spec.adapter_type}' does not support one-shot Docker execution.`,
      };
    }
    if (!input.sandbox_cwd) {
      return {
        code: "workspace_prepare_failed",
        message: `Runtime adapter '${spec.adapter_type}' requires a prepared Docker sandbox directory.`,
      };
    }
    return null;
  }
  if (level === "ephemeral") {
    // Run-scope sandbox: a system-provisioned throwaway working dir. No
    // workspace required; only a prepared working directory.
    if (!input.sandbox_cwd) {
      return {
        code: "workspace_prepare_failed",
        message: `Runtime adapter '${spec.adapter_type}' requires a prepared sandbox working directory.`,
      };
    }
    return null;
  }
  if (level === "read_only") {
    const readOnly = recordValue(input.adapter_config?.read_only_workspace);
    if (!input.run.project_folder_id) {
      return {
        code: "workspace_required",
        message: `Runtime adapter '${spec.adapter_type}' requires a project_folder_id.`,
      };
    }
    if (
      !input.sandbox_cwd
      || !stringValue(readOnly.workspace_cwd)
      || !stringValue(readOnly.context_cwd)
    ) {
      return {
        code: "workspace_prepare_failed",
        message: `Runtime adapter '${spec.adapter_type}' requires a prepared read-only Project Folder.`,
      };
    }
    return null;
  }
  if (level !== "worktree") {
    return {
      code: "file_access_adapter_requires_worktree_policy",
      message: `Runtime adapter '${spec.adapter_type}' requires worktree sandbox policy.`,
    };
  }
  if (!input.run.project_folder_id) {
    return {
      code: "workspace_required",
      message: `Runtime adapter '${spec.adapter_type}' requires a project_folder_id.`,
    };
  }
  if (!input.sandbox_cwd) {
    return {
      code: "workspace_prepare_failed",
      message: `Runtime adapter '${spec.adapter_type}' requires a prepared sandbox worktree.`,
    };
  }
  return null;
}

async function grantCredential(
  input: VendorCliAdapterInput,
  spec: LocalCliRuntimeAdapterSpec,
  broker: CliCredentialBrokerPort,
  executorMode: ExecutorMode,
): Promise<CredentialGrant> {
  const conversationStateKey = stringValue(
    recordValue(input.adapter_config?.conversation_runtime).runtime_state_key,
  );
  if (spec.adapter_type === "opencode" && input.run.model_provider_id) {
    const tempHome = conversationStateKey
      ? await broker.prepareConversationHome?.(conversationStateKey)
      : await broker.prepareRunHome?.(input.run.id);
    if (!tempHome) {
      throw new Error("OpenCode provider execution requires an isolated run HOME");
    }
    return {
      granted: true,
      profile_id: null,
      runtime: spec.credentials.credential_runtime_name,
      executor_mode: executorMode,
      readonly: true,
      temp_home: tempHome,
      persistent_home: Boolean(conversationStateKey),
      host_source_path: null,
      target_path: null,
      env: { HOME: tempHome },
      network_profile_id: null,
      fallback_reason: "model_provider_binding",
    };
  }
  try {
    return await broker.grantForRun(
      input.run.id,
      input.run.space_id,
      spec.credentials.credential_runtime_name,
      executorMode,
      profileId(input),
      {
        conversation_state_key: conversationStateKey,
        user_id: input.run.instructed_by_user_id,
      },
    );
  } catch {
    return {
      granted: false,
      profile_id: null,
      runtime: spec.credentials.credential_runtime_name,
      executor_mode: executorMode,
      readonly: false,
      temp_home: null,
      persistent_home: false,
      host_source_path: null,
      target_path: null,
      env: {},
      network_profile_id: null,
      fallback_reason: "broker_error",
    };
  }
}

function executorModeFor(input: VendorCliAdapterInput): ExecutorMode {
  void input;
  // Credential material is always staged into a scope-owned runtime HOME.
  // The dedicated Runner, rather than an application-server Docker subprocess,
  // supplies the isolation mode for critical execution.
  return "worktree";
}

function runnerEgressProfile(
  provider: boolean,
  tools: boolean,
): "none" | "provider" | "tools" | "provider_and_tools" {
  return provider && tools ? "provider_and_tools" : provider ? "provider" : tools ? "tools" : "none";
}

async function configureVendorSandbox(
  input: VendorCliAdapterInput,
  spec: LocalCliRuntimeAdapterSpec,
): Promise<void> {
  const contextCwd = vendorContextCwd(input);
  if (!contextCwd && spec.subagent_disable_config) {
    throw new Error("CLI configuration requires a sandbox worktree.");
  }
  if (spec.subagent_disable_config) await ensureRuntimeSubagentsDisabled(spec, contextCwd!);
}

async function cleanupCredential(
  input: VendorCliAdapterInput,
  broker: CliCredentialBrokerPort,
): Promise<void> {
  if (stringValue(recordValue(input.adapter_config?.conversation_runtime).runtime_state_key)) {
    return;
  }
  try {
    await broker.cleanupRunHome?.(input.run.id);
  } catch {}
}

function cliResultEnvelope(
  input: VendorCliAdapterInput,
  spec: LocalCliRuntimeAdapterSpec,
  rendered: RenderedCliCommand,
  result: CliExecutionResult,
  timeout: number,
  credential: CredentialGrant,
  tool: ResolvedRuntimeTool,
  startedAt: string,
  runtimeBinding: RuntimeProviderBinding,
  eventsStreamed: boolean,
  protocolResult: {
    completed: boolean;
    text: string;
    error?: string | null;
    external_session_id?: string | null;
    usage?: RunAdapterResultEnvelope["usage"];
  } | null,
  measurement: CliRuntimeMeasurement,
): RunAdapterResultEnvelope {
  const resumedRuntimeSession = Boolean(
    stringValue(recordValue(input.adapter_config?.conversation_runtime).runtime_session_id),
  );
  const stdout = redactCliOutput(result.stdout);
  const stderr = redactCliOutput(result.stderr);
  const protocolError = protocolResult
    ? protocolResult.error?.trim() || (protocolResult.completed ? null : "CLI conversation protocol ended before the final turn completed")
    : null;
  const resumedSessionInvalid = resumedRuntimeSession && Boolean(
    protocolError || invalidRuntimeSessionMessage(stderr),
  );
  const success = result.returncode === 0 && !result.timed_out && !protocolError;
  const structured = parseVendorStructuredOutput(
    spec.adapter_type as VendorCliAdapterType,
    stdout,
  );
  const completedAt = new Date().toISOString();
  return {
    adapter_type: spec.adapter_type,
    adapter_kind: "local_cli",
    success,
    output_text: protocolResult?.text ?? structured?.text ?? stdout,
    output_json: (success
      ? structured?.output_json ?? null
      : { adapter_type: spec.adapter_type }) as RunAdapterResultEnvelope["output_json"],
    exit_code: result.returncode,
    error_code: success
      ? null
      : resumedSessionInvalid
        ? "runtime_session_invalid"
      : result.failure_code === "sandbox_runner_unavailable"
        ? "sandbox_runner_unavailable"
      : result.failure_code === "sandbox_namespace_unavailable"
        ? "sandbox_namespace_unavailable"
      : result.timed_out
        ? result.failure_code === "stall_timeout"
          ? "cli_stall_timeout"
          : "cli_adapter_timeout"
        : "cli_adapter_nonzero_exit",
    error_message: success ? null : protocolError || stderr || "CLI adapter failed.",
    started_at: startedAt,
    completed_at: completedAt,
    usage: measurement.usage,
    model_usage: measurement.model_usage,
    metadata_json: sanitizeEvidenceJson({
      adapter_type: spec.adapter_type,
      runtime_kind: "local_cli",
      runtime_tool_version: tool.version,
      runtime_tool_source: tool.source,
      runtime_tool_package: tool.package_name,
      credential_checked: true,
      credential_broker_used: true,
      credential_source: "profile",
      credential_profile_id: credential.profile_id,
      temp_home_created: Boolean(credential.temp_home),
      cleanup_status: credential.persistent_home
        ? "preserved"
        : credential.temp_home
          ? "requested"
          : "not_needed",
      trigger_origin: input.trigger_origin ?? input.run.trigger_origin,
      permission_bypass_requested: Boolean(input.adapter_config?.permission_bypass),
      permission_bypass_used: rendered.permission_bypass_used,
      structured_output: Boolean(structured),
      structured_event_count: structured?.event_count ?? null,
      external_session_id: measurement.external_session_id,
      conversation_binding_id: stringValue(
        recordValue(input.adapter_config?.conversation_runtime).binding_id,
      ),
      runtime_session_resumed: resumedRuntimeSession,
      subscription_quota: measurement.subscription_quota,
      runtime_provider_id: runtimeBinding.provider_id,
      runtime_provider_model: runtimeBinding.model ?? modelFromRun(input.run),
      runtime_provider_protocol: runtimeBinding.protocol,
      runtime_provider_proxy: Boolean(runtimeBinding.lease_id),
      claude_compatible_provider_id:
        spec.adapter_type === "claude_code" ? input.run.model_provider_id : null,
      claude_compatible_model:
        spec.adapter_type === "claude_code" ? runtimeBinding.model ?? modelFromRun(input.run) : null,
      claude_compatible_provider_proxy:
        spec.adapter_type === "claude_code" ? Boolean(runtimeBinding.lease_id) : null,
    }) as RunAdapterResultEnvelope["metadata_json"],
    adapter_log_json: sanitizeEvidenceJson({
      adapter_type: spec.adapter_type,
      command: rendered.redacted_argv,
      runtime_tool_version: tool.version,
      exit_code: result.returncode,
      timeout_seconds: timeout,
    }) as RunAdapterResultEnvelope["metadata_json"],
    runtime_events: !eventsStreamed && structured?.runtime_events.length
      ? structured.runtime_events
      : terminalRuntimeEvents({
          adapterType: spec.adapter_type,
          success,
          completedAt,
          errorCode: success
            ? null
            : resumedSessionInvalid
              ? "runtime_session_invalid"
              : result.failure_code ?? "cli_adapter_nonzero_exit",
        }),
  };
}

export function createVendorEventStream(adapterType: VendorCliAdapterType): {
  push(chunk: string): RuntimeSemanticEvent[];
  finish(): RuntimeSemanticEvent[];
} {
  let buffer = "";
  const parse = (flush: boolean): RuntimeSemanticEvent[] => {
    const lines = buffer.split(/\r?\n/);
    buffer = flush ? "" : lines.pop() ?? "";
    const occurredAt = new Date().toISOString();
    return lines.flatMap((line) => {
      const event = parseJsonRecord(line);
      return event ? normalizeVendorEvents(adapterType, [event], occurredAt) : [];
    });
  };
  return {
    push(chunk) {
      buffer += chunk;
      return parse(false);
    },
    finish() {
      if (!buffer.trim()) return [];
      buffer += "\n";
      return parse(true);
    },
  };
}

export function parseVendorStructuredOutput(
  adapterType: VendorCliAdapterType,
  stdout: string,
): ReturnType<typeof parseOpenCodeOutput> | null {
  const parsed = parseOpenCodeOutput(stdout, adapterType);
  return parsed.event_count > 0 ? parsed : null;
}

export function parseOpenCodeOutput(
  stdout: string,
  adapterType: VendorCliAdapterType = "opencode",
): {
  text: string;
  output_json: Record<string, unknown> | null;
  event_count: number;
  runtime_events: ReturnType<typeof normalizeVendorEvents>;
} {
  const events = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      return parseJsonRecord(line);
    })
    .filter((event): event is Record<string, unknown> => Boolean(event));
  if (events.length === 0) {
    return { text: stdout, output_json: null, event_count: 0, runtime_events: [] };
  }
  const textChunks = events
    .flatMap(eventText)
    .filter((value): value is string => Boolean(value));
  const usesDeltaProtocol = events.some((event) =>
    event.method === "item/agentMessage/delta" ||
    (
      event.method === "session/update" &&
      recordValue(recordValue(event.params).update).sessionUpdate === "agent_message_chunk"
    ));
  const text = textChunks.join(usesDeltaProtocol ? "" : "\n");
  return {
    text: text || stdout,
    output_json: { format: `${adapterType}_jsonl` },
    event_count: events.length,
    runtime_events: normalizeVendorEvents(
      adapterType,
      events,
      new Date().toISOString(),
    ),
  };
}

function eventText(event: Record<string, unknown>): string[] {
  if (event.method === "item/agentMessage/delta") {
    const delta = stringValue(recordValue(event.params).delta);
    return delta ? [delta] : [];
  }
  if (event.method === "session/update") {
    const update = recordValue(recordValue(event.params).update);
    if (update.sessionUpdate !== "agent_message_chunk") return [];
    const text = stringValue(recordValue(update.content).text);
    return text ? [text] : [];
  }
  const direct = stringValue(event.text)
    ?? stringValue(event.result)
    ?? stringValue(recordValue(event.part).text)
    ?? stringValue(recordValue(event.item).text)
    ?? stringValue(recordValue(event.message).text);
  if (direct) return [direct];
  const content = recordValue(event.message).content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    const text = stringValue(recordValue(block).text);
    return text ? [text] : [];
  });
}

export function createVendorTextDeltaStream(adapterType: VendorCliAdapterType): {
  push(chunk: string): string[];
  finish(): string[];
} {
  let buffer = "";
  const eventDeltas = (event: Record<string, unknown>): string[] => {
    if (adapterType !== "claude_code" || event.type !== "stream_event") return [];
    const streamEvent = recordValue(event.event);
    const delta = recordValue(streamEvent.delta);
    const text = streamEvent.type === "content_block_delta" && delta.type === "text_delta"
      ? stringValue(delta.text)
      : null;
    return text ? [text] : [];
  };
  const parse = (flush: boolean): string[] => {
    const lines = buffer.split(/\r?\n/);
    buffer = flush ? "" : lines.pop() ?? "";
    return lines
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        const event = parseJsonRecord(line);
        return event ? eventDeltas(event) : [];
      });
  };
  return {
    push(chunk) {
      buffer += chunk;
      return parse(false);
    },
    finish() {
      if (!buffer.trim()) return [];
      buffer += "\n";
      return parse(true);
    },
  };
}

function parseJsonRecord(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line.trim());
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function cliFailure(
  input: VendorCliAdapterInput,
  errorCode: string,
  message: string,
  startedAt: string,
  spec?: LocalCliRuntimeAdapterSpec,
  metadataJson: unknown = {},
): RunAdapterResultEnvelope {
  const adapterType = spec?.adapter_type ?? (input.run.adapter_type ?? "unknown");
  const completedAt = new Date().toISOString();
  return {
    adapter_type: adapterType,
    adapter_kind: "local_cli",
    success: false,
    output_text: "",
    output_json: { adapter_type: adapterType },
    exit_code: 1,
    error_code: errorCode,
    error_message: redactEvidenceText(message),
    started_at: startedAt,
    completed_at: completedAt,
    usage: null,
    metadata_json: sanitizeEvidenceJson({
      adapter_type: adapterType,
      runtime_kind: "local_cli",
      ...recordValue(metadataJson),
    }) as RunAdapterResultEnvelope["metadata_json"],
    runtime_events: terminalRuntimeEvents({
      adapterType,
      success: false,
      completedAt,
      errorCode,
    }),
  };
}

function timeoutSeconds(
  config: Record<string, unknown> | undefined,
  spec: LocalCliRuntimeAdapterSpec,
  run: RunRecord,
): number {
  const raw = config?.timeout;
  const parsed = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  const selected = Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : spec.limits.default_timeout_seconds;
  const contract = recordValue(run.contract_snapshot_json);
  const maxDuration = typeof contract.max_duration_seconds === "number" &&
    Number.isFinite(contract.max_duration_seconds) && contract.max_duration_seconds > 0
    ? Math.trunc(contract.max_duration_seconds)
    : null;
  return Math.min(selected, spec.limits.max_timeout_seconds, maxDuration ?? Number.MAX_SAFE_INTEGER);
}

function stallTimeoutSeconds(
  adapterConfig: Record<string, unknown> | undefined,
  timeoutSeconds: number,
): number {
  const configured = Number(adapterConfig?.stall_timeout_seconds);
  const requested = Number.isFinite(configured) && configured > 0 ? configured : 300;
  return Math.min(requested, Math.max(1, timeoutSeconds - 1));
}

function profileId(input: VendorCliAdapterInput): string | null {
  return stringValue(input.adapter_config?.credential_profile_id);
}

function modelFromRun(run: RunRecord): string | null {
  return stringValue(recordValue(run.model_override_json).model);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function invalidRuntimeSessionMessage(message: string): boolean {
  return /\b(session|thread)\b.{0,80}\b(not found|does not exist|invalid|unknown|expired)\b/i
    .test(message);
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function redactCliOutput(value: string): string {
  const truncated = value.length > 12_000 ? `${value.slice(0, 12_000)}\n[TRUNCATED]` : value;
  return redactEvidenceText(truncated) ?? "";
}

export function redactCommandLog(argv: string[]): string[] {
  return argv.map((item) =>
    SECRET_COMMAND_KEYS.some((key) => item.toLowerCase().includes(key)) ? "[REDACTED]" : item,
  );
}
