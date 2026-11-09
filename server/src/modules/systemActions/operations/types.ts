import type { OperationBusinessError } from './errors.js';
import type { OperationActor, RegisteredSystemActionDefinition as SystemActionDefinition } from '@rainver/protocol';
import type { Queryable } from '../../routeUtils/common.js';
import type { PolicyCheckRequest } from '@rainver/protocol';
export interface OperationReadAuditPort {
  recordReads(resourceType: string, resourceIds: readonly string[]): Promise<number>;
}
export interface ResolvedOperation {
  authority: string;
  targets: unknown;
  resourceType: string;
  resourceId: string|null;
}
export interface OperationRegistration {
  definition: SystemActionDefinition;
  readKind?: 'metadata' | 'content';
  /** Access-owned Personal/Project placement, for human new-content drafts and the named Monitor creation command.
   * Never accepts a target Space from input and never moves existing content. */
  userContentCreation?: true;
  successStatus?: 200 | 201 | 202;
  resolve(db: Queryable, input: unknown, actor: OperationActor): Promise<ResolvedOperation>;
  /** Pure normalization after stable target binding; never includes observed mutable versions. */
  normalizeInput?(input: unknown, scope: ResolvedOperation): unknown;
  authorize(db: Queryable, input: unknown, actor: OperationActor, scope: ResolvedOperation): Promise<void>;
  authorizeResult?(db: Queryable, output: unknown, actor: OperationActor): Promise<void>;
  execute(db: Queryable, input: unknown, actor: OperationActor): Promise<unknown>;
  /** Explicit safe allowlist only: never reflect arbitrary HttpError messages/bodies.
   * Deterministic 409/422 errors are rolled back to the domain savepoint and cached.
   */
  classifyError?(error: unknown): OperationBusinessError | undefined;
  /** Rebuildable notifications only; required work must already be a transactional Job intent. */
  afterCommit?(output: unknown, actor: OperationActor): Promise<void>;
  policyContext?(input: unknown, actor: OperationActor): PolicyCheckRequest['context'];
  /** Separate host audit port, invoked before releasing query content; never a writable data transaction. */
  readAudit?(audit: OperationReadAuditPort, input: unknown, output: unknown, actor: OperationActor): Promise<void>;
  approval?: {
    proposalType: string;
    gate: {
      kind: 'hard_gate';
      gate_class: NonNullable<SystemActionDefinition['gate_class']>;
      policy_rule_id?: string;
    } | {
      kind: 'unattended_origin';
      policy_rule_id: 'unattended_project_write_require_approval';
    } | {
      kind: 'explicit_checkpoint';
      policy_rule_id: string;
    };
    mode: 'proposal_submission' | 'blocked_command';
    requiresLiveRun?: boolean;
    /** Must be earned by a reviewed complete effect/status-writer inventory before production enablement. */
    atomicStatusWritersVerified: true;
    create(db: Queryable, input: unknown, actor: OperationActor): Promise<string>;
    preconditions(db: Queryable, input: unknown, actor: OperationActor): Promise<unknown>;
  };
}
