/**
 * Runtime host module.
 *
 * Run orchestration invokes this module in process, through the managed-API
 * runtime adapter. The module executes a provider-backed server host turn and
 * returns a normalized adapter result; it does not own run lifecycle state.
 */

export { executeRuntimeHost, type RuntimeHostLogger } from "./service.js";
export { authorizeRuntimeHostDelivery, bindRuntimeHostDeliveryRequest } from "./deliveryAuthorizer.js";
