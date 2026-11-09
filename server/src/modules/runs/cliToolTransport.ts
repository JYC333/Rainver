import {operationRuntime} from '../systemActions/operations/runtime.js';
import {dispatchRunOperation} from './operationToolDispatch.js';
import {OperationToolResponse} from '../systemActions/operations/agentResult.js';
import {loadSystemActionRegistry} from '../systemActions/registry.js';
import type {
  CanonicalToolDefinition,
} from "@rainver/protocol";
import type { ServerConfig } from "../../config.js";
import {
  SystemActionDispatcher,
  type SystemActionDispatcherDeps,
} from "../systemActions/systemActionDispatcher.js";
import type { AgentRunRecord } from "./repository.js";

export class CliAgentToolTransport {
  constructor(
    private readonly config: ServerConfig,
    private readonly deps: SystemActionDispatcherDeps = {},
  ) {}

  async list(run: AgentRunRecord): Promise<CanonicalToolDefinition[]> {
    this.assertActive(run);
    const dispatcher = await SystemActionDispatcher.create(this.config, run, this.deps);
    return dispatcher.listGrantedDefinitions();
  }

  async call(
    run: AgentRunRecord,
    call: { id: string; name: string; arguments: unknown },
  ): Promise<unknown> {
    this.assertActive(run);
    const definition=(await loadSystemActionRegistry()).get(call.name as never);
    if(definition?.execution){
      const runtime=await operationRuntime(this.config);
      // Project authority is resolved from the live Run by the core, never injected/overridden by caller input.
      const input = call.arguments;
      const result = await dispatchRunOperation(this.config, run, {...call, arguments: input}, definition,
        actor => runtime.execute(call.name, input, actor, call.id, call.id), this.deps.actionEventSink);
      // Preserve the existing Agent cancellation receipt; generic HTTP keeps the typed envelope.
      if(call.name === 'research.cancel_acquisition' && result.body.status === 'succeeded')
        return new OperationToolResponse(result.httpStatus, {ok:true,tool:call.name,...result.body.data as Record<string,unknown>},result.summary);
      return result;
    }
    const dispatcher = await SystemActionDispatcher.create(this.config, run, this.deps);
    const result = await dispatcher.dispatch({
      id: call.id,
      name: call.name,
      arguments_json: JSON.stringify(call.arguments ?? {}),
    });
    const body=result.modelResult as Record<string,unknown>|null;
    if(body?.error_code==='idempotency_in_progress'&&body.http_status===409)return new OperationToolResponse(409,body);
    return result.modelResult;
  }

  private assertActive(run: AgentRunRecord): void {
    if (run.status !== "running") {
      throw new Error(`CLI tool transport requires a running Run (received '${run.status}').`);
    }
  }
}
