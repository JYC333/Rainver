import { useState, useEffect, useCallback } from 'react'
import { useSpaceNavigate as useNavigate, SpaceLink as Link } from '../../core/spaceNav'
import { ChevronRight, FolderKanban, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { proposalsApi, sessionsApi, homeApi, projectsApi } from '../../api/client'
import { useSpace } from '../../contexts/SpaceContext'
import { errMsg } from '../../lib/utils'
import type {
  Session, HomeSummaryOut, HomeRunSummaryItem, HomeActiveTaskItem, HomePendingProposalItem,
  HomeRuntimeStatusSection, HomeModelProviderStatusSection, HomeSuggestedActionItem,
  HomeSourceSummarySection, HomeArtifactSummaryItem, Project,
} from '../../types/api'
import { PreviewBadge, UrgencyBadge } from '../../components/PreviewBadge'
import { ScopeBadge } from '../../components/ScopeBadge'
import { EmptyState } from '../../components/ui/empty-state'
import { codePatchAcceptOptions } from '../memory/codePatchConfirm'
import { notifyReviewAttentionChanged } from '../../core/reviewAttention'

/**
 * Space Today — the space-scoped dashboard for ONE concrete Space (the active Space).
 * Mirrors Home's structure but limited to the current Space; writes default to it. This is
 * a real Space workspace, not a cross-space overview (that is Home).
 */

interface Stat { value: number; label: string; warn?: boolean }

function TodaySummaryCard({ stats }: { stats: Stat[] }) {
  return (
    <div className="bg-card border border-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-[11px] font-bold tracking-[.1em] uppercase text-muted-foreground">Today</span>
        <span className="text-[11px] text-muted-foreground" style={{ fontFamily: 'var(--font-mono)' }}>
          {new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {stats.map(s => (
          <div key={s.label} className="flex flex-col gap-1">
            <div className="text-[22px] font-semibold leading-none" style={{ fontFamily: 'var(--font-mono)', color: s.warn ? 'var(--warning)' : 'var(--foreground)' }}>
              {s.value}
            </div>
            <div className="text-[11px] text-muted-foreground">{s.label}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

function Eyebrow({ children, count }: { children: React.ReactNode; count?: number }) {
  return (
    <div className="flex items-baseline gap-2 mb-3">
      <span className="text-[10px] font-bold tracking-[.1em] uppercase" style={{ color: 'color-mix(in oklch, var(--muted-foreground) 70%, transparent)' }}>{children}</span>
      {count !== undefined && <span className="text-[11px] text-muted-foreground" style={{ fontFamily: 'var(--font-mono)' }}>{String(count).padStart(2, '0')}</span>}
    </div>
  )
}

function ProductLoopStrip({ runs, tasks, proposals }: { runs: HomeRunSummaryItem[]; tasks: HomeActiveTaskItem[]; proposals: HomePendingProposalItem[] }) {
  const navigate = useNavigate()
  const card = 'bg-card border border-border rounded-lg p-3.5 flex flex-col gap-2 min-h-[120px]'
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
      <div className={card}>
        <div className="text-[10px] font-bold tracking-[.1em] uppercase text-muted-foreground">Recent runs</div>
        {runs.length === 0 ? <p className="text-[12px] text-muted-foreground">None yet.</p> : (
          <ul className="flex flex-col gap-1.5 m-0 p-0 list-none">
            {runs.map(r => (
              <li key={r.id}>
                <button type="button" onClick={() => navigate(`/runs/${r.id}`)} className="w-full text-left rounded-md px-1 py-1 hover:bg-accent transition-colors">
                  <div className="flex flex-wrap gap-1 items-center">
                    <span className="text-[11px] font-mono text-muted-foreground">{r.status}</span>
                    <span className="text-[11px]">{r.mode}</span>
                    <ScopeBadge visibility={r.visibility} omitShared className="text-[9px] px-1 py-0" />
                    {r.mode === 'dry_run' && <PreviewBadge className="text-[9px] px-1 py-0" />}
                  </div>
                  <div className="text-[10px] text-muted-foreground">{new Date(r.created_at).toLocaleString()}</div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className={card}>
        <div className="text-[10px] font-bold tracking-[.1em] uppercase text-muted-foreground">Open / active tasks</div>
        {tasks.length === 0 ? <p className="text-[12px] text-muted-foreground">None in view.</p> : (
          <ul className="flex flex-col gap-1.5 m-0 p-0 list-none">
            {tasks.map(t => (
              <li key={t.id}>
                <button type="button" onClick={() => navigate(`/tasks/${t.id}`)} className="w-full text-left rounded-md px-1 py-1 hover:bg-accent transition-colors">
                  <div className="text-[12px] text-foreground truncate">{t.title}</div>
                  <div className="text-[10px] text-muted-foreground flex gap-1 flex-wrap">
                    <span>{t.status}</span>
                    <ScopeBadge visibility={t.visibility} omitShared className="text-[9px] px-1 py-0" />
                    <span>· {t.priority}</span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className={card}>
        <div className="text-[10px] font-bold tracking-[.1em] uppercase text-muted-foreground">Pending proposals</div>
        {proposals.length === 0 ? <p className="text-[12px] text-muted-foreground">None pending.</p> : (
          <ul className="flex flex-col gap-1.5 m-0 p-0 list-none">
            {proposals.map(p => (
              <li key={p.id}>
                <button type="button" onClick={() => navigate(`/proposals/${p.id}`)} className="w-full text-left rounded-md px-1 py-1 hover:bg-accent transition-colors">
                  <div className="text-[12px] text-foreground truncate">{p.title}</div>
                  <div className="flex flex-wrap gap-1 items-center mt-0.5">
                    <UrgencyBadge urgency={p.urgency} />
                    <ScopeBadge visibility={p.visibility} omitShared className="text-[9px] px-1 py-0" />
                    {p.preview && <PreviewBadge className="text-[9px] px-1 py-0" />}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function ProposalStatusCard({ proposals, onDecide }: { proposals: HomePendingProposalItem[]; onDecide: (proposal: HomePendingProposalItem, action: 'accept' | 'reject') => void }) {
  const canQuick = (p: HomePendingProposalItem) => (p.proposal_type === 'memory_update' || p.proposal_type === 'code_patch') && p.status === 'pending'
  return (
    <div className="bg-card border border-border rounded-lg p-4 flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] font-bold tracking-[.1em] uppercase text-muted-foreground">Pending review</span>
        <Link to="/proposals" className="text-[11px] text-accent-foreground flex items-center gap-1 hover:underline">Review all <ChevronRight className="size-3" /></Link>
      </div>
      {proposals.length === 0 ? <p className="text-[12px] text-muted-foreground">No pending proposals.</p> : (
        <div className="flex flex-col">
          {proposals.slice(0, 5).map((p, i) => (
            <div key={p.id} className="flex items-center gap-2.5 py-2.5" style={{ borderTop: i === 0 ? 'none' : '1px solid color-mix(in oklch, var(--border) 50%, transparent)' }}>
              <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-[.05em] text-muted-foreground" style={{ background: 'var(--accent)', border: '1px solid var(--border)', fontFamily: 'var(--font-mono)' }}>
                {p.proposal_type.slice(0, 4)}
              </span>
              <Link to={`/proposals/${p.id}`} className="flex-1 min-w-0 text-[12px] text-foreground truncate hover:underline">{p.title}</Link>
              {canQuick(p) && (
                <div className="flex gap-1 shrink-0">
                  <button type="button" onClick={() => onDecide(p, 'accept')} title="Accept" className="w-[22px] h-[22px] rounded flex items-center justify-center" style={{ background: 'color-mix(in oklch, var(--success) 15%, transparent)', border: '1px solid color-mix(in oklch, var(--success) 30%, transparent)', color: 'var(--success)' }}>
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
                  </button>
                  <button type="button" onClick={() => onDecide(p, 'reject')} title="Reject" className="w-[22px] h-[22px] rounded flex items-center justify-center" style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted-foreground)' }}>
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function SourceAttentionCard({ source }: { source: HomeSourceSummarySection }) {
  const needs = source.open_items > 0 || source.candidate_evidence > 0 || source.pending_extraction_jobs > 0 || source.failed_extraction_jobs > 0 || source.due_connections > 0
  if (!needs) return null
  return (
    <div className="bg-card border border-border rounded-lg p-4 flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] font-bold tracking-[.1em] uppercase text-muted-foreground">Sources</span>
        <Link to="/sources" className="text-[11px] text-accent-foreground flex items-center gap-1 hover:underline">Review <ChevronRight className="size-3" /></Link>
      </div>
      <div className="flex flex-col gap-1 text-[12px]">
        {source.due_connections > 0 && <span style={{ color: 'var(--warning)' }}>{source.due_connections} connection{source.due_connections !== 1 ? 's' : ''} due for scan</span>}
        {source.open_items > 0 && <span className="text-muted-foreground">{source.open_items} open item{source.open_items !== 1 ? 's' : ''}</span>}
        {source.candidate_evidence > 0 && <span className="text-muted-foreground">{source.candidate_evidence} evidence candidate{source.candidate_evidence !== 1 ? 's' : ''}</span>}
        {source.failed_extraction_jobs > 0 && <span style={{ color: 'var(--destructive)' }}>{source.failed_extraction_jobs} failed extraction{source.failed_extraction_jobs !== 1 ? 's' : ''}</span>}
      </div>
    </div>
  )
}

function ProjectsCard({ projects }: { projects: Project[] }) {
  const navigate = useNavigate()
  return (
    <div className="bg-card border border-border rounded-lg p-4 flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] font-bold tracking-[.1em] uppercase text-muted-foreground flex items-center gap-1.5"><FolderKanban className="size-3" /> Projects</span>
        <Link to="/projects" className="text-[11px] text-accent-foreground flex items-center gap-1 hover:underline">All <ChevronRight className="size-3" /></Link>
      </div>
      {projects.length === 0 ? (
        <Link to="/projects" className="inline-flex items-center gap-1 text-[11px] text-accent-foreground hover:underline"><Plus className="size-3" /> Create your first project</Link>
      ) : (
        <div className="flex flex-col">
          {projects.slice(0, 5).map((p, i) => (
            <button key={p.id} onClick={() => navigate(`/projects/${p.id}`)} className="flex flex-col py-2 text-left w-full hover:bg-accent rounded transition-colors -mx-1 px-1" style={{ borderTop: i === 0 ? 'none' : '1px solid color-mix(in oklch, var(--border) 50%, transparent)' }}>
              <div className="text-[12px] text-foreground truncate">{p.name}</div>
              {p.current_focus && <div className="text-[10px] text-muted-foreground truncate">{p.current_focus}</div>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function OperationsCard({ operations }: { operations: HomeSummaryOut['operations_in_progress'] }) {
  if (operations.length === 0) return null
  return <div className="bg-card border border-border rounded-lg p-4 flex flex-col gap-3">
    <span className="text-[11px] font-bold tracking-[.1em] uppercase text-muted-foreground">Operations in progress</span>
    {operations.slice(0, 5).map(operation => {
      const completed = Number(operation.progress_json.completed ?? 0), total = Number(operation.progress_json.total ?? 0)
      return <Link key={operation.id} to={`/projects/${operation.project_id}`} className="rounded-md px-1 py-1.5 hover:bg-accent">
        <div className="flex justify-between gap-2 text-[12px]"><span className="truncate">{operation.title}</span><span className="text-muted-foreground">{total ? `${completed}/${total}` : operation.status}</span></div>
        <div className="text-[10px] text-muted-foreground truncate">{operation.project_name} · {operation.kind.replace(/_/g, ' ')}</div>
      </Link>
    })}
  </div>
}

function ModelProviderStatusCard({ status }: { status: HomeModelProviderStatusSection }) {
  const n = status.enabled_model_providers_count
  return (
    <div className="bg-card border border-border rounded-lg p-4 flex flex-col gap-3">
      <span className="text-[11px] font-bold tracking-[.1em] uppercase text-muted-foreground">Model providers</span>
      <div className="text-[12px] text-muted-foreground" style={{ fontFamily: 'var(--font-mono)' }}>{n} enabled provider{n !== 1 ? 's' : ''}</div>
      {status.missing_model_provider_config && <Link to="/providers" className="text-[11px] text-primary hover:underline">Configure a model provider</Link>}
    </div>
  )
}

function RuntimeStatusCard({ status }: { status: HomeRuntimeStatusSection }) {
  const n = status.real_adapters_configured_count
  return (
    <div className="bg-card border border-border rounded-lg p-4 flex flex-col gap-3">
      <span className="text-[11px] font-bold tracking-[.1em] uppercase text-muted-foreground">Runtime</span>
      <div className="text-[12px] text-muted-foreground" style={{ fontFamily: 'var(--font-mono)' }}>{n} real adapter{n !== 1 ? 's' : ''} configured</div>
      {status.configured_adapter_types.length > 0 && <div className="text-[11px] text-muted-foreground break-words">{status.configured_adapter_types.join(', ')}</div>}
    </div>
  )
}

function SuggestedActionsCard({ actions }: { actions: HomeSuggestedActionItem[] }) {
  if (actions.length === 0) return null
  const rank: Record<string, number> = { high: 0, normal: 1, low: 2 }
  const sorted = [...actions].sort((a, b) => rank[a.priority] - rank[b.priority])
  return (
    <div className="bg-card border border-border rounded-lg p-4 flex flex-col gap-2">
      <span className="text-[11px] font-bold tracking-[.1em] uppercase text-muted-foreground">Suggested</span>
      <ul className="m-0 p-0 list-none flex flex-col gap-1.5">
        {sorted.map(a => (
          <li key={a.id}>
            <Link to={a.target_path} className="block rounded-md px-1 py-1.5 hover:bg-accent transition-colors">
              <div className="text-[12px] text-foreground">{a.label}</div>
              <div className="text-[10px] text-muted-foreground line-clamp-2">{a.reason}</div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}

function RecentCard({ sessions, artifacts }: { sessions: Session[]; artifacts: HomeArtifactSummaryItem[] }) {
  const navigate = useNavigate()
  const recent = artifacts.filter(a => a.artifact_type === 'summary' || a.artifact_type === 'daily_capture_report').slice(0, 3)
  const has = sessions.length > 0 || recent.length > 0
  return (
    <div className="bg-card border border-border rounded-lg p-4 flex flex-col gap-3">
      <span className="text-[11px] font-bold tracking-[.1em] uppercase text-muted-foreground">Recent</span>
      {!has ? <p className="text-[12px] text-muted-foreground">Nothing yet.</p> : (
        <div className="flex flex-col">
          {recent.map((a, i) => (
            <button key={a.id} onClick={() => navigate(`/artifacts/${a.id}`)} className="flex items-center gap-2.5 py-2 text-left w-full hover:bg-accent rounded transition-colors -mx-1 px-1" style={{ borderTop: i === 0 ? 'none' : '1px solid color-mix(in oklch, var(--border) 50%, transparent)' }}>
              <div className="flex-1 min-w-0">
                <div className="text-[11px] text-accent-foreground truncate">{a.title}</div>
                <div className="text-[10px] text-muted-foreground" style={{ fontFamily: 'var(--font-mono)' }}>{a.artifact_type === 'daily_capture_report' ? 'daily report' : 'summary'} · {new Date(a.created_at).toLocaleString([], { month: 'short', day: 'numeric' })}</div>
              </div>
            </button>
          ))}
          {sessions.slice(0, 5).map((s, i) => (
            <button key={s.id} onClick={() => navigate(`/sessions?open=${s.id}`)} className="flex items-center gap-2.5 py-2 text-left w-full hover:bg-accent rounded transition-colors -mx-1 px-1" style={{ borderTop: (i === 0 && recent.length === 0) ? 'none' : '1px solid color-mix(in oklch, var(--border) 50%, transparent)' }}>
              <div className="flex-1 min-w-0">
                <div className="text-[12px] text-foreground truncate">{s.title ?? '(untitled)'}</div>
                <div className="text-[10px] text-muted-foreground" style={{ fontFamily: 'var(--font-mono)' }}>{new Date(s.updated_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function emptyHomeSummary(): HomeSummaryOut {
  return {
    recent_runs: [], active_runs: [], pending_proposals: { count: 0, items: [] }, recent_artifacts: [],
    task_summary: { by_status: {}, total_open: 0, needs_review_count: 0, blocked_count: 0, done_count: 0 },
    active_tasks: [], activity_summary: { recent_count: 0, raw_count: 0, today_count: 0 },
    run_stats_today: { created: 0, queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0, dry_run_count: 0 },
    job_queue_status: { queued: 0, running: 0, failed: 0, retryable: 0, recent_error_preview: null },
    runtime_status: { real_adapters_configured_count: 0, configured_adapter_types: [], message: '' },
    model_provider_status: { model_providers_count: 0, enabled_model_providers_count: 0, missing_model_provider_config: true, message: '' },
    suggested_actions: [],
    operations_in_progress: [],
    source_summary: { open_items: 0, new_items_today: 0, pending_extraction_jobs: 0, failed_extraction_jobs: 0, candidate_evidence: 0, active_evidence: 0, due_connections: 0 },
  }
}

export default function TodayPage() {
  const { activeSpaceId, activeSpaceName } = useSpace()
  const [summary, setSummary] = useState<HomeSummaryOut | null>(null)
  const [sessions, setSessions] = useState<Session[]>([])
  const [projects, setProjects] = useState<Project[]>([])

  const loadSummary = useCallback(async () => {
    if (!activeSpaceId) { setSummary(emptyHomeSummary()); setSessions([]); setProjects([]); return }
    try {
      const s = await homeApi.summary({ recent_runs_limit: '5', active_tasks_limit: '8', pending_preview_limit: '10' })
      setSummary(s)
    } catch {
      setSummary(emptyHomeSummary())
    }
  }, [activeSpaceId])

  useEffect(() => {
    loadSummary()
    if (activeSpaceId) {
      sessionsApi.list().then(r => setSessions(r.items)).catch(() => {})
      projectsApi.list({ status: 'active', limit: 5 }).then(r => setProjects(r.items)).catch(() => {})
    } else {
      setProjects([]); setSessions([])
    }
  }, [loadSummary, activeSpaceId])

  async function decide(proposal: HomePendingProposalItem, action: 'accept' | 'reject') {
    try {
      if (action === 'accept') {
        const detail = proposal.proposal_type === 'code_patch'
          ? await proposalsApi.get(proposal.id)
          : null
        const options = detail ? codePatchAcceptOptions(detail) : {}
        if (options === null) return
        await proposalsApi.accept(proposal.id, options)
      } else {
        await proposalsApi.reject(proposal.id)
      }
      notifyReviewAttentionChanged()
      toast.success(`Proposal ${action}ed`)
      await loadSummary()
    } catch (e) {
      toast.error(errMsg(e))
    }
  }

  if (!activeSpaceId) {
    return (
      <div className="p-6">
        <EmptyState title="No space selected" description="Choose a space from the switcher to see its Today dashboard." />
      </div>
    )
  }

  const s = summary ?? emptyHomeSummary()
  const stats: Stat[] = [
    { value: s.pending_proposals.count, label: 'pending proposals', warn: s.pending_proposals.count > 0 },
    { value: s.task_summary.total_open, label: 'open tasks', warn: s.task_summary.blocked_count > 0 },
    { value: s.run_stats_today.created, label: 'runs today', warn: s.run_stats_today.failed > 0 },
    { value: s.activity_summary.raw_count, label: 'raw activities', warn: s.activity_summary.raw_count > 0 },
    { value: s.source_summary.open_items, label: 'source items', warn: s.source_summary.failed_extraction_jobs > 0 },
    { value: s.source_summary.candidate_evidence, label: 'evidence candidates' },
  ]

  return (
    <div className="min-h-full" style={{ maxWidth: 1440, margin: '0 auto', padding: '16px 20px 96px', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 300px', gap: 18, alignItems: 'start' }}>
      <div className="flex flex-col gap-3.5 min-w-0">
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 14, alignItems: 'stretch' }}>
          <div className="flex flex-col gap-1.5">
            <div className="text-[10px] font-bold tracking-[.1em] uppercase" style={{ color: 'color-mix(in oklch, var(--muted-foreground) 70%, transparent)' }}>Space · Today</div>
            <h1 className="text-2xl font-semibold tracking-tight m-0">{activeSpaceName ?? 'This space'}</h1>
            <p className="text-[13px] text-muted-foreground">This space's daily overview. In-context work stays here; Quick Capture always goes to your Personal Space.</p>
          </div>
          <TodaySummaryCard stats={stats} />
        </div>

        <Eyebrow>Product loop</Eyebrow>
        <ProductLoopStrip runs={s.recent_runs.slice(0, 5)} tasks={s.active_tasks.slice(0, 6)} proposals={s.pending_proposals.items.slice(0, 5)} />
      </div>

      <div className="flex flex-col gap-3 min-w-0">
        <ProposalStatusCard proposals={s.pending_proposals.items} onDecide={decide} />
        <SourceAttentionCard source={s.source_summary} />
        <OperationsCard operations={s.operations_in_progress} />
        <ProjectsCard projects={projects} />
        <ModelProviderStatusCard status={s.model_provider_status} />
        <RuntimeStatusCard status={s.runtime_status} />
        <SuggestedActionsCard actions={s.suggested_actions} />
        <RecentCard sessions={sessions} artifacts={s.recent_artifacts} />
      </div>
    </div>
  )
}
