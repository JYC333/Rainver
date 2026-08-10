import { createHash, randomBytes } from "node:crypto";
import type {
  CanonicalToolDefinition,
  RuntimeHostExecuteRequest,
  RuntimeHostExecuteResponse,
  RunTriggerOrigin,
} from "@agent-space/protocol" with { "resolution-mode": "import" };
import type { ServerConfig } from "../../config";
import { AgentToolGateway, type AgentToolGatewayDeps } from "../systemActions/agentToolGateway";
import { assembleRunInputEnvelope } from "./runInputEnvelope";
import type { RunRecord } from "./repository";

interface RunToolIdentity {
  run_id: string;
  space_id: string;
  expires_at: number;
}

export class CliRunToolIdentityRegistry {
  private readonly identities = new Map<string, RunToolIdentity>();

  issue(run: Pick<RunRecord, "id" | "space_id">, ttlMs: number): string {
    const token = randomBytes(32).toString("base64url");
    this.identities.set(tokenDigest(token), {
      run_id: run.id,
      space_id: run.space_id,
      expires_at: Date.now() + Math.max(1, ttlMs),
    });
    return token;
  }

  resolve(token: string, runId: string): RunToolIdentity | null {
    const key = tokenDigest(token);
    const identity = this.identities.get(key);
    if (!identity) return null;
    if (identity.expires_at <= Date.now()) {
      this.identities.delete(key);
      return null;
    }
    if (identity.run_id !== runId) return null;
    return { ...identity };
  }

  revoke(token: string): void {
    this.identities.delete(tokenDigest(token));
  }
}

export const cliRunToolIdentities = new CliRunToolIdentityRegistry();

export class CliAgentToolTransport {
  constructor(
    private readonly config: ServerConfig,
    private readonly deps: AgentToolGatewayDeps = {},
  ) {}

  async list(run: RunRecord): Promise<CanonicalToolDefinition[]> {
    this.assertActive(run);
    const granted = grantedActionIds(run);
    let definitions: CanonicalToolDefinition[] = [];
    await new AgentToolGateway(this.config).execute(
      run,
      transportRequest(run),
      async (_config, request) => {
        definitions = (request.tools ?? []).filter((tool) => granted.has(tool.name));
        return terminalResponse();
      },
      this.deps,
    );
    return definitions;
  }

  async call(
    run: RunRecord,
    call: { id: string; name: string; arguments: unknown },
  ): Promise<unknown> {
    this.assertActive(run);
    if (!grantedActionIds(run).has(call.name)) {
      return { ok: false, tool: call.name, error_code: "cli_tool_not_granted" };
    }
    let turn = 0;
    let result: unknown = { ok: false, error: "Tool result was not produced." };
    const response = await new AgentToolGateway(this.config).execute(
      run,
      transportRequest(run),
      async (_config, request) => {
        turn += 1;
        if (turn === 1) {
          const offered = new Set((request.tools ?? []).map((tool) => tool.name));
          if (!offered.has(call.name)) {
            return {
              ...terminalResponse(),
              success: false,
              error_code: "cli_tool_not_granted",
              error_text: `Tool '${call.name}' is not granted to this Run.`,
            };
          }
          return {
            ...terminalResponse(),
            output_json: {
              tool_calls: [{
                id: call.id,
                name: call.name,
                arguments_json: JSON.stringify(call.arguments ?? {}),
              }],
            },
          };
        }
        const toolMessage = [...(request.messages ?? [])]
          .reverse()
          .find((message) => message.role === "tool" && message.tool_call_id === call.id);
        if (toolMessage?.content) {
          try {
            result = JSON.parse(toolMessage.content);
          } catch {
            result = { ok: false, error: "Tool returned invalid JSON." };
          }
        }
        return terminalResponse();
      },
      this.deps,
    );
    if (
      response.error_code === "authorization_request_pending"
      && result
      && typeof result === "object"
      && (result as { error?: unknown }).error === "Tool result was not produced."
    ) {
      result = {
        ok: false,
        tool: call.name,
        error_code: response.error_code,
        error: response.error_text,
        authorization_request_id:
          typeof response.output_json?.authorization_request_id === "string"
            ? response.output_json.authorization_request_id
            : null,
      };
    }
    return result;
  }

  private assertActive(run: RunRecord): void {
    if (run.status !== "running") {
      throw new Error(`CLI tool transport requires a running Run (received '${run.status}').`);
    }
  }
}

function transportRequest(run: RunRecord): RuntimeHostExecuteRequest {
  return {
    run_input: assembleRunInputEnvelope(run),
    run_id: run.id,
    space_id: run.space_id,
    model_provider_id: run.model_provider_id ?? run.id,
    model: null,
    system_prompt: null,
    prompt: "",
    mode: run.mode,
    instruction: run.instruction,
    session_id: run.session_id,
    parent_run_id: run.parent_run_id ?? null,
    root_run_id: run.root_run_id ?? null,
    run_group_id: run.run_group_id ?? null,
    agent_id: run.agent_id,
    project_id: run.project_id,
    project_folder_id: run.project_folder_id,
    trigger_origin: run.trigger_origin as RunTriggerOrigin,
    capability_id: run.capability_id ?? null,
    output_format: null,
    tool_mode: "disabled",
    tool_bindings: [],
  };
}

function grantedActionIds(run: RunRecord): Set<string> {
  return new Set(assembleRunInputEnvelope(run).tool_grants.map((grant) => grant.action_id));
}

function terminalResponse(): RuntimeHostExecuteResponse {
  return {
    success: true,
    stdout: "",
    stderr: "",
    output_text: "",
    output_json: {},
    exit_code: 0,
    error_text: null,
    error_code: null,
    started_at: null,
    completed_at: new Date().toISOString(),
    model: null,
    usage: null,
    events: [],
    adapter_metadata: {},
    adapter_log_json: null,
  };
}

function tokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
