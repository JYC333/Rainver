import { describe, expect, it, vi } from 'vitest'
import { mergeAbortSignals } from './mergeAbortSignals'

describe('mergeAbortSignals', () => {
  it('releases all four inputs when the completed request aborts its own controller', () => {
    const controllers = Array.from({ length: 4 }, () => new AbortController())
    const removes = controllers.map(item => vi.spyOn(item.signal, 'removeEventListener'))
    mergeAbortSignals(...controllers.map(item => item.signal))
    controllers[3].abort()
    removes.forEach(remove => expect(remove).toHaveBeenCalledWith('abort', expect.any(Function)))
    expect(controllers[0].signal.aborted).toBe(false)
  })
  it('combines both lifetimes without AbortSignal.any', () => {
    const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'any')
    Object.defineProperty(AbortSignal, 'any', { value: undefined, configurable: true })
    try {
      for (const index of [0, 1]) {
        const controllers = [new AbortController(), new AbortController()]
        const combined = mergeAbortSignals(...controllers.map(item => item.signal))!
        const listener = vi.fn()
        combined.addEventListener('abort', listener)
        controllers[index].abort()
        expect(combined.aborted).toBe(true)
        controllers[1 - index].abort()
        expect(listener).toHaveBeenCalledTimes(1)
      }
      const cancelled = new AbortController()
      cancelled.abort()
      expect(mergeAbortSignals(cancelled.signal, new AbortController().signal)?.aborted).toBe(true)
    } finally {
      if (descriptor) Object.defineProperty(AbortSignal, 'any', descriptor)
      else Reflect.deleteProperty(AbortSignal, 'any')
    }
  })
})
