import {safeInputErrors} from '../systemActions/inputErrors.js';
import { systemActionInputJsonSchema } from '@rainver/protocol';
import type { OperationActor, OperationResponse, RegisteredSystemActionDefinition as SystemActionDefinition, CanonicalToolCall } from '@rainver/protocol';
import type { ServerConfig } from '../../config.js';
import { dbPool } from '../routeUtils/common.js';
import { runActor, assertCurrentActor, assertOperationGrant } from '../systemActions/operations/actor.js';
import { OperationError, OperationInputError, hidden } from '../systemActions/operations/errors.js';
import { operationToolResponse, type OperationToolResponse } from '../systemActions/operations/agentResult.js';
import type { AgentRunRecord } from './repository.js';
import { defaultActionEventSink } from './actionEvents.js';
import { loadActionRegistry } from '../policy/actionRegistry.js';

type EventSink = (event: 'action_invoked' | 'action_completed', call: CanonicalToolCall, metadata?: Record<string, unknown>) => Promise<void>;

function applicationsProject(run: AgentRunRecord, definition: SystemActionDefinition): string | null {
  return definition.id.startsWith('plugin.phd_application.') ? run.project_id : null;
}

export function runOperationInputJsonSchema(run: AgentRunRecord, definition: SystemActionDefinition): Record<string, unknown> {
  const schema = systemActionInputJsonSchema(definition);
  if (!applicationsProject(run, definition)) return schema;
  const required = Array.isArray(schema.required) ? schema.required.filter(key => key !== 'project_id') : [];
  const properties = schema.properties as Record<string, Record<string, unknown>>;
  return {
    ...schema,
    required,
    properties: {
      ...properties,
      project_id: { ...properties.project_id, description: "The current Run's Project. Defaults to that Project when omitted." },
    },
  };
}

/** Compatibility evidence for opt-in Agent operations. The core still rechecks all
 * authority at execution/replay. No domain arguments enter RunEvent metadata.
 */
export async function dispatchRunOperation(
  config: ServerConfig, run: AgentRunRecord,
  call: {id: string; name: string; arguments: unknown}, definition: SystemActionDefinition,
  invoke: (actor: OperationActor, input: unknown) => Promise<OperationResponse>,
  sink: EventSink | undefined = defaultActionEventSink(config, run),
): Promise<OperationToolResponse> {
  const eventCall = {id: call.id, name: call.name, arguments_json: '{}'};
  let result: OperationResponse;
  try {
    const db = dbPool(config), actor = await runActor(db, run);
    await assertCurrentActor(db, actor);
    await assertOperationGrant(db, actor, call.name);
    if (!definition.allowed_actor_types.includes('agent') || !definition.visibility.has('agent_tool')) throw hidden();
    const projectId = applicationsProject(run, definition);
    const raw = call.arguments;
    const input = projectId && raw && typeof raw === 'object' && !Array.isArray(raw) && !Object.hasOwn(raw, 'project_id')
      ? { ...raw, project_id: projectId }
      : raw;
    const parsed=definition.input_schema.safeParse(input);
    if (!parsed.success) throw new OperationInputError(safeInputErrors(definition,parsed.error));
    try { await sink?.('action_invoked', eventCall, {action_version: definition.version}); }
    catch (error) {
      if ((await loadActionRegistry(config)).get(definition.policy_action)?.record_failure_mode === 'fail_closed') throw error;
    }
    result = await invoke(actor, input);
  } catch (error) {
    const safe = error instanceof OperationError ? error : new OperationError('operation_internal_error', 500);
    result = {http_status: safe.httpStatus, request_id: call.id, replayed: false, policy_decision_record_id: null, body: safe.body(call.id)};
  }
  const formatted = operationToolResponse(result, call.name);
  try { await sink?.('action_completed', eventCall, {action_version: definition.version, ...formatted.summary}); }
  catch { /* Run evidence is best effort; never disguise committed work or replace a refusal. */ }
  return formatted;
}
