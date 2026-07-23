export interface OptimisticTreeMutation {
  /** Stable domain key used to coalesce failed reconciliations. */
  key: string
  /** Runs synchronously so the tree reflects the mutation before any network wait. */
  apply: () => void
  /** Persists the authoritative mutation. */
  persist: () => Promise<void>
  /** Reloads this domain after a failed persistence attempt. */
  reconcile: () => Promise<void>
  /** Optional non-blocking work after persistence succeeds. */
  afterSuccess?: () => void
}

export interface OptimisticTreeMutationQueue {
  enqueue: (operation: OptimisticTreeMutation) => void
  /** Test/diagnostic boundary; product code does not need to await mutations. */
  whenIdle: () => Promise<void>
}

/**
 * Shared optimistic mutation pipeline for the Notes tree.
 *
 * UI changes apply immediately, while writes are serialized so create,
 * reorder, rename, hide, and delete operations cannot commit out of order.
 * Failed domains reconcile only after the current queue tail, preventing an
 * older failure from overwriting a newer optimistic mutation with stale data.
 */
export function createOptimisticTreeMutationQueue(
  onError: (error: unknown) => void,
): OptimisticTreeMutationQueue {
  let tail = Promise.resolve()
  let sequence = 0
  const failedDomains = new Map<string, () => Promise<void>>()
  const pendingApplies = new Map<number, () => void>()

  return {
    enqueue(operation) {
      const operationSequence = ++sequence
      pendingApplies.set(operationSequence, operation.apply)
      operation.apply()

      const run = async () => {
        let succeeded = false
        try {
          await operation.persist()
          succeeded = true
        } catch (error) {
          failedDomains.set(operation.key, operation.reconcile)
          onError(error)
        }
        if (succeeded) operation.afterSuccess?.()
        pendingApplies.delete(operationSequence)

        if (operationSequence === sequence && failedDomains.size > 0) {
          const reconciles = [...failedDomains.values()]
          failedDomains.clear()
          await Promise.all(reconciles.map(reconcile => reconcile()))
          // A mutation can be enqueued while reconciliation is in flight. Its
          // persistence is still waiting behind this task, so restore its
          // optimistic projection after the server snapshot lands.
          for (const apply of pendingApplies.values()) apply()
        }
      }

      tail = tail.then(run, run)
    },
    whenIdle: () => tail,
  }
}
