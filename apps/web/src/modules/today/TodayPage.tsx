import { useState, useEffect, useCallback, useRef } from 'react'
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
import { formatDateParts, formatDateTime, formatNumber } from '../../i18n/format'
import { useAppTranslation } from '../../i18n'
import { proposalTitle } from '../memory/proposalTitle'

/**
 * Space Today — the space-scoped dashboard for ONE concrete Space (the active Space).
 * Mirrors Home's structure but limited to the current Space; writes default to it. This is
 * a real Space workspace, not a cross-space overview (that is Home).
 */

interface Stat { value: number; label: string; warn?: boolean }

function TodaySummaryCard({ stats }: { stats: Stat[] }) {
  const { t } = useAppTranslation()
  return (
    <div className="bg-card border border-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-[11px] font-bold tracking-[.1em] uppercase text-muted-foreground">{t('workspace_ui.today.summary_title')}</span>
        <span className="text-[11px] text-muted-foreground" style={{ fontFamily: 'var(--font-mono)' }}>
          {formatDateParts(new Date(), { weekday: 'short', month: 'short', day: 'numeric' })}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {stats.map(s => (
          <div key={s.label} className="flex flex-col gap-1">
            <div className="text-[22px] font-semibold leading-none" style={{ fontFamily: 'var(--font-mono)', color: s.warn ? 'var(--warning)' : 'var(--foreground)' }}>
              {formatNumber(s.value)}
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
  const { t } = useAppTranslation()
  const card = 'bg-card border border-border rounded-lg p-3.5 flex flex-col gap-2 min-h-[120px]'
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
      <div className={card}>
        <div className="text-[10px] font-bold tracking-[.1em] uppercase text-muted-foreground">{t('workspace_ui.today.recent_runs')}</div>
        {runs.length === 0 ? <p className="text-[12px] text-muted-foreground">{t('workspace_ui.today.no_runs')}</p> : (
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
                  <div className="text-[10px] text-muted-foreground">{formatDateTime(r.created_at)}</div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className={card}>
        <div className="text-[10px] font-bold tracking-[.1em] uppercase text-muted-foreground">{t('workspace_ui.today.active_tasks')}</div>
        {tasks.length === 0 ? <p className="text-[12px] text-muted-foreground">{t('workspace_ui.today.no_tasks')}</p> : (
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
        <div className="text-[10px] font-bold tracking-[.1em] uppercase text-muted-foreground">{t('workspace_ui.today.pending_proposals')}</div>
        {proposals.length === 0 ? <p className="text-[12px] text-muted-foreground">{t('workspace_ui.today.no_proposals')}</p> : (
          <ul className="flex flex-col gap-1.5 m-0 p-0 list-none">
            {proposals.map(p => (
              <li key={p.id}>
                <button type="button" onClick={() => navigate(`/proposals/${p.id}`)} className="w-full text-left rounded-md px-1 py-1 hover:bg-accent transition-colors">
                  <div className="text-[12px] text-foreground truncate">{proposalTitle(p.title, p.title_parts)}</div>
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
  // A maintenance update waiting for its revision is decided on its own page,
  // where it can be revised; a quick accept here would only be refused.
  const { t } = useAppTranslation()
  const canQuick = (p: HomePendingProposalItem) => (p.proposal_type === 'memory_update' || p.proposal_type === 'code_patch') && p.status === 'pending' && !p.awaiting_revision
  return (
    <div className="bg-card border border-border rounded-lg p-4 flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] font-bold tracking-[.1em] uppercase text-muted-foreground">{t('workspace_ui.today.pending_review')}</span>
        <Link to="/proposals" className="text-[11px] text-accent-foreground flex items-center gap-1 hover:underline">{t('workspace_ui.today.review_all')} <ChevronRight className="size-3" /></Link>
      </div>
      {proposals.length === 0 ? <p className="text-[12px] text-muted-foreground">{t('workspace_ui.today.no_pending_proposals')}</p> : (
        <div className="flex flex-col">
          {proposals.slice(0, 5).map((p, i) => (
            <div key={p.id} className="flex items-center gap-2.5 py-2.5" style={{ borderTop: i === 0 ? 'none' : '1px solid color-mix(in oklch, var(--border) 50%, transparent)' }}>
              <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-[.05em] text-muted-foreground" style={{ background: 'var(--accent)', border: '1px solid var(--border)', fontFamily: 'var(--font-mono)' }}>
                {p.proposal_type.slice(0, 4)}
              </span>
              <Link to={`/proposals/${p.id}`} className="flex-1 min-w-0 text-[12px] text-foreground truncate hover:underline">{proposalTitle(p.title, p.title_parts)}</Link>
              {canQuick(p) && (
                <div className="flex gap-1 shrink-0">
                  <button type="button" onClick={() => onDecide(p, 'accept')} title={t('workspace_ui.today.accept')} aria-label={t('workspace_ui.today.accept')} className="w-[22px] h-[22px] rounded flex items-center justify-center" style={{ background: 'color-mix(in oklch, var(--success) 15%, transparent)', border: '1px solid color-mix(in oklch, var(--success) 30%, transparent)', color: 'var(--success)' }}>
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
                  </button>
                  <button type="button" onClick={() => onDecide(p, 'reject')} title={t('workspace_ui.today.reject')} aria-label={t('workspace_ui.today.reject')} className="w-[22px] h-[22px] rounded flex items-center justify-center" style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted-foreground)' }}>
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
  const { t } = useAppTranslation()
  const needs = source.pending_reading_items > 0 || source.candidate_evidence > 0 || source.pending_extraction_jobs > 0 || source.failed_extraction_jobs > 0 || source.due_connections > 0
  if (!needs) return null
  return (
    <div className="bg-card border border-border rounded-lg p-4 flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] font-bold tracking-[.1em] uppercase text-muted-foreground">{t('workspace_ui.today.sources')}</span>
        <Link to="/sources" className="text-[11px] text-accent-foreground flex items-center gap-1 hover:underline">{t('workspace_ui.today.review')} <ChevronRight className="size-3" /></Link>
      </div>
      <div className="flex flex-col gap-1 text-[12px]">
        {source.due_connections > 0 && <span style={{ color: 'var(--warning)' }}>{t('workspace_ui.today.due_connections', { count: source.due_connections, formatted: formatNumber(source.due_connections) })}</span>}
        {source.pending_reading_items > 0 && <span className="text-muted-foreground">{t('workspace_ui.today.items_to_read', { count: source.pending_reading_items, formatted: formatNumber(source.pending_reading_items) })}</span>}
        {source.candidate_evidence > 0 && <span className="text-muted-foreground">{t('workspace_ui.today.evidence_candidates', { count: source.candidate_evidence, formatted: formatNumber(source.candidate_evidence) })}</span>}
        {source.failed_extraction_jobs > 0 && <span style={{ color: 'var(--destructive)' }}>{t('workspace_ui.today.failed_extractions', { count: source.failed_extraction_jobs, formatted: formatNumber(source.failed_extraction_jobs) })}</span>}
      </div>
    </div>
  )
}

function ProjectsCard({ projects }: { projects: Project[] }) {
  const navigate = useNavigate()
  const { t } = useAppTranslation()
  return (
    <div className="bg-card border border-border rounded-lg p-4 flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] font-bold tracking-[.1em] uppercase text-muted-foreground flex items-center gap-1.5"><FolderKanban className="size-3" /> {t('workspace_ui.today.projects')}</span>
        <Link to="/projects" className="text-[11px] text-accent-foreground flex items-center gap-1 hover:underline">{t('workspace_ui.today.all_projects')} <ChevronRight className="size-3" /></Link>
      </div>
      {projects.length === 0 ? (
        <Link to="/projects" className="inline-flex items-center gap-1 text-[11px] text-accent-foreground hover:underline"><Plus className="size-3" /> {t('workspace_ui.today.create_first_project')}</Link>
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
  const { t } = useAppTranslation()
  if (operations.length === 0) return null
  return <div className="bg-card border border-border rounded-lg p-4 flex flex-col gap-3">
    <span className="text-[11px] font-bold tracking-[.1em] uppercase text-muted-foreground">{t('workspace_ui.today.operations_in_progress')}</span>
    {operations.slice(0, 5).map(operation => {
      const completed = Number(operation.progress_json.completed ?? 0), total = Number(operation.progress_json.total ?? 0)
      return <Link key={operation.id} to={`/projects/${operation.project_id}`} className="rounded-md px-1 py-1.5 hover:bg-accent">
        <div className="flex justify-between gap-2 text-[12px]"><span className="truncate">{operation.title}</span><span className="text-muted-foreground">{total ? t('workspace_ui.today.operation_progress', { completed: formatNumber(completed), total: formatNumber(total) }) : operation.status}</span></div>
        <div className="text-[10px] text-muted-foreground truncate">{operation.project_name} · {operation.kind.replace(/_/g, ' ')}</div>
      </Link>
    })}
  </div>
}

function ModelProviderStatusCard({ status }: { status: HomeModelProviderStatusSection }) {
  const { t } = useAppTranslation()
  const n = status.enabled_model_providers_count
  return (
    <div className="bg-card border border-border rounded-lg p-4 flex flex-col gap-3">
      <span className="text-[11px] font-bold tracking-[.1em] uppercase text-muted-foreground">{t('workspace_ui.today.model_providers')}</span>
      <div className="text-[12px] text-muted-foreground" style={{ fontFamily: 'var(--font-mono)' }}>{t('workspace_ui.today.enabled_providers', { count: n, formatted: formatNumber(n) })}</div>
      {status.missing_model_provider_config && <Link to="/providers" className="text-[11px] text-primary hover:underline">{t('workspace_ui.today.configure_provider')}</Link>}
    </div>
  )
}

function RuntimeStatusCard({ status }: { status: HomeRuntimeStatusSection }) {
  const { t } = useAppTranslation()
  const n = status.real_adapters_configured_count
  return (
    <div className="bg-card border border-border rounded-lg p-4 flex flex-col gap-3">
      <span className="text-[11px] font-bold tracking-[.1em] uppercase text-muted-foreground">{t('workspace_ui.today.runtime')}</span>
      <div className="text-[12px] text-muted-foreground" style={{ fontFamily: 'var(--font-mono)' }}>{t('workspace_ui.today.real_adapters', { count: n, formatted: formatNumber(n) })}</div>
      {status.configured_runtime_keys.length > 0 && <div className="text-[11px] text-muted-foreground break-words">{status.configured_runtime_keys.join(t('workspace_ui.today.list_separator'))}</div>}
    </div>
  )
}

function SuggestedActionsCard({ actions }: { actions: HomeSuggestedActionItem[] }) {
  const { t } = useAppTranslation()
  if (actions.length === 0) return null
  const rank: Record<string, number> = { high: 0, normal: 1, low: 2 }
  const sorted = [...actions].sort((a, b) => rank[a.priority] - rank[b.priority])
  return (
    <div className="bg-card border border-border rounded-lg p-4 flex flex-col gap-2">
      <span className="text-[11px] font-bold tracking-[.1em] uppercase text-muted-foreground">{t('workspace_ui.today.suggested')}</span>
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
  const { t } = useAppTranslation()
  const recent = artifacts.filter(a => a.artifact_type === 'summary' || a.artifact_type === 'daily_capture_report').slice(0, 3)
  const has = sessions.length > 0 || recent.length > 0
  return (
    <div className="bg-card border border-border rounded-lg p-4 flex flex-col gap-3">
      <span className="text-[11px] font-bold tracking-[.1em] uppercase text-muted-foreground">{t('workspace_ui.today.recent')}</span>
      {!has ? <p className="text-[12px] text-muted-foreground">{t('workspace_ui.today.nothing_recent')}</p> : (
        <div className="flex flex-col">
          {recent.map((a, i) => (
            <button key={a.id} onClick={() => navigate(`/artifacts/${a.id}`)} className="flex items-center gap-2.5 py-2 text-left w-full hover:bg-accent rounded transition-colors -mx-1 px-1" style={{ borderTop: i === 0 ? 'none' : '1px solid color-mix(in oklch, var(--border) 50%, transparent)' }}>
              <div className="flex-1 min-w-0">
                <div className="text-[11px] text-accent-foreground truncate">{a.title}</div>
                <div className="text-[10px] text-muted-foreground" style={{ fontFamily: 'var(--font-mono)' }}>{t(a.artifact_type === 'daily_capture_report' ? 'workspace_ui.today.daily_report' : 'workspace_ui.today.summary')} · {formatDateParts(a.created_at, { month: 'short', day: 'numeric' })}</div>
              </div>
            </button>
          ))}
          {sessions.slice(0, 5).map((s, i) => (
            <button key={s.id} onClick={() => navigate(`/sessions?open=${s.id}`)} className="flex items-center gap-2.5 py-2 text-left w-full hover:bg-accent rounded transition-colors -mx-1 px-1" style={{ borderTop: (i === 0 && recent.length === 0) ? 'none' : '1px solid color-mix(in oklch, var(--border) 50%, transparent)' }}>
              <div className="flex-1 min-w-0">
                <div className="text-[12px] text-foreground truncate">{s.title ?? t('workspace_ui.today.untitled')}</div>
                <div className="text-[10px] text-muted-foreground" style={{ fontFamily: 'var(--font-mono)' }}>{formatDateParts(s.updated_at, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
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
    runtime_status: { real_adapters_configured_count: 0, configured_runtime_keys: [], message: '' },
    model_provider_status: { model_providers_count: 0, enabled_model_providers_count: 0, missing_model_provider_config: true, message: '' },
    suggested_actions: [],
    operations_in_progress: [],
    source_summary: { pending_reading_items: 0, new_items_today: 0, pending_extraction_jobs: 0, failed_extraction_jobs: 0, candidate_evidence: 0, active_evidence: 0, due_connections: 0 },
  }
}

export default function TodayPage() {
  const { activeSpaceId, activeSpaceName } = useSpace()
  const { t } = useAppTranslation()
  const [summary, setSummary] = useState<HomeSummaryOut | null>(null)
  const [sessions, setSessions] = useState<Session[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  // The switcher keeps this page mounted when it moves to another Space's
  // Today, so only the latest summary request may fill the page.
  const summaryRequest = useRef(0)

  const loadSummary = useCallback(async () => {
    const request = ++summaryRequest.current
    if (!activeSpaceId) { setSummary(emptyHomeSummary()); setSessions([]); setProjects([]); return }
    try {
      const s = await homeApi.summary({ recent_runs_limit: '5', active_tasks_limit: '8', pending_preview_limit: '10' })
      if (request === summaryRequest.current) setSummary(s)
    } catch {
      if (request === summaryRequest.current) setSummary(emptyHomeSummary())
    }
  }, [activeSpaceId])

  useEffect(() => {
    // Nothing from the previous Space stays on screen while this one loads,
    // or after one of its lists fails.
    setSummary(null); setSessions([]); setProjects([])
    void loadSummary()
    if (!activeSpaceId) return
    let active = true
    sessionsApi.list().then(r => { if (active) setSessions(r.items) }).catch(() => {})
    projectsApi.list({ status: 'active', limit: 5 }).then(r => { if (active) setProjects(r.items) }).catch(() => {})
    return () => { active = false }
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
      toast.success(t(action === 'accept' ? 'workspace_ui.today.proposal_accepted' : 'workspace_ui.today.proposal_rejected'))
      await loadSummary()
    } catch (e) {
      toast.error(errMsg(e))
    }
  }

  if (!activeSpaceId) {
    return (
      <div className="p-6">
        <EmptyState title={t('workspace_ui.today.no_space_title')} description={t('workspace_ui.today.no_space_description')} />
      </div>
    )
  }

  const s = summary ?? emptyHomeSummary()
  const stats: Stat[] = [
    { value: s.pending_proposals.count, label: t('workspace_ui.today.stat.pending_proposals', { count: s.pending_proposals.count }), warn: s.pending_proposals.count > 0 },
    { value: s.task_summary.total_open, label: t('workspace_ui.today.stat.open_tasks', { count: s.task_summary.total_open }), warn: s.task_summary.blocked_count > 0 },
    { value: s.run_stats_today.created, label: t('workspace_ui.today.stat.runs_today', { count: s.run_stats_today.created }), warn: s.run_stats_today.failed > 0 },
    { value: s.activity_summary.raw_count, label: t('workspace_ui.today.stat.raw_activities', { count: s.activity_summary.raw_count }), warn: s.activity_summary.raw_count > 0 },
    { value: s.source_summary.pending_reading_items, label: t('workspace_ui.today.stat.items_to_read', { count: s.source_summary.pending_reading_items }), warn: s.source_summary.failed_extraction_jobs > 0 },
    { value: s.source_summary.candidate_evidence, label: t('workspace_ui.today.stat.evidence_candidates', { count: s.source_summary.candidate_evidence }) },
  ]

  return (
    <div className="page-dashboard">
      <div className="flex flex-col gap-3.5 min-w-0">
        <div className="page-dashboard-hero">
          <div className="flex flex-col gap-1.5">
            <div className="text-[10px] font-bold tracking-[.1em] uppercase" style={{ color: 'color-mix(in oklch, var(--muted-foreground) 70%, transparent)' }}>{t('workspace_ui.today.eyebrow')}</div>
            <h1 className="text-2xl font-semibold tracking-tight m-0">{activeSpaceName ?? t('workspace_ui.today.this_space')}</h1>
            <p className="text-[13px] text-muted-foreground">{t('workspace_ui.today.description')}</p>
          </div>
          <TodaySummaryCard stats={stats} />
        </div>

        <Eyebrow>{t('workspace_ui.today.product_loop')}</Eyebrow>
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
