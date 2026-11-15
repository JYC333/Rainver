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
/** Host-authored invocation identity; never read from a business input. */
export interface OperationInvocation {
  readonly requestId: string;
  readonly idempotencyKey: string | null;
}
export interface OperationRegistration {
  definition: SystemActionDefinition;
  /** Closed reviewed admission: a person uses owned Personal Space for receipts;
   * daemon workspace admission requires the adapter's live bearer proof.
   * Domain admission locks and reauthorizes every current authority root. */
  admission?: {readonly kind: 'person'|'daemon_workspace'};
  /** Reviewed domain closure owns Project/audience -> person ordering. Core
   * still checks the live actor and grants before admission and after locking.
   * No approval mapping or user-placement operation may opt into this path. */
  domainAuthorizationFirst?: true;
  readKind?: 'metadata' | 'content';
  /** Access-owned Personal/Project placement, for human new-content drafts and the named Monitor creation command.
   * Never accepts a target Space from input and never moves existing content. */
  userContentCreation?: true;
  /** The host admits this complete Run closure before domain locks. A child
   * receives no preparation flag or host client and cannot extend the set. */
  runTerminalOwner?: {
    discover(db:Queryable,input:unknown,actor:OperationActor):Promise<readonly {space_id:string;id:string}[]>;
  };
  /** Canonical Proposal rejection joins this core transaction's audit recovery.
   * No separate transaction or alternate decision dispatcher. */
  policyAuditRecovery?: true;
  /** Canonical Proposal owner discovers its full cascade and checkpoint Run set. */
  proposalDecisionOwner?: { roots(db:Queryable,input:unknown,actor:OperationActor):Promise<readonly string[]>; bundle?:boolean; prepare?(db:Queryable,roots:readonly string[],actor:OperationActor,input:unknown):Promise<void> };
  successStatus?: 200 | 201 | 202 | ((output:unknown)=>200|201|202);
  resolve(db: Queryable, input: unknown, actor: OperationActor, invocation?: Readonly<OperationInvocation>): Promise<ResolvedOperation>;
  /**
   * What the request fingerprint is computed over, when the input carries a
   * secret (a Provider API key): the domain replaces each secret with a keyed,
   * non-reversible digest so a stored fingerprint never derives from it
   * alone. The operation itself still receives the real input.
   */
  fingerprintInput?(input: unknown): unknown | Promise<unknown>;
  /** Pure normalization after stable target binding; never includes observed mutable versions. */
  normalizeInput?(input: unknown, scope: ResolvedOperation): unknown;
  authorize(db: Queryable, input: unknown, actor: OperationActor, scope: ResolvedOperation): Promise<void>;
  authorizeResult?(db: Queryable, output: unknown, actor: OperationActor): Promise<void>;
  execute(db: Queryable, input: unknown, actor: OperationActor, invocation?: Readonly<OperationInvocation>): Promise<unknown>;
  /** Explicit safe allowlist only: never reflect arbitrary HttpError messages/bodies.
   * Deterministic 409/422/429 errors are rolled back to the domain savepoint and cached.
   */
  classifyError?(error: unknown): OperationBusinessError | undefined;
  /** Rebuildable notifications only; required work must already be a transactional Job intent. */
  afterCommit?(output: unknown, actor: OperationActor): Promise<void>;
  policyContext?(input: unknown, actor: OperationActor, scope: ResolvedOperation): PolicyCheckRequest['context'];
  /** Separate host audit port, invoked before releasing query content; never a writable data transaction.
   * rawOutput preserves owner-private non-wire audit annotations after DTO validation. */
  readAudit?(audit: OperationReadAuditPort, input: unknown, output: unknown, actor: OperationActor, rawOutput?:unknown): Promise<void>;
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
