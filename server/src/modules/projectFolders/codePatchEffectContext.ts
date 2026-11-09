import { AsyncLocalStorage } from 'node:async_hooks';
import type { SnapshotFile } from './snapshotStore.js';
export interface CodePatchEffectReceipt {
  payloadHash: string;
  root: string;
  protectedFolder: boolean;
  before: SnapshotFile[];
  applied: Array<{
    path: string;
    sha256: string;
  }>;
  completedAt: string;
  removedPaths?:string[];
}
// Internal worker-to-canonical-applier capability. Never read from a DTO/payload.
const receipts = new AsyncLocalStorage<ReadonlyMap<string, CodePatchEffectReceipt>>();
export function withCodePatchEffectReceipts<T>(values: ReadonlyMap<string, CodePatchEffectReceipt>, work: () => Promise<T>): Promise<T> {
  return receipts.run(values, work);
}
export function codePatchEffectReceipt(id: string) {
  return receipts.getStore()?.get(id);
}

const decisionAudit=new AsyncLocalStorage<{decision_id:string;decision_phase:string}>();
export const codePatchDecisionAudit=()=>decisionAudit.getStore()??{};
export function withCodePatchDecisionAudit<T>(id:string,phase:string,work:()=>Promise<T>):Promise<T>{return decisionAudit.run({decision_id:id,decision_phase:phase},work);}
