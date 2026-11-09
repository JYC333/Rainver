import type { OperationActor, OperationResponse, RegisteredSystemActionDefinition as SystemActionDefinition, CanonicalToolCall } from '@rainver/protocol';
import type { ServerConfig } from '../../config.js';
import { dbPool } from '../routeUtils/common.js';
import { runActor, assertCurrentActor, assertOperationGrant } from '../systemActions/operations/actor.js';
import { OperationError, hidden } from '../systemActions/operations/errors.js';
import { operationToolResponse, type OperationToolResponse } from '../systemActions/operations/agentResult.js';
import type { AgentRunRecord } from './repository.js';
import { defaultActionEventSink } from './actionEvents.js';
import { loadActionRegistry } from '../policy/actionRegistry.js';

type EventSink = (event: 'action_invoked' | 'action_completed', call: CanonicalToolCall, metadata?: Record<string, unknown>) => Promise<void>;
/** Compatibility evidence for opt-in Agent operations. The core still rechecks all
 * authority at execution/replay. No domain arguments enter RunEvent metadata.
 */
export async function dispatchRunOperation(
  config: ServerConfig, run: AgentRunRecord,
  call: {id: string; name: string; arguments: unknown}, definition: SystemActionDefinition,
  invoke: (actor: OperationActor) => Promise<OperationResponse>,
  sink: EventSink | undefined = defaultActionEventSink(config, run),
): Promise<OperationToolResponse> {
  const eventCall = {id: call.id, name: call.name, arguments_json: '{}'};
  let result: OperationResponse;
  try {
    const db = dbPool(config), actor = await runActor(db, run);
    await assertCurrentActor(db, actor);
    await assertOperationGrant(db, actor, call.name);
    if (!definition.allowed_actor_types.includes('agent') || !definition.visibility.has('agent_tool')) throw hidden();
    if (!definition.input_schema.safeParse(call.arguments).success) throw new OperationError('operation_invalid_input', 422);
    try { await sink?.('action_invoked', eventCall, {action_version: definition.version}); }
    catch (error) {
      if ((await loadActionRegistry(config)).get(definition.policy_action)?.record_failure_mode === 'fail_closed') throw error;
    }
    result = await invoke(actor);
  } catch (error) {
    const safe = error instanceof OperationError ? error : new OperationError('operation_internal_error', 500);
    result = {http_status: safe.httpStatus, request_id: call.id, replayed: false, policy_decision_record_id: null, body: safe.body(call.id)};
  }
  const formatted = operationToolResponse(result, call.name);
  try { await sink?.('action_completed', eventCall, {action_version: definition.version, ...formatted.summary}); }
  catch { /* Run evidence is best effort; never disguise committed work or replace a refusal. */ }
  return formatted;
}
