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
    const dispatcher = await SystemActionDispatcher.create(this.config, run, this.deps);
    const result = await dispatcher.dispatch({
      id: call.id,
      name: call.name,
      arguments_json: JSON.stringify(call.arguments ?? {}),
    });
    return result.modelResult;
  }

  private assertActive(run: AgentRunRecord): void {
    if (run.status !== "running") {
      throw new Error(`CLI tool transport requires a running Run (received '${run.status}').`);
    }
  }
}
