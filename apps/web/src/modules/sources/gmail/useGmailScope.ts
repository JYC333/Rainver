import { useCallback, useEffect, useRef } from 'react'

export type GmailScoped<T> = { ok: true; value: T } | { ok: false; error: unknown }

type Scope = { key: string; controllers: Set<AbortController>; latest: Map<string, AbortController>; keys: Map<string, string> }
const scopeOf = (key: string, keys = new Map<string, string>()): Scope => ({ key, controllers: new Set(), latest: new Map(), keys })
const abortAll = (scope: Scope) => { for (const controller of scope.controllers) controller.abort() }

/**
 * One abort-and-ignore boundary per scope (person, Space, Project, connection,
 * selection — whatever the caller folds into `scopeKey`). A call's reply is
 * delivered only while its generation is current: when the key changes, or the
 * caller `invalidate()`s after a refusal that clears content, every call
 * started before is aborted and its late reply or failure resolves to `null`,
 * so it can never restore content or an error. Components keep their content
 * tagged with the key and render it only while the tag matches, so old mail
 * disappears in the same render the scope changes.
 *
 * `run(call, channel)` makes the call the only live one on that channel (a list
 * read, a search): starting a newer one aborts the older, so a slow first read
 * can never overwrite the refresh that followed a write.
 *
 * `keyFor(intent)` keeps one idempotency key per write intent until
 * `settle(intent)` (also across `invalidate`): a retry of the same intent after a
 * lost reply replays the server receipt instead of issuing a second command.
 */
export function useGmailScope(scopeKey: string) {
  const state = useRef(scopeOf(scopeKey))
  if (state.current.key !== scopeKey) {
    abortAll(state.current)
    state.current = scopeOf(scopeKey)
  }
  useEffect(() => () => abortAll(state.current), [])

  const run = useCallback(async <T,>(call: (signal: AbortSignal) => Promise<T>, channel?: string): Promise<GmailScoped<T> | null> => {
    const scope = state.current
    const controller = new AbortController()
    scope.controllers.add(controller)
    if (channel) { scope.latest.get(channel)?.abort(); scope.latest.set(channel, controller) }
    const current = () => state.current === scope && !controller.signal.aborted
    try {
      const value = await call(controller.signal)
      return current() ? { ok: true, value } : null
    } catch (error) {
      return current() ? { ok: false, error } : null
    } finally {
      scope.controllers.delete(controller)
      if (channel && scope.latest.get(channel) === controller) scope.latest.delete(channel)
    }
  }, [])

  /** Starts a new generation in the same scope: nothing started before can deliver. */
  const invalidate = useCallback(() => {
    abortAll(state.current)
    state.current = scopeOf(state.current.key, state.current.keys)
  }, [])

  const keyFor = useCallback((intent: string) => {
    const keys = state.current.keys
    let key = keys.get(intent)
    if (!key) { key = crypto.randomUUID(); keys.set(intent, key) }
    return key
  }, [])
  const settle = useCallback((intent: string) => { state.current.keys.delete(intent) }, [])

  // A second click on the same intent while the first is in flight does nothing,
  // even before the disabled state has rendered.
  const inFlight = useRef(new Set<string>())
  const exclusive = useCallback(async (intent: string, call: () => Promise<void>): Promise<void> => {
    if (inFlight.current.has(intent)) return
    inFlight.current.add(intent)
    try { await call() } finally { inFlight.current.delete(intent) }
  }, [])

  return { run, invalidate, keyFor, settle, exclusive }
}
