import type { Queryable, RunRecord } from "./runRepositoryTypes.js";

export interface RunFinalizationReconciler {
  reconcile(db: Queryable, run: RunRecord): Promise<void>;
}

class RunFinalizationReconcilerRegistry {
  private readonly reconcilers = new Map<string, { reconciler: RunFinalizationReconciler; owner: string }>();

  register(key: string, reconciler: RunFinalizationReconciler, owner: string): void {
    if (!key.trim()) throw new Error("key must be non-empty");
    if (!owner.trim()) throw new Error("owner must be non-empty");
    const existing = this.reconcilers.get(key);
    if (existing && existing.owner !== owner) {
      throw new Error(`${key} is already registered by ${existing.owner}`);
    }
    this.reconcilers.set(key, { reconciler, owner });
  }

  async reconcileAll(db: Queryable, run: RunRecord): Promise<void> {
    for (const { reconciler } of this.reconcilers.values()) {
      await reconciler.reconcile(db, run);
    }
  }

  registeredKeys(): ReadonlySet<string> {
    return new Set(this.reconcilers.keys());
  }

  __resetForTests(): void {
    this.reconcilers.clear();
  }
}

export const runFinalizationReconcilerRegistry = new RunFinalizationReconcilerRegistry();
