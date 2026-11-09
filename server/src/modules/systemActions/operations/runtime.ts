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
    runtime = loadSystemActionRegistry().then(definitions => new OperationExecutor(dbPool(config), config, [catalogRegistration(definitions), researchCancelRegistration(definitions)]));
    runtimes.set(config, runtime);
  }
  return runtime;
}
