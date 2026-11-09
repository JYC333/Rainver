import type { OperationActor, OperationInput, RegisteredSystemActionDefinition } from '@rainver/protocol';
import type { ServerConfig } from '../../config.js';
import type { OperationRegistration } from '../systemActions/operations/types.js';
import { hidden, OperationBusinessError } from '../systemActions/operations/errors.js';
import { ActionApprovalGrantService, ActionGrantConflict, ActionGrantInputError } from './actionApprovalGrantService.js';

type CreateInput = OperationInput<'policy.action_grant.create'>;
type RevokeInput = OperationInput<'policy.action_grant.revoke'>;
const identity = (actor: OperationActor) => ({spaceId: actor.space_id, userId: actor.on_behalf_of_user_id!});
function output(row: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) =>
    [key, value instanceof Date ? value.toISOString() : value]));
}

/** Public adapters share core admission and the transaction-bound domain writer. */
export function actionGrantRegistrations(
  config: ServerConfig,
  definitions: ReadonlyMap<string, RegisteredSystemActionDefinition>,
): OperationRegistration[] {
  return (['create', 'revoke'] as const).map(kind => ({
    definition: definitions.get(`policy.action_grant.${kind}`)!,
    successStatus: kind === 'create' ? 201 : 200,
    async resolve(_db, raw, actor) {
      return {
        authority: `space:${actor.space_id}:action_grants`, targets: raw,
        resourceType: 'action_approval_grant',
        resourceId: kind === 'create' ? (raw as CreateInput).agent_id : (raw as RevokeInput).grant_id,
      };
    },
    async authorize(db, raw, actor) {
      const service = new ActionApprovalGrantService(db, config);
      await service.assertOwner(identity(actor));
      if (kind === 'create') {
        const input = raw as CreateInput;
        await service.assertScopedResource(actor.space_id, input.agent_id, input.project_id ?? null, input.target_run_id ?? null);
      } else {
        const grant = await db.query(
          'SELECT id FROM action_approval_grants WHERE space_id=$1 AND id=$2 FOR UPDATE',
          [actor.space_id, (raw as RevokeInput).grant_id]);
        if (!grant.rows.length) throw hidden();
      }
    },
    async authorizeResult(db, _raw, actor) {
      await new ActionApprovalGrantService(db, config).assertOwner(identity(actor));
    },
    async execute(db, raw, actor) {
      const service = new ActionApprovalGrantService(db, config);
      return output(kind === 'create'
        ? await service.createInTransaction(identity(actor), raw as CreateInput)
        : await service.revokeInTransaction(identity(actor), (raw as RevokeInput).grant_id));
    },
    classifyError(error) {
      if (error instanceof ActionGrantConflict) return new OperationBusinessError('operation_conflict', 409, 'policy');
      if (error instanceof ActionGrantInputError) return new OperationBusinessError('operation_invalid_input', 422, 'policy');
      return undefined;
    },
  }));
}
