import { registerInMemoryResidue, sessionEpoch } from '../lib/sessionResidue'
import { ApiRequestError } from './transport'

export const READ_PENDING = Symbol('read pending')

interface PollReadOptions {
  signal?: AbortSignal
  epoch?: number
  timeoutMs: number
  intervalMs: number
  maxIntervalMs?: number
  sessionChanged: string
  timedOut: () => Error
  retryRead?: (error: unknown) => boolean
}

/** Wait on an already accepted command using authorized reads. The browser's
 * deadline and cancellation never resubmit or cancel the durable command. */
export async function pollRead<State, Result>(
  options: PollReadOptions,
  read: (signal: AbortSignal) => Promise<State>,
  inspect: (state: State, signal: AbortSignal) => Result | typeof READ_PENDING | Promise<Result | typeof READ_PENDING>,
): Promise<Result> {
  const epoch = options.epoch ?? sessionEpoch()
  const controller = new AbortController()
  const signal = controller.signal
  const cancel = () => controller.abort(options.signal?.reason ?? new DOMException('Aborted', 'AbortError'))
  const sessionChanged = () => controller.abort(new ApiRequestError(options.sessionChanged, 401, 'authentication_required'))
  if (options.signal?.aborted) cancel()
  if (sessionEpoch() !== epoch) sessionChanged()
  signal.throwIfAborted()

  options.signal?.addEventListener('abort', cancel, { once: true })
  const unregister = registerInMemoryResidue(sessionChanged)
  const timer = setTimeout(() => controller.abort(options.timedOut()), options.timeoutMs)
  const interrupted = new Promise<never>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })

  async function run(): Promise<Result> {
    let delay = options.intervalMs
    for (;;) {
      signal.throwIfAborted()
      let state: State
      try {
        state = await read(signal)
      } catch (error) {
        signal.throwIfAborted()
        if (!options.retryRead?.(error)) throw error
        await pause()
        continue
      }
      signal.throwIfAborted()
      const result = await inspect(state, signal)
      signal.throwIfAborted()
      if (result !== READ_PENDING) return result
      await pause()
    }

    async function pause() {
      await new Promise<void>(resolve => {
        const finish = () => {
          clearTimeout(timer)
          signal.removeEventListener('abort', finish)
          resolve()
        }
        const timer = setTimeout(finish, delay)
        signal.addEventListener('abort', finish, { once: true })
      })
      delay = Math.min(delay * 2, options.maxIntervalMs ?? options.intervalMs)
    }
  }

  try {
    return await Promise.race([run(), interrupted])
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', cancel)
    unregister()
  }
}
