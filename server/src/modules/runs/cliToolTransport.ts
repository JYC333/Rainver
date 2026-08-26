import { createHash, randomBytes } from "node:crypto";
import type {
  CanonicalToolDefinition,
  RuntimeHostExecuteRequest,
  RunTriggerOrigin,
} from "@agent-space/protocol";
import type { ServerConfig } from "../../config.js";
import {
  SystemActionDispatcher,
  type SystemActionDispatcherDeps,
} from "../systemActions/systemActionDispatcher.js";
import { assembleRunInputEnvelope } from "./runInputEnvelope.js";
import type { RunRecord } from "./repository.js";

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
    private readonly deps: SystemActionDispatcherDeps = {},
  ) {}

  async list(run: RunRecord): Promise<CanonicalToolDefinition[]> {
    this.assertActive(run);
    const dispatcher = await SystemActionDispatcher.create(this.config, run, transportRequest(run), this.deps);
    return dispatcher.listGrantedDefinitions();
  }

  async call(
    run: RunRecord,
    call: { id: string; name: string; arguments: unknown },
  ): Promise<unknown> {
    this.assertActive(run);
    const dispatcher = await SystemActionDispatcher.create(this.config, run, transportRequest(run), this.deps);
    const result = await dispatcher.dispatch({
      id: call.id,
      name: call.name,
      arguments_json: JSON.stringify(call.arguments ?? {}),
    });
    return result.modelResult;
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

function tokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
