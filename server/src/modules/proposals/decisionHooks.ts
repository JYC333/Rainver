import type {OperationActor} from '@rainver/protocol';
import type {Queryable} from "../routeUtils/common.js";
import type { ProposalApplyResult } from './applierRegistry.js';
/** Host integration seam; canonical proposal authorization/application remains here. */
export interface ProposalDecisionHooks {
  /** `false` withholds the decision. An accept may instead receive a result that is returned
   * without applying or finalizing the Proposal (an expired linked request, committed as such). */
  beforeDecision(db: Queryable, proposalId: string, identity: {
    spaceId: string;
    userId: string;
  }, decision: 'accept' | 'reject'): Promise<boolean | ProposalApplyResult>;
  applyFailed?(db: Queryable, proposalId: string, error: unknown): Promise<ProposalApplyResult>;
  usesAtomicAudit?(db: Queryable, proposalId: string): Promise<boolean>;
  runApply?(db: Queryable, proposalId: string, apply: (db:Queryable, requester?:OperationActor) => Promise<ProposalApplyResult>): Promise<ProposalApplyResult>;
  /** `false` withholds the decision (nothing is written); a result decides the Proposal without
   * applying it (for example `superseded` when frozen preconditions no longer hold). */
  beforeApply?(db: Queryable, proposalId: string): Promise<boolean | void | ProposalApplyResult>;
  afterApply(db: Queryable, proposalId: string, result: ProposalApplyResult): Promise<void>;
  afterReject(db: Queryable, proposalId: string): Promise<void>;
  /** A replay of an accepting `proposal.accept` receipt: the linked request's result gate, live.
   * `resultType` is the stored receipt's own `result_type`; only `operation_failure` proves linkage.
   * Origin after retention has pruned the request is `proposals.operation_request_linked`. */
  authorizeAcceptReplay?(db: Queryable, proposalId: string, identity: {spaceId: string; userId: string}, stored: {resultType?: string}): Promise<void>;
}
