import type { CliStdioController } from "../runs/localCliExecution.js";
import { createCliConversationController } from "../runs/cliConversationProtocol.js";
import type { VendorCliRuntimeKey } from "./specs.js";
import { assertAgentRuntimeDefinition } from "./runtimeDefinitions.js";

/** The only Rainver Agent execution adapter; it delegates to AcpController. */
export class AcpRuntimeAdapter {
  readonly runtimeKey: string;

  constructor(runtimeKey: string) {
    this.runtimeKey = assertAgentRuntimeDefinition(runtimeKey).runtime_key;
  }

  createController(input: Omit<Parameters<typeof createCliConversationController>[0], "runtime_key">): CliStdioController | undefined {
    return createCliConversationController({
      ...input,
      runtime_key: this.runtimeKey as VendorCliRuntimeKey,
    });
  }
}
