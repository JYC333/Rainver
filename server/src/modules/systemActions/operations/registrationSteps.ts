import type {OperationActor, PolicyCheckRequest} from '@rainver/protocol';
import type {Queryable} from '../../routeUtils/common.js';
import {runOperationWork} from '../../../db/operationTransaction.js';
import {canWriteGmailDerivedProjectContent,sensitiveTaintEgressContext} from '../../plugins/egress.js';
import {OperationError} from './errors.js';
import type {OperationInvocation, OperationRegistration, ResolvedOperation} from './types.js';

/**
 * The registration's own in-transaction domain steps, shared by the executor
 * and the plugin core ports' nested call (ADR 0030 §9). They are steps, not a
 * second engine: receipts, idempotency, approval, placement, release gates and
 * the outer transaction stay with `OperationExecutor.execute`, and nothing
 * here calls it.
 */

/** resolve → optional normalizeInput (revalidated against the input schema). */
export async function resolveRegisteredInput(item: OperationRegistration, db: Queryable, input: unknown, actor: OperationActor, invocation?: Readonly<OperationInvocation>): Promise<{scope: ResolvedOperation; input: unknown}> {
  const scope = await runOperationWork(() => item.resolve(db, input, actor, invocation));
  if (!item.normalizeInput) return {scope, input};
  const normalized = item.definition.input_schema.safeParse(item.normalizeInput(input, scope));
  if (!normalized.success) throw new OperationError('operation_internal_error', 500);
  return {scope, input: normalized.data};
}

/** The registration's policy request for its own action, scope and context, including the sensitive-read egress facts for an Agent. */
export async function registeredPolicyRequest(db: Queryable, item: OperationRegistration, input: unknown, actor: OperationActor, scope: ResolvedOperation, extra: {space: string; context?: Record<string, unknown>; metadata: Record<string, unknown>}): Promise<PolicyCheckRequest> {
  const d = item.definition;
  const egress = actor.principal.kind === 'agent'
    ? await sensitiveTaintEgressContext(db, actor.space_id, actor.run_id, d) : undefined;
  if (egress?.sensitive_plugin_read_taint && egress.outward_action) {
    const projectId = scope.policyFacts?.gmail_write_project_id;
    const cancellationProject = scope.policyFacts?.unstarted_task_cancellation_project_id;
    if (await canWriteGmailDerivedProjectContent(db, actor, d.id, projectId ? {project_id: projectId} : scope.targets,
      input, typeof cancellationProject === 'string' ? cancellationProject : undefined)) {
      egress.outward_action = false;
    }
  }
  if (egress && (
    d.id === 'workspace.change.complete' && scope.policyFacts?.private_workspace_checkpoint === true ||
    d.id === 'conversation.session_config.save' && scope.policyFacts?.validated_current_conversation_config === true
  )) {
    egress.outward_action = false;
  }
  return {
    action: d.policy_action,
    force_record: true,
    actor_type: actor.principal.kind,
    actor_id: actor.principal.id,
    space_id: extra.space,
    resource_space_id: extra.space,
    resource_type: scope.resourceType,
    resource_id: scope.resourceId,
    run_id: actor.run_id,
    context: {
      ...item.policyContext?.(input, actor, scope),
      ...egress,
      action_id: d.id,
      trigger_origin: actor.effective_origin,
      instructed_by_user_id: actor.on_behalf_of_user_id,
      ...extra.context,
    },
    metadata_json: extra.metadata,
  };
}

/** execute → output schema → authorizeResult. `output` is the raw value for release facts and read audit. */
export async function executeRegistered(item: OperationRegistration, db: Queryable, input: unknown, actor: OperationActor, invocation?: Readonly<OperationInvocation>): Promise<{output: unknown; data: unknown}> {
  const output = await runOperationWork(() => item.execute(db, input, actor, invocation));
  const validated = item.definition.output_schema.safeParse(output);
  if (!validated.success) throw new OperationError('operation_invalid_output', 500);
  await runOperationWork(async () => item.authorizeResult?.(db, validated.data, actor));
  return {output, data: validated.data};
}

/** The registration's explicit, deterministic failure classification; unknown errors stay as they are. */
export function classifyRegisteredError(item: OperationRegistration, error: unknown): unknown {
  return error instanceof OperationError ? error : item.classifyError?.(error) ?? error;
}
