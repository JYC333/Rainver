import type { Queryable, RunRecord } from "./runRepositoryTypes";

export interface RunFinalizationReconciler {
  reconcile(db: Queryable, run: RunRecord): Promise<void>;
}

class RunFinalizationReconcilerRegistry {
  private readonly reconcilers = new Map<string, RunFinalizationReconciler>();

  register(key: string, reconciler: RunFinalizationReconciler): void {
    this.reconcilers.set(key, reconciler);
  }

  async reconcileAll(db: Queryable, run: RunRecord): Promise<void> {
    for (const reconciler of this.reconcilers.values()) {
      await reconciler.reconcile(db, run);
    }
  }

  __resetForTests(): void {
    this.reconcilers.clear();
  }
}

export const runFinalizationReconcilerRegistry = new RunFinalizationReconcilerRegistry();
