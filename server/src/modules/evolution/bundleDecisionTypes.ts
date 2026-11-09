import type { CodePatchOperation } from '../projectFolders/codePatch.js';
import type { CodePatchEffectReceipt } from '../projectFolders/codePatchEffectContext.js';
import type { SnapshotFile } from '../projectFolders/snapshotStore.js';
export const EVOLUTION_BUNDLE_DECISION_JOB = 'evolution_bundle_decision';
export interface FrozenBundleMember {
  proposalId: string;
  decision: 'approve' | 'reject';
  note: string | null;
  payload: Record<string, unknown>;
  payloadHash: string;
  proposalType: string;
}
export interface BundlePatchEffect {
  folderId: string;
  root: string;
  protectedFolder: boolean;
  operations: CodePatchOperation[];
  before: SnapshotFile[];
  receipt?: CodePatchEffectReceipt;
  compensated?: boolean;
}
export interface BundleDecisionRow {
  id: string;
  space_id: string;
  bundle_id: string;
  user_id: string;
  fingerprint: string;
  status: string;
  job_id: string | null;
  frozen_json: FrozenBundleMember[];
  effects_json: Record<string, BundlePatchEffect>;
  result_json: Record<string, unknown> | null;
  error: string | null;
}
