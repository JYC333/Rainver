import type { Queryable, RunRecord } from "./runRepositoryTypes.js";

interface RunFinalizationReconciler {
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

  /**
   * The registered reconcilers, each keyed so settlement can record which
   * completed (`finalizationService.ts`). They settle unrelated things — Task
   * status, autonomy candidates, a follow-up Task — so settlement runs every
   * one even when another fails, and the completion gate waits for all.
   */
  entries(): ReadonlyArray<{ key: string; reconcile: RunFinalizationReconciler["reconcile"] }> {
    return [...this.reconcilers.entries()].map(([key, { reconciler }]) => ({
      key,
      reconcile: (db, run) => reconciler.reconcile(db, run),
    }));
  }

  registeredKeys(): ReadonlySet<string> {
    return new Set(this.reconcilers.keys());
  }

  __resetForTests(): void {
    this.reconcilers.clear();
  }
}

export const runFinalizationReconcilerRegistry = new RunFinalizationReconcilerRegistry();
