import { pluginOperations } from "../../plugins/operationRegistry.js";
import { researchCancelRegistration } from '../../projectResearch/researchCancelOperation.js';
import type { ServerConfig } from '../../../config.js';
import { dbPool } from '../../routeUtils/common.js';
import { loadSystemActionRegistry } from '../registry.js';
import { OperationExecutor } from './executor.js';
import { catalogRegistration } from './catalog.js';
const runtimes = new WeakMap<ServerConfig, Promise<OperationExecutor>>();
/** Composition-scoped, never Run-scoped. Registrations close over no caller. */
export function operationRuntime(config: ServerConfig): Promise<OperationExecutor> {
  let runtime = runtimes.get(config);
  if (!runtime) {
    runtime = loadSystemActionRegistry(config).then(definitions => new OperationExecutor(dbPool(config), config, [catalogRegistration(config,definitions), researchCancelRegistration(definitions),...pluginOperations(config)]));
    runtimes.set(config, runtime);
  }
  return runtime;
}
