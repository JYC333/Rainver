import type {Queryable} from "../routeUtils/common.js";
import type { ProposalApplyResult } from './applierRegistry.js';
/** Host integration seam; canonical proposal authorization/application remains here. */
export interface ProposalDecisionHooks {
  beforeDecision(db: Queryable, proposalId: string, identity: {
    spaceId: string;
    userId: string;
  }, decision: 'accept' | 'reject'): Promise<boolean>;
  applyFailed?(db: Queryable, proposalId: string, error: unknown): Promise<ProposalApplyResult>;
  usesAtomicAudit?(db: Queryable, proposalId: string): Promise<boolean>;
  runApply?(db: Queryable, proposalId: string, apply: (db:Queryable) => Promise<ProposalApplyResult>): Promise<ProposalApplyResult>;
  beforeApply?(db: Queryable, proposalId: string): Promise<boolean | void>;
  afterApply(db: Queryable, proposalId: string, result: ProposalApplyResult): Promise<void>;
  afterReject(db: Queryable, proposalId: string): Promise<void>;
}
