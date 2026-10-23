import { mergeAbortSignals } from '../../lib/mergeAbortSignals'
import { useCallback, useEffect, useRef, useState } from 'react'
import { authorizationRequestsApi, runsApi, type RequestOptions } from '../../api/client'
import type { AuthorizationRequest, Run } from '../../types/api'
import { errMsg } from '../../lib/utils'

export type RunAction = { kind: 'stop' | 'resume' | 'abandon'; reason?: string }
  | { kind: 'quota_recovery'; autoContinue: boolean }
  | { kind: 'approve' | 'reject'; requestId: string }

/** Authorization holds are reconciled by their own endpoint, never generic resume. */
export function hasRunAuthorizationPause(run: Run, requests: readonly AuthorizationRequest[]): boolean {
  const id = run.error_json?.authorization_request_id
  return Boolean((typeof id === 'string' && id.trim()) || requests.some(request => request.status === 'pending'))
}

/** Run commands shared by the detail page and conversation controls. */
export function useRunActions(runId: string, scope: RequestOptions, onChanged: (run: Run) => void | Promise<void>) {
  const [busy, setBusy] = useState<RunAction | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** The command succeeded, but rereading the Run afterwards failed. */
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const generation = useRef(0)
  const pending = useRef<AbortController | null>(null)
  const changed = useRef(onChanged)
  changed.current = onChanged
  const identity = `${scope.spaceId ?? ''}:${runId}`
  const currentIdentity = useRef(identity)
  currentIdentity.current = identity

  useEffect(() => {
    setBusy(null)
    setError(null)
    setRefreshError(null)
    return () => {
      generation.current += 1
      pending.current?.abort()
      pending.current = null
    }
  }, [identity, scope.signal])

  const perform = useCallback(async (action: RunAction): Promise<boolean> => {
    if (!runId || pending.current || scope.signal?.aborted) return false
    const token = generation.current
    const controller = new AbortController()
    pending.current = controller
    const options = { ...scope, signal: mergeAbortSignals(scope.signal, controller.signal) }
    const current = () => !options.signal?.aborted && generation.current === token && currentIdentity.current === identity
    setBusy(action)
    setError(null)
    setRefreshError(null)
    try {
      try {
        switch (action.kind) {
          case 'stop': await runsApi.stop(runId, options); break
          case 'quota_recovery': await runsApi.quotaRecovery(runId, action.autoContinue, options); break
          case 'resume': await runsApi.resume(runId, options); break
          case 'abandon': await runsApi.abandon(runId, { reason: action.reason }, options); break
          // Authorization reconciliation queues the Run itself. Never also call resume.
          case 'approve': await authorizationRequestsApi.approve(action.requestId, options); break
          case 'reject': await authorizationRequestsApi.reject(action.requestId, options); break
        }
      } catch (cause) {
        if (current()) setError(errMsg(cause))
        return false
      }
      if (!current()) return false
      // The command is applied. A failed reread is reported separately so the
      // person is not invited to repeat a command that already took effect.
      try {
        const run = await runsApi.get(runId, options)
        if (current()) await changed.current(run)
      } catch (cause) {
        if (current()) setRefreshError(errMsg(cause))
      }
      return current()
    } finally {
      if (pending.current === controller) pending.current = null
      if (current()) setBusy(null)
      controller.abort()
    }
  }, [runId, scope, identity])
  return { perform, busy, error, refreshError }
}
