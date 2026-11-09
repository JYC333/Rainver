import { CodePatchFileTransaction, type CodePatchEffectOperation } from './codePatch.js';
import type { SnapshotFile } from './snapshotStore.js';
import type { CodePatchEffectReceipt } from './codePatchEffectContext.js';
/** Existing bundle/standalone effect boundary. Persist preimages before any write;
 * exact desired-content recovery handles a lost receipt, never a blind reapply. */
export interface PreparedCodePatchEffect {
  folderId: string;
  root: string;
  protectedFolder: boolean;
  operations: CodePatchEffectOperation[];
  before: SnapshotFile[];
  receipt?: CodePatchEffectReceipt;
  compensated?: boolean;
}
export async function applyPreparedCodePatchEffect(effect: PreparedCodePatchEffect, payloadHash: string, save: () => Promise<void>, assertLease: () => Promise<void>) {
  const files = new CodePatchFileTransaction(effect.root, effect.protectedFolder);
  if (!effect.before.length) {
    effect.before = await files.prepare(effect.operations);
    await save();
  }
  await assertLease();
  const applied = await files.applyPrepared(effect.operations, effect.before);
  effect.receipt = {
    payloadHash,
    root: effect.root,
    protectedFolder: effect.protectedFolder,
    before: effect.before,
    applied,
    removedPaths: effect.operations.filter(op => op.type === 'remove_file').map(op => op.path),
    completedAt: effect.receipt?.completedAt ?? new Date().toISOString()
  };
  await save();
}
export async function compensateCodePatchEffect(effect: PreparedCodePatchEffect, save: () => Promise<void>) {
  if (effect.compensated || !effect.before.length) return;
  await new CodePatchFileTransaction(effect.root, effect.protectedFolder).compensatePrepared(effect.operations, effect.before);
  effect.compensated = true;
  await save();
}
