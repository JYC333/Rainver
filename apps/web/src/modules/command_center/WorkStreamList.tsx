import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { SpaceLink as Link } from '../../core/spaceNav'
import { hostsApi, projectFoldersApi, runsApi } from '../../api/client'
import { errMsg } from '../../lib/utils'
import type { Host, HostTaskThread, Run } from '../../types/api'
import { Card } from '../../components/ui/card'
import { Badge, StatusBadge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Skeleton } from '../../components/ui/skeleton'
import { EmptyState } from '../../components/ui/empty-state'

interface ThreadGroup {
  thread: HostTaskThread
  projectId: string
  projectName: string | null
  folderName: string | null
  host: Host | null
  runs: Run[]
}

function fmt(dt: string | null | undefined) {
  return dt ? new Date(dt).toLocaleString() : '—'
}

function duration(run: Run): string {
  if (!run.started_at) return '—'
  const end = run.ended_at ? new Date(run.ended_at).getTime() : Date.now()
  const seconds = Math.max(0, Math.round((end - new Date(run.started_at).getTime()) / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

const ACTIVE_STATUSES = new Set(['queued', 'running'])

function threadUrl(projectId: string, thread: HostTaskThread): string {
  return `/command-center/threads/${thread.id}?project_id=${encodeURIComponent(projectId)}&folder_id=${encodeURIComponent(thread.project_folder_id)}`
}

export default function WorkStreamList({
  projectId,
  onDiagnose,
}: {
  /** C10: `null` shows the cross-project landing view; a Project id filters to it — a filter, not a gate. */
  projectId: string | null
  onDiagnose: (run: Run, folderId: string | null) => void
}) {
  const [groups, setGroups] = useState<ThreadGroup[]>([])
  const [loading, setLoading] = useState(true)
  const [runProgress, setRunProgress] = useState<Record<string, string>>({})
  const streamControllers = useRef(new Map<string, AbortController>())

  const load = useCallback(async () => {
    setLoading(true)
    try {
      if (projectId) {
        const [threadsResult, hostsResult, foldersPage, runs] = await Promise.all([
          hostsApi.listThreads(projectId),
          hostsApi.list(),
          projectFoldersApi.list(projectId, { status: 'active', limit: '200' }),
          runsApi.list({ project_id: projectId, limit: 200 }),
        ])
        const hostsById = new Map(hostsResult.items.map(h => [h.id, h]))
        const foldersById = new Map(foldersPage.items.map(f => [f.id, f]))
        const runsByThread = groupRunsByThread(runs)
        setGroups(
          threadsResult.items.map(thread => ({
            thread,
            projectId,
            projectName: null,
            folderName: foldersById.get(thread.project_folder_id)?.name ?? null,
            host: hostsById.get(thread.host_id) ?? null,
            runs: sortRunsDesc(runsByThread.get(thread.id) ?? []),
          })),
        )
      } else {
        const [threadsResult, hostsResult, runs] = await Promise.all([
          hostsApi.listRecentThreads(50),
          hostsApi.list(),
          runsApi.list({ limit: 200 }),
        ])
        const hostsById = new Map(hostsResult.items.map(h => [h.id, h]))
        const runsByThread = groupRunsByThread(runs)
        setGroups(
          threadsResult.items.map(thread => ({
            thread,
            projectId: thread.project_id,
            projectName: thread.project_name,
            folderName: thread.folder_name,
            host: hostsById.get(thread.host_id) ?? null,
            runs: sortRunsDesc(runsByThread.get(thread.id) ?? []),
          })),
        )
      }
    } catch (error) {
      toast.error(errMsg(error))
      setGroups([])
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => { load() }, [load])

  const watchRuns = useCallback((runIds: string[]) => {
    for (const runId of runIds) {
      if (streamControllers.current.has(runId)) continue
      const controller = new AbortController()
      streamControllers.current.set(runId, controller)
      void runsApi
        .streamEvents(runId, {
          signal: controller.signal,
          onLifecycle: event => {
            setRunProgress(current => ({ ...current, [runId]: event.summary ?? event.event_type }))
            if (event.event_type === 'run_finalized') {
              streamControllers.current.delete(runId)
              void load()
            }
          },
        })
        .catch(error => { if (!controller.signal.aborted) toast.error(errMsg(error)) })
        .finally(() => { if (streamControllers.current.get(runId) === controller) streamControllers.current.delete(runId) })
    }
  }, [load])

  // Only the latest run per thread can ever be active — the per-thread FIFO
  // queue (C4) guarantees at most one in-flight run at a time — so this is
  // exactly the same set the landing view's single-line-per-thread summary
  // below actually renders progress for.
  useEffect(() => {
    const activeRunIds = groups.flatMap(g => {
      const latest = g.runs[0]
      return latest && ACTIVE_STATUSES.has(latest.status) ? [latest.id] : []
    })
    watchRuns(activeRunIds)
  }, [groups, watchRuns])

  useEffect(() => {
    const controllers = streamControllers.current
    return () => { for (const controller of controllers.values()) controller.abort() }
  }, [])

  const totalRuns = useMemo(() => groups.reduce((sum, g) => sum + g.runs.length, 0), [groups])
  const nonEmptyGroups = useMemo(() => groups.filter(g => g.runs.length > 0), [groups])
  const distinctProjectCount = useMemo(() => new Set(nonEmptyGroups.map(g => g.projectId)).size, [nonEmptyGroups])

  if (loading) {
    return (
      <Card className="p-6 space-y-3">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </Card>
    )
  }

  if (groups.length === 0 || totalRuns === 0) {
    return (
      <Card>
        <EmptyState
          title="No dispatched tasks yet"
          description="Dispatch a task above to a registered host's workspace to see it here, grouped by conversation thread."
        />
      </Card>
    )
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        {nonEmptyGroups.length} {nonEmptyGroups.length === 1 ? 'thread' : 'threads'}
        {!projectId && ` across ${distinctProjectCount} ${distinctProjectCount === 1 ? 'project' : 'projects'}`}
      </p>
      <div className="space-y-3">
        {nonEmptyGroups.map(group => {
          // Landing is an overview, not a run log — one row per thread
          // summarizing its latest activity, not every message inside it
          // (the full turn-by-turn history lives on the thread's own
          // conversation page, reachable via "Open thread").
          const latest = group.runs[0]
          return (
            <Card key={group.thread.id} className="p-4 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge variant={group.host?.status === 'online' ? 'success' : 'muted'}>{group.host?.name ?? 'Unknown host'}</Badge>
                  {group.projectName && !projectId && <Badge variant="outline">{group.projectName}</Badge>}
                  <span className="text-muted-foreground">{group.folderName ?? group.thread.project_folder_id}</span>
                  {group.thread.status === 'session_reset' && (
                    <Badge variant="warning">session reset — next dispatch starts fresh</Badge>
                  )}
                </div>
                <Link to={threadUrl(group.projectId, group.thread)} className="text-xs text-accent-foreground hover:underline">
                  Open thread
                </Link>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <div className="flex flex-wrap items-center gap-2 min-w-0">
                  <StatusBadge status={latest.status} />
                  <span className="text-muted-foreground truncate">{fmt(latest.created_at)} · {duration(latest)}</span>
                  <span className="text-muted-foreground">· {group.runs.length} {group.runs.length === 1 ? 'message' : 'messages'}</span>
                  {ACTIVE_STATUSES.has(latest.status) && runProgress[latest.id] && (
                    <span className="text-muted-foreground truncate max-w-[16rem]">{runProgress[latest.id]}</span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {latest.status === 'failed' && (
                    <Button size="sm" variant="outline" onClick={() => onDiagnose(latest, group.thread.project_folder_id)}>
                      Dispatch diagnostic run
                    </Button>
                  )}
                  {ACTIVE_STATUSES.has(latest.status) && <CancelRunButton runId={latest.id} onDone={load} />}
                </div>
              </div>
            </Card>
          )
        })}
      </div>
    </div>
  )
}

function groupRunsByThread(runs: Run[]): Map<string, Run[]> {
  const runsByThread = new Map<string, Run[]>()
  for (const run of runs) {
    if (!run.host_task_thread_id) continue
    const list = runsByThread.get(run.host_task_thread_id) ?? []
    list.push(run)
    runsByThread.set(run.host_task_thread_id, list)
  }
  return runsByThread
}

function sortRunsDesc(runs: Run[]): Run[] {
  return [...runs].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
}

function CancelRunButton({ runId, onDone }: { runId: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  async function stop() {
    setBusy(true)
    try {
      await runsApi.stop(runId)
      toast.success('Stop requested')
      onDone()
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Button size="sm" variant="destructive" onClick={stop} disabled={busy}>
      {busy ? '…' : 'Cancel'}
    </Button>
  )
}
