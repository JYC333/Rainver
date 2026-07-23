import { describe, expect, it, vi } from 'vitest'
import { createOptimisticTreeMutationQueue } from '../treeMutationQueue'

describe('createOptimisticTreeMutationQueue', () => {
  it('applies every move immediately while serializing persistence', async () => {
    const events: string[] = []
    let releaseFirst!: () => void
    const firstPersist = new Promise<void>(resolve => { releaseFirst = resolve })
    const queue = createOptimisticTreeMutationQueue(vi.fn())

    queue.enqueue({
      key: 'collections',
      apply: () => events.push('apply-1'),
      persist: async () => {
        events.push('persist-1')
        await firstPersist
      },
      reconcile: vi.fn(),
    })
    queue.enqueue({
      key: 'notes',
      apply: () => events.push('apply-2'),
      persist: async () => { events.push('persist-2') },
      reconcile: vi.fn(),
    })

    expect(events).toEqual(['apply-1', 'apply-2'])
    await Promise.resolve()
    expect(events).toEqual(['apply-1', 'apply-2', 'persist-1'])

    releaseFirst()
    await queue.whenIdle()
    expect(events).toEqual(['apply-1', 'apply-2', 'persist-1', 'persist-2'])
  })

  it('reconciles each failed domain once at the queue tail', async () => {
    const onError = vi.fn()
    const reconcileCollections = vi.fn(async () => undefined)
    const reconcileNotes = vi.fn(async () => undefined)
    const queue = createOptimisticTreeMutationQueue(onError)

    queue.enqueue({
      key: 'collections',
      apply: vi.fn(),
      persist: async () => { throw new Error('collections failed') },
      reconcile: reconcileCollections,
    })
    queue.enqueue({
      key: 'collections',
      apply: vi.fn(),
      persist: async () => { throw new Error('collections failed again') },
      reconcile: reconcileCollections,
    })
    queue.enqueue({
      key: 'notes',
      apply: vi.fn(),
      persist: async () => { throw new Error('notes failed') },
      reconcile: reconcileNotes,
    })

    await queue.whenIdle()

    expect(onError).toHaveBeenCalledTimes(3)
    expect(reconcileCollections).toHaveBeenCalledTimes(1)
    expect(reconcileNotes).toHaveBeenCalledTimes(1)
  })

  it('reapplies a drag enqueued while failure reconciliation is in flight', async () => {
    let state = 0
    let reconciliationStarted!: () => void
    let releaseReconciliation!: () => void
    const started = new Promise<void>(resolve => { reconciliationStarted = resolve })
    const release = new Promise<void>(resolve => { releaseReconciliation = resolve })
    const queue = createOptimisticTreeMutationQueue(vi.fn())

    queue.enqueue({
      key: 'collections',
      apply: () => { state = 1 },
      persist: async () => { throw new Error('failed') },
      reconcile: async () => {
        reconciliationStarted()
        await release
        state = 0
      },
    })
    await started

    queue.enqueue({
      key: 'collections',
      apply: () => { state = 2 },
      persist: async () => undefined,
      reconcile: async () => undefined,
    })
    expect(state).toBe(2)

    releaseReconciliation()
    await queue.whenIdle()
    expect(state).toBe(2)
  })
})
