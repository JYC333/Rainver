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

  /**
   * Each reconciler is isolated. They settle unrelated things — Task status,
   * autonomy candidates, a follow-up Task — and a transient failure in the
   * one that happens to be registered first must not silently skip the rest,
   * which a bare loop inside a best-effort caller would do.
   */
  async reconcileAll(db: Queryable, run: RunRecord): Promise<void> {
    for (const [key, { reconciler }] of this.reconcilers.entries()) {
      try {
        await reconciler.reconcile(db, run);
      } catch (error) {
        process.stderr.write(
          `[runs] finalization reconciler ${key} failed for run ${run.id}: `
          + `${String((error as Error)?.message ?? error)}\n`,
        );
      }
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
