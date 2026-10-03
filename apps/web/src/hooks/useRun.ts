import { useState, useEffect } from 'react'
import { runsApi } from '../api/client'
import { errMsg, isNotFoundError } from '../lib/utils'
import type { Run } from '../types/api'

/** Run statuses after which polling stops; also used to refresh run sub-resources in UI. */
export const RUN_TERMINAL_STATUSES = new Set<string>([
  'succeeded',
  'failed',
  'cancelled',
  'degraded',
  'waiting_for_review',
  'waiting_for_dependency',
])

const POLL_INTERVAL_MS = 2000

interface UseRunResult {
  run: Run | null
  loading: boolean
  error: string | null
}

/**
 * Load a canonical Run once, then poll `GET /runs/{id}/status` until terminal.
 * @param reloadKey increment to force a full refetch (e.g. after POST /execute).
 */
export function useRun(runId: string | null, reloadKey: number = 0): UseRunResult {
  const [run, setRun] = useState<Run | null>(null)
  const [loading, setLoading] = useState(!!runId)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!runId) {
      setRun(null)
      setLoading(false)
      setError(null)
      return
    }
    const id = runId

    let active = true
    let intervalId: ReturnType<typeof setInterval> | undefined

    async function loadDetail() {
      try {
        setError(null)
        const data = await runsApi.get(id)
        if (!active) return
        setRun(data)
        setLoading(false)
        if (RUN_TERMINAL_STATUSES.has(data.status)) return
        startPolling()
      } catch (e) {
        if (!active) return
        setError(errMsg(e))
        setLoading(false)
      }
    }

    function startPolling() {
      intervalId = setInterval(async () => {
        try {
          const s = await runsApi.status(id)
          if (!active) return
          setRun(prev => {
            if (!prev) return prev
            return {
              ...prev,
              status: s.status,
              mode: s.mode,
              run_type: s.run_type,
              trigger_origin: s.trigger_origin,
              started_at: s.started_at ?? prev.started_at,
              ended_at: s.ended_at ?? prev.ended_at,
              error_message: s.error_message ?? prev.error_message,
            }
          })
          if (RUN_TERMINAL_STATUSES.has(s.status) && intervalId) clearInterval(intervalId)
        } catch (e) {
          if (!active) return
          // A Run that is gone ends the polling; anything else (a 502 while
          // the server restarts, a dropped connection) is retried on the next
          // tick rather than replacing the loaded Run with an error.
          if (!isNotFoundError(e)) return
          setError(errMsg(e))
          if (intervalId) clearInterval(intervalId)
        }
      }, POLL_INTERVAL_MS)
    }

    loadDetail()

    return () => {
      active = false
      if (intervalId) clearInterval(intervalId)
    }
  }, [runId, reloadKey])

  return { run, loading, error }
}
