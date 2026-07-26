import { useState, useEffect, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { SpaceLink as Link } from '../../core/spaceNav'
import { Play, FolderKanban, X } from 'lucide-react'
import { toast } from 'sonner'
import { agentsApi, runsApi } from '../../api/client'
import { useSpace } from '../../contexts/SpaceContext'
import { errMsg } from '../../lib/utils'
import type { AgentOut, Run } from '../../types/api'
import { Card } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { Badge, StatusBadge } from '../../components/ui/badge'
import { Label } from '../../components/ui/label'
import { Select } from '../../components/ui/select'
import { Skeleton } from '../../components/ui/skeleton'
import { PreviewBadge } from '../../components/PreviewBadge'
import { ScopeBadge } from '../../components/ScopeBadge'
import { ProjectFolderSelectors } from '../../components/ProjectFolderSelectors'

function fmt(dt: string | null | undefined) {
  return dt ? new Date(dt).toLocaleString() : '—'
}

function RunRow({ r, agentName, onRefresh }: { r: Run; agentName: string | null; onRefresh: () => void }) {
  return (
    <Card className="p-4 flex flex-wrap items-start justify-between gap-3">
      <div className="space-y-2 min-w-0 flex-1">
        <div className="flex flex-wrap gap-1.5 items-center">
          <StatusBadge status={r.status} />
          <Badge variant="secondary">{r.mode}</Badge>
          {r.run_type && <Badge variant="outline">{r.run_type}</Badge>}
          {r.mode === 'dry_run' && <PreviewBadge />}
          <ScopeBadge visibility={r.visibility} omitShared />
        </div>
        {(r.instruction || r.prompt) && <p className="text-sm font-medium">{r.instruction ?? r.prompt}</p>}
        <p className="text-xs text-muted-foreground">
          {agentName ?? 'Agent unavailable'} · created {fmt(r.created_at)}
          {r.started_at && ` · started ${fmt(r.started_at)}`}
          {r.ended_at && ` · ended ${fmt(r.ended_at)}`}
        </p>
        {r.task_id && (
          <Link to={`/tasks/${r.task_id}`} className="text-xs text-accent-foreground hover:underline">
            Open linked task
          </Link>
        )}
        {r.status === 'failed' && r.error_message && (
          <p className="text-xs text-destructive border border-destructive/20 rounded p-2 bg-destructive/5">
            {r.error_message}
          </p>
        )}
      </div>
      <div className="flex flex-col gap-2 shrink-0">
        <Button size="sm" variant="outline" asChild>
          <Link to={`/runs/${r.id}`}>Open</Link>
        </Button>
        {(r.status === 'queued' || r.status === 'running') && (
          <StopRunButton runId={r.id} onDone={onRefresh} />
        )}
      </div>
    </Card>
  )
}

function StopRunButton({ runId, onDone }: { runId: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  async function stop() {
    setBusy(true)
    try {
      await runsApi.stop(runId)
      toast.success('Stop requested')
      onDone()
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Button size="sm" variant="destructive" onClick={stop} disabled={busy}>
      {busy ? '…' : 'Stop'}
    </Button>
  )
}

export default function RunsPage() {
  const { activeSpaceId, activeSpaceName, preferredSpaceId, spaces } = useSpace()
  const [searchParams, setSearchParams] = useSearchParams()
  const projectFilter = searchParams.get('project_id') ?? ''
  const browsingSpaceId = activeSpaceId ?? preferredSpaceId
  const browsingSpaceName = activeSpaceName ?? spaces.find(s => s.id === browsingSpaceId)?.name ?? null

  const [runs, setRuns] = useState<Run[]>([])
  const [agents, setAgents] = useState<AgentOut[]>([])
  const [loading, setLoading] = useState(true)
  const [fStatus, setFStatus] = useState('')
  const [fMode, setFMode] = useState('')
  const [fAgent, setFAgent] = useState('')
  const [fWs, setFWs] = useState('')

  const load = useCallback(async () => {
    if (!browsingSpaceId) {
      setRuns([])
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const data = await runsApi.list({
        limit: 100,
        status: fStatus || undefined,
        mode: fMode || undefined,
        agent_id: fAgent || undefined,
        project_folder_id: fWs || undefined,
        project_id: projectFilter || undefined,
      })
      setRuns(data)
    } catch (e) {
      toast.error(errMsg(e))
      setRuns([])
    } finally {
      setLoading(false)
    }
  }, [fStatus, fMode, fAgent, fWs, projectFilter, browsingSpaceId])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    if (!browsingSpaceId) return
    agentsApi.list({ limit: '200', status: 'active' }).then(setAgents).catch(error => toast.error(errMsg(error)))
  }, [browsingSpaceId])

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-4 pb-4 border-b border-border">
        <div
          className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
          style={{
            background: 'color-mix(in oklch, var(--primary) 12%, transparent)',
            border: '1px solid color-mix(in oklch, var(--primary) 35%, transparent)',
          }}
        >
          <Play className="size-5 text-accent-foreground" />
        </div>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Runs</h1>
          <p className="text-sm text-muted-foreground">Canonical runs: queue, status, and links to activity and artifacts.</p>
          <p className="text-xs text-muted-foreground">Viewing: {browsingSpaceName ?? browsingSpaceId ?? 'No operational space selected'}</p>
          {projectFilter && (
            <span className="inline-flex items-center gap-1 mt-0.5 px-2 py-0.5 rounded-full bg-accent/40 text-xs text-accent-foreground">
              <FolderKanban className="size-3" />
              Filtered by project
              <button onClick={() => setSearchParams(p => { p.delete('project_id'); return p })} className="ml-0.5 hover:text-foreground" aria-label="Clear project filter">
                <X className="size-3" />
              </button>
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-3 items-end">
        <div className="min-w-[120px]">
          <Label className="text-xs">Status</Label>
          <Select
            value={fStatus}
            options={[
              { value: '', label: 'Any' },
              { value: 'queued', label: 'queued' },
              { value: 'running', label: 'running' },
              { value: 'succeeded', label: 'succeeded' },
              { value: 'failed', label: 'failed' },
              { value: 'cancelled', label: 'cancelled' },
              { value: 'degraded', label: 'degraded' },
              { value: 'waiting_for_review', label: 'waiting_for_review' },
            ]}
            onChange={setFStatus}
          />
        </div>
        <div className="min-w-[120px]">
          <Label className="text-xs">Mode</Label>
          <Select
            value={fMode}
            options={[
              { value: '', label: 'Any' },
              { value: 'live', label: 'live' },
              { value: 'dry_run', label: 'dry_run' },
            ]}
            onChange={setFMode}
          />
        </div>
        <div className="min-w-[140px]">
          <Label className="text-xs">Agent</Label>
          <Select
            value={fAgent}
            options={[{ value: '', label: 'Any Agent' }, ...agents.map(agent => ({ value: agent.id, label: agent.name }))]}
            onChange={setFAgent}
          />
        </div>
        <div className="grid min-w-[360px] grid-cols-2 gap-2">
          <ProjectFolderSelectors
            projectId={projectFilter}
            folderId={fWs}
            onProjectChange={value => setSearchParams(params => {
              if (value) params.set('project_id', value)
              else params.delete('project_id')
              return params
            })}
            onFolderChange={setFWs}
            projectLabel="Project"
            folderLabel="Project Folder"
          />
        </div>
        <Button variant="secondary" size="sm" onClick={load}>Refresh</Button>
      </div>

      {loading ? (
        <Card className="p-6 space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </Card>
      ) : runs.length === 0 ? (
        <Card className="p-10 text-center text-sm text-muted-foreground">
          {browsingSpaceId ? 'No runs in this operational space.' : 'Select an operational space to browse runs.'}
        </Card>
      ) : (
        <div className="space-y-3">
          {runs.map(r => <RunRow key={r.id} r={r} agentName={agents.find(agent => agent.id === r.agent_id)?.name ?? null} onRefresh={load} />)}
        </div>
      )}
    </div>
  )
}
