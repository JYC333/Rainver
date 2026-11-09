/**
 * At most `limit` calls of `run` in flight; the rest wait in arrival order.
 * One limiter per panel bounds automatic and manual refreshes together, so a
 * click during a page refresh waits for a slot instead of adding a fourth
 * probe.
 */
export function createLimiter(limit: number): <R>(work: () => Promise<R>) => Promise<R> {
  let active = 0
  const waiting: Array<() => void> = []
  return async work => {
    while (active >= limit) await new Promise<void>(resolve => waiting.push(resolve))
    active++
    try { return await work() } finally { active--; waiting.shift()?.() }
  }
}

/**
 * Runs `work` over `items` with at most `limit` in flight. One slow quota
 * source then delays only its own result rather than every source behind it,
 * and a page entry never fans out to every account at once. `stopped` ends
 * the queue between items; work already started finishes on its own.
 */
export async function runLimited<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>, stopped: () => boolean = () => false): Promise<void> {
  let next = 0
  const worker = async () => {
    while (next < items.length && !stopped()) await work(items[next++]!)
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}
