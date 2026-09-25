import { useEffect, useState } from 'react'
import { FileDiff, Loader2, RefreshCw, Square } from 'lucide-react'
import { artifactsApi, runsApi } from '../../api/client'
import { SpaceLink as Link } from '../../core/spaceNav'
import type { Artifact, Run } from '../../types/api'
import { Button } from '../../components/ui/button'

const TERMINAL_RUN_STATUSES = new Set(['succeeded', 'failed', 'degraded', 'cancelled', 'orphaned'])
const DIFF_ATTEMPTS = 5
const DIFF_DELAY_MS = 700

export function ConversationRunControls({
  runId,
  run: suppliedRun,
  projectId,
  onRetry,
  agentLabel,
}: {
  runId: string
  run?: Run | null
  projectId?: string | null
  onRetry?: (runId: string) => Promise<void>
  /** Whose Run these controls belong to, when one message started several. */
  agentLabel?: string
}) {
  const [run, setRun] = useState<Run | null>(suppliedRun ?? null)
  const [stopping, setStopping] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [retryError, setRetryError] = useState<string | null>(null)
  const [stopError, setStopError] = useState<string | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)

  useEffect(() => setRun(suppliedRun ?? null), [suppliedRun])
  useEffect(() => {
    if (run || !runId) return
    let cancelled = false
    void runsApi.get(runId).then(next => { if (!cancelled) setRun(next) }).catch(() => undefined)
    return () => { cancelled = true }
  }, [run, runId])

  useEffect(() => {
    if (run?.status !== 'cancelling') return
    let cancelled = false
    const poll = () => {
      void runsApi.get(runId).then(next => {
        if (!cancelled) {
          setRun(next)
          if (TERMINAL_RUN_STATUSES.has(next.status)) setStopping(false)
        }
      }).catch(() => undefined)
    }
    const timer = window.setInterval(poll, 700)
    poll()
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [run?.status, runId])

  const terminal = Boolean(run && TERMINAL_RUN_STATUSES.has(run.status))
  const active = Boolean(run && !terminal)
  const stop = async () => {
    if (!active || stopping) return
    setStopping(true)
    setStopError(null)
    try {
      await runsApi.stop(runId)
      setRun(current => current ? { ...current, status: 'cancelling' } : current)
    } catch (error) {
      setStopping(false)
      setStopError(error instanceof Error ? error.message : 'The Run could not be stopped.')
    }
  }
  const retry = async () => {
    if (!onRetry || retrying) return
    setRetrying(true)
    setRetryError(null)
    try {
      await onRetry(runId)
    } catch (error) {
      setRetryError(error instanceof Error ? error.message : 'The turn could not be retried.')
    } finally {
      setRetrying(false)
    }
  }

  return <div className="mt-2 w-full min-w-0 max-w-full space-y-2" data-testid={`conversation-run-controls-${runId}`}>
    {agentLabel && <div className="text-[11px] font-medium text-muted-foreground">{agentLabel}</div>}
    {active && (
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" role="status" aria-live="polite">
        <span>{stopping || run?.status === 'cancelling' ? 'Stopping…' : run?.status === 'queued' ? 'Queued…' : 'Working…'}</span>
        <Button type="button" size="sm" variant="outline" className="h-7" disabled={stopping || run?.status === 'cancelling'} onClick={() => void stop()}>
          <Square className="mr-1 size-3" />Stop
        </Button>
        {stopError && <span className="text-destructive" role="alert">{stopError}</span>}
      </div>
    )}
    {stopError && !active && <p className="text-xs text-destructive" role="alert">{stopError}</p>}
    {run?.status === 'cancelled' && <p className="text-xs text-muted-foreground">Turn cancelled; partial output is retained.</p>}
    {run?.status === 'failed' && onRetry && (
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" className="h-7" disabled={retrying} onClick={() => void retry()}>
          {retrying ? <Loader2 className="mr-1 size-3 animate-spin" /> : <RefreshCw className="mr-1 size-3" />}Retry turn
        </Button>
        {retryError && <span className="text-xs text-destructive" role="alert">{retryError}</span>}
      </div>
    )}
    {terminal && run && <ConversationChangesCard run={run} projectId={projectId} refreshToken={refreshToken} onRefresh={() => setRefreshToken(value => value + 1)} />}
  </div>
}

function ConversationChangesCard({ run, projectId, refreshToken, onRefresh }: {
  run: Run
  projectId?: string | null
  refreshToken: number
  onRefresh: () => void
}) {
  const [artifact, setArtifact] = useState<Artifact | null>(null)
  const [state, setState] = useState<'checking' | 'no-change' | 'ready' | 'truncated' | 'unavailable'>('checking')
  const hostRun = Boolean(run.host_task_thread_id || run.workspace_location_id)

  useEffect(() => {
    let cancelled = false
    setArtifact(null)
    if (!hostRun) {
      setState('no-change')
      return () => { cancelled = true }
    }
    setState('checking')
    void (async () => {
      for (let attempt = 0; attempt < DIFF_ATTEMPTS; attempt += 1) {
        try {
          const page = await runsApi.artifacts(run.id, { limit: '50' })
          const summary = page.items.find(item => item.artifact_type === 'remote_diff')
          if (summary) {
            const detail = await artifactsApi.get(summary.id)
            if (cancelled) return
            setArtifact(detail)
            const content = detail.content ?? ''
            const truncated = detail.metadata_json?.truncated === true
            setState(!content ? 'no-change' : truncated ? 'truncated' : 'ready')
            return
          }
        } catch {
          // A terminal Run may be readable before its Host artifact upload is.
        }
        if (attempt < DIFF_ATTEMPTS - 1) await new Promise(resolve => window.setTimeout(resolve, DIFF_DELAY_MS))
      }
      if (!cancelled) setState('unavailable')
    })()
    return () => { cancelled = true }
  }, [hostRun, refreshToken, run.id])

  const status = state === 'checking'
    ? 'Changes upload pending…'
    : state === 'no-change'
      ? 'No workspace changes recorded for this Run.'
      : state === 'unavailable'
        ? run.status === 'failed' ? 'Changes unavailable because the Run failed before its diff was uploaded.' : 'Changes are unavailable.'
        : state === 'truncated' ? 'Changes recorded (diff truncated).' : 'Changes recorded.'
  return <div className="w-full min-w-0 max-w-full rounded-md border border-border bg-muted/20 px-2.5 py-2 text-xs" data-testid={`changes-${run.id}`}>
    <div className="flex min-w-0 flex-wrap items-start gap-1.5 font-medium"><FileDiff className="mt-0.5 size-3.5 shrink-0" /><span>Changes</span><span className="min-w-0 break-words font-normal text-muted-foreground">· {status}</span></div>
    {artifact?.content && <details className="mt-1.5">
      <summary className="cursor-pointer text-muted-foreground">Preview diff</summary>
      <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded bg-background p-2 text-[10px]">{artifact.content}</pre>
    </details>}
    <div className="mt-1.5 flex flex-wrap gap-3">
      {artifact && <Link to={`/artifacts/${artifact.id}`} className="text-accent-foreground underline-offset-2 hover:underline">Open exact diff</Link>}
      {projectId && <Link to={`/projects/${projectId}/files`} className="text-accent-foreground underline-offset-2 hover:underline">Files &amp; Code</Link>}
      {state === 'unavailable' && <button type="button" className="text-accent-foreground underline-offset-2 hover:underline" onClick={onRefresh}>Check again</button>}
    </div>
  </div>
}
