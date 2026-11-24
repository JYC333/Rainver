import { useState, useEffect, useRef } from 'react'
import { RUN_TERMINAL_STATUS_VALUES } from '@rainver/protocol'
import { runsApi } from '../api/client'
import { errMsg, isNotFoundError } from '../lib/utils'
import type { Run } from '../types/api'

/** Run statuses after which polling stops; also used to refresh run sub-resources in UI. */
export const RUN_TERMINAL_STATUSES = new Set<string>(RUN_TERMINAL_STATUS_VALUES)

const POLL_INTERVAL_MS = 2000
const isRunAccessError = (error: unknown) =>
  isNotFoundError(error) || error instanceof Error && 'status' in error && (error.status === 401 || error.status === 403)

interface UseRunResult {
  run: Run | null
  loading: boolean
  error: string | null
}

/**
 * Load a canonical Run once, then poll `GET /runs/{id}/status` until terminal.
 * @param reloadKey increment to force a full refetch (e.g. after POST /execute).
 */
export function useRun(runId: string | null, reloadKey: number = 0, spaceId?: string): UseRunResult {
  const [run, setRun] = useState<Run | null>(null)
  const [loading, setLoading] = useState(!!runId)
  const [error, setError] = useState<string | null>(null)

  const identity = useRef({ runId, spaceId })

  useEffect(() => {
    const changed = identity.current.runId !== runId || identity.current.spaceId !== spaceId
    identity.current = { runId, spaceId }
    if (!runId) {
      setRun(null)
      setLoading(false)
      setError(null)
      return
    }
    const id = runId
    const controller = new AbortController()
    const options = { spaceId, signal: controller.signal }
    if (changed) {
      setRun(null)
      setLoading(true)
    }

    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let detailStatus: Run['status'] | undefined
    let detailAccess: Run['effective_access_level']

    async function loadDetail() {
      try {
        setError(null)
        const data = await runsApi.get(id, options)
        if (!active) return
        detailStatus = data.status
        detailAccess = data.effective_access_level
        setRun(data)
        setLoading(false)
        if (!RUN_TERMINAL_STATUSES.has(data.status)) schedulePoll()
      } catch (e) {
        if (!active) return
        if (isRunAccessError(e)) setRun(null)
        setError(errMsg(e))
        setLoading(false)
      }
    }

    function schedulePoll() {
      if (active) timer = setTimeout(poll, POLL_INTERVAL_MS)
    }

    async function poll() {
      try {
        const status = await runsApi.status(id, options)
        if (!active) return
        if (status.status !== detailStatus || status.effective_access_level !== detailAccess) {
          if (status.effective_access_level === 'summary' && detailAccess !== 'summary') setRun(null)
          // Status alone does not carry the result or structured failure.
          // Refresh canonical detail on transitions, including resumable pauses.
          const detail = await runsApi.get(id, options)
          if (!active) return
          detailStatus = detail.status
          detailAccess = detail.effective_access_level
          setRun(detail)
          if (RUN_TERMINAL_STATUSES.has(detail.status)) return
        } else {
          setRun(current => current && {
            ...current,
            model_selection: status.model_selection ?? current.model_selection,
            mode: status.mode,
            run_type: status.run_type,
            trigger_origin: status.trigger_origin,
            started_at: status.started_at ?? current.started_at,
            ended_at: status.ended_at ?? current.ended_at,
            error_message: status.error_message,
          })
        }
      } catch (e) {
        if (!active) return
        // Keep the loaded Run during temporary failures and try again.
        if (isRunAccessError(e)) {
          setRun(null)
          setError(errMsg(e))
          return
        }
      }
      schedulePoll()
    }

    loadDetail()

    return () => {
      active = false
      controller.abort()
      if (timer) clearTimeout(timer)
    }
  }, [runId, reloadKey, spaceId])

  return { run, loading, error }
}
