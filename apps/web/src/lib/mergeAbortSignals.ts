/** Combine request lifetimes without requiring AbortSignal.any in older browsers. */
export function mergeAbortSignals(...values: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const signals = [...new Set(values.filter((signal): signal is AbortSignal => Boolean(signal)))]
  if (signals.length < 2) return signals[0]
  const controller = new AbortController()
  const abort = () => {
    controller.abort()
    signals.forEach(signal => signal.removeEventListener('abort', abort))
  }
  signals.forEach(signal => signal.addEventListener('abort', abort, { once: true }))
  if (signals.some(signal => signal.aborted)) abort()
  return controller.signal
}
