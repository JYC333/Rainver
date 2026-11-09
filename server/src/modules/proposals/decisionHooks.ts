import type {Queryable} from "../routeUtils/common.js";
import type { PoolClient } from '../../db/pool.js';
import type { ProposalApplyResult } from './applierRegistry.js';
/** Host integration seam; canonical proposal authorization/application remains here. */
export interface ProposalDecisionHooks {
  beforeDecision(db: PoolClient, proposalId: string, identity: {
    spaceId: string;
    userId: string;
  }, decision: 'accept' | 'reject'): Promise<boolean>;
  applyFailed?(db: PoolClient, proposalId: string, error: unknown): Promise<ProposalApplyResult>;
  usesAtomicAudit?(db: PoolClient, proposalId: string): Promise<boolean>;
  runApply?(db: PoolClient, proposalId: string, apply: (db:Queryable) => Promise<ProposalApplyResult>): Promise<ProposalApplyResult>;
  beforeApply?(db: PoolClient, proposalId: string): Promise<boolean | void>;
  afterApply(db: PoolClient, proposalId: string, result: ProposalApplyResult): Promise<void>;
  afterReject(db: PoolClient, proposalId: string): Promise<void>;
}
