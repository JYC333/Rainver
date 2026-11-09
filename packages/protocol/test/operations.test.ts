import { describe, expect, it } from 'vitest';
import { SYSTEM_ACTION_REGISTRY, OPERATION_SCHEMA_TABLE, OperationErrorSchema, OperationActorSchema } from '../src/index.js';
describe('operation public contracts', () => {
  it('uses the same input/output Zod authority for typed callers and the migrated registry', () => {
    const def = SYSTEM_ACTION_REGISTRY.find(d => d.id === 'system.actions.list')!;
    expect(def.input_schema).toBe(OPERATION_SCHEMA_TABLE['system.actions.list'].input);
    expect(def.output_schema).toBe(OPERATION_SCHEMA_TABLE['system.actions.list'].output);
    expect(def.execution).toEqual({
      kind: 'query',
      tx: 'core_owned'
    });
    expect(def.idempotency_required).toBe(false);
  });
  it('keeps retryable conflicts distinct from pending approval and rejects unregistered error codes', () => {
    const error = {
      error: {
        code: 'idempotency_in_progress',
        domain: 'operations',
        message: 'in progress',
        metadata: {},
        retryable: true,
        request_id: 'current'
      }
    };
    expect(OperationErrorSchema.parse(error)).toEqual(error);
    expect(OperationErrorSchema.safeParse({
      error: {
        ...error.error,
        code: 'arbitrary_exception'
      }
    }).success).toBe(false);
    expect(OperationErrorSchema.safeParse({
      status: 'pending_approval',
      proposal_id: 'p'
    }).success).toBe(false);
  });
  it('rejects unknown actor origin and caller-controlled extra authority fields', () => {
    const actor = {
      principal: {
        kind: 'user',
        id: 'u'
      },
      on_behalf_of_user_id: 'u',
      agent_id: null,
      run_id: null,
      origin: 'manual',
      effective_origin: 'manual',
      root_run_id: null,
      continuation_hops: 0,
      surface: 'public_api',
      space_id: 's'
    };
    expect(OperationActorSchema.parse(actor)).toEqual(actor);
    expect(OperationActorSchema.safeParse({
      ...actor,
      origin: 'unknown'
    }).success).toBe(false);
    expect(OperationActorSchema.safeParse({
      ...actor,
      approved_by_user: true
    }).success).toBe(false);
  });
});
