import { useEffect, useMemo, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ChevronRight, Inbox, ListTodo, AlertTriangle, Cpu, Clock,
} from 'lucide-react'
import { toast } from 'sonner'
import { meApi, spacesApi } from '../../api/client'
import { useSpace } from '../../contexts/SpaceContext'
import { useAuth } from '../../contexts/AuthContext'
import { spacePath } from '../../core/navigation'
import { errMsg } from '../../lib/utils'
import type {
  MeSummaryOut, MeTimelineEntry, MeTaskItem, MePendingProposalItem, MeSpaceRollup,
} from '../../types/api'
import { Card } from '../../components/ui/card'
import { Badge, StatusBadge } from '../../components/ui/badge'
import { Skeleton } from '../../components/ui/skeleton'
import { EmptyState } from '../../components/ui/empty-state'
import { SpaceBadge } from '../../components/SpaceBadge'
import { useAppTranslation, type Locale } from '../../i18n'

/* ── helpers ─────────────────────────────────────────────────────────────────── */
function fmt(dt: string | null | undefined, locale: Locale) {
  return dt ? new Date(dt).toLocaleString(locale === 'zh-CN' ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'
}

function objectPath(type: string | null | undefined, id: string | null | undefined): string | null {
  if (!type || !id) return null
  if (type === 'task') return `/tasks/${id}`
  if (type === 'run') return `/runs/${id}`
  if (type === 'proposal') return `/proposals/${id}`
  if (type === 'activity') return `/activity/${id}`
  if (type === 'artifact') return `/artifacts/${id}`
  return null
}

function Eyebrow({ children, count }: { children: React.ReactNode; count?: number }) {
  return (
    <div className="flex items-baseline gap-2 mb-2.5">
      <span className="text-[10px] font-bold tracking-[.1em] uppercase" style={{ color: 'color-mix(in oklch, var(--muted-foreground) 70%, transparent)' }}>
        {children}
      </span>
      {count !== undefined && (
        <span className="text-[11px] text-muted-foreground" style={{ fontFamily: 'var(--font-mono)' }}>
          {String(count).padStart(2, '0')}
        </span>
      )}
    </div>
  )
}

/* ── Needs Attention (cross-space aggregate) ─────────────────────────────────── */
function NeedsAttention({
  summary, failedRunSpaces, onGo,
}: {
  summary: MeSummaryOut
  failedRunSpaces: string[]
  onGo: (path: string) => void
}) {
  const { t } = useAppTranslation()
  const rows = [
    { key: 'proposals', icon: Inbox, label: t('home.proposals_waiting'), value: summary.pending_proposals_count, warn: summary.pending_proposals_count > 0, to: '/proposals' },
    { key: 'tasks', icon: ListTodo, label: t('home.tasks_assigned_to_you'), value: summary.assigned_tasks_count, warn: false, to: '/tasks' },
    { key: 'failed', icon: AlertTriangle, label: t('home.failed_runs_recent'), value: failedRunSpaces.length, warn: failedRunSpaces.length > 0, to: '/runs' },
  ]
  return (
    <div>
      <Eyebrow>{t('home.needs_attention')}</Eyebrow>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
        {rows.map(r => {
          const Icon = r.icon
          return (
            <button
              key={r.key}
              type="button"
              onClick={() => onGo(r.to)}
              className="text-left bg-card border border-border rounded-lg p-3.5 hover:bg-accent transition-colors"
            >
              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><Icon className="size-3.5" /> {r.label}</div>
              <div className="text-[22px] font-semibold leading-none mt-2" style={{ fontFamily: 'var(--font-mono)', color: r.warn ? 'var(--warning)' : 'var(--foreground)' }}>
                {r.value}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/* ── By space (per-space attention rollup) ───────────────────────────────────── */
function BySpace({ spaces, onOpen }: { spaces?: MeSpaceRollup[]; onOpen: (spaceId: string, path: string) => void }) {
  const { t } = useAppTranslation()
  // Only surface spaces that actually need attention; an all-zero list is noise on Home.
  const active = (spaces ?? []).filter(
    s => s.pending_proposals_count > 0 || s.assigned_tasks_count > 0 || s.recent_failed_runs_count > 0,
  )
  if (active.length === 0) return null
  // Pending proposals are the primary review action; fall back to tasks, then runs.
  const targetFor = (s: MeSpaceRollup) =>
    s.pending_proposals_count > 0 ? '/proposals' : s.assigned_tasks_count > 0 ? '/tasks' : '/runs'
  return (
    <div>
      <Eyebrow count={active.length}>{t('home.by_space')}</Eyebrow>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
        {active.map(s => (
          <button
            key={s.space_id}
            type="button"
            onClick={() => onOpen(s.space_id, targetFor(s))}
            className="text-left bg-card border border-border rounded-lg p-3.5 hover:bg-accent transition-colors"
          >
            <div className="flex items-center gap-2 min-w-0">
              <SpaceBadge spaceId={s.space_id} />
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{t(`space.${s.type}`, { defaultValue: s.type })}</span>
            </div>
            <div className="flex items-center gap-4 mt-2.5" style={{ fontFamily: 'var(--font-mono)' }}>
              <span className="flex items-center gap-1 text-[12px]" title={t('home.pending_proposals')}>
                <Inbox className="size-3.5 text-muted-foreground" />
                <span style={{ color: s.pending_proposals_count > 0 ? 'var(--warning)' : 'var(--foreground)' }}>{s.pending_proposals_count}</span>
              </span>
              <span className="flex items-center gap-1 text-[12px]" title={t('home.tasks_for_you')}>
                <ListTodo className="size-3.5 text-muted-foreground" />
                <span>{s.assigned_tasks_count}</span>
              </span>
              <span className="flex items-center gap-1 text-[12px]" title={t('home.failed_runs_7d')}>
                <AlertTriangle className="size-3.5 text-muted-foreground" />
                <span style={{ color: s.recent_failed_runs_count > 0 ? 'var(--warning)' : 'var(--foreground)' }}>{s.recent_failed_runs_count}</span>
              </span>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

/* ── Review Packets (cross-space, labelled by source Space) ───────────────────── */
function ReviewPackets({ pending, onOpen }: { pending: MePendingProposalItem[]; onOpen: (spaceId: string, path: string) => void }) {
  const { t } = useAppTranslation()
  return (
    <div>
      <Eyebrow count={pending.length}>{t('home.review_packets')}</Eyebrow>
      <Card className="p-0 overflow-hidden">
        {pending.length === 0 ? (
          <EmptyState title={t('home.nothing_waiting_for_review')} description={t('home.proposals_collect_here')} />
        ) : (
          <ul className="m-0 p-0 list-none divide-y divide-border">
            {pending.slice(0, 8).map(p => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => onOpen(p.space_id, `/proposals/${p.id}`)}
                  className="w-full text-left px-4 py-3 hover:bg-accent transition-colors flex items-center gap-3"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] text-foreground truncate">{p.title}</div>
                    <div className="flex flex-wrap items-center gap-1.5 mt-1">
                      <Badge variant="outline">{p.proposal_type}</Badge>
                      <StatusBadge status={p.status} />
                      <SpaceBadge spaceId={p.space_id} />
                    </div>
                  </div>
                  <ChevronRight className="size-4 text-muted-foreground shrink-0" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

/* ── Continue Working (recent work across spaces) ────────────────────────────── */
function ContinueWorking({
  summary, onOpen,
}: {
  summary: MeSummaryOut
  onOpen: (spaceId: string, path: string) => void
}) {
  const { t, locale } = useAppTranslation()
  const hasContent = summary.recent_runs.length > 0 || summary.recent_participation.length > 0
  return (
    <div>
      <Eyebrow>{t('home.continue_working')}</Eyebrow>
      <Card className="p-0 overflow-hidden">
        {!hasContent ? (
          <EmptyState title={t('home.no_recent_work_yet')} description={t('home.recent_work_description')} />
        ) : (
          <ul className="m-0 p-0 list-none divide-y divide-border">
            {summary.recent_runs.slice(0, 4).map(r => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => onOpen(r.space_id, `/runs/${r.id}`)}
                  className="w-full text-left px-4 py-2.5 hover:bg-accent transition-colors flex items-center gap-3"
                >
                  <Cpu className="size-3.5 text-muted-foreground shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] text-foreground truncate">{t('home.run_label', { mode: r.mode })}</div>
                    <div className="flex flex-wrap items-center gap-1.5 mt-1">
                      <StatusBadge status={r.status} />
                      <SpaceBadge spaceId={r.space_id} />
                      <span className="text-[10px] text-muted-foreground" style={{ fontFamily: 'var(--font-mono)' }}>{fmt(r.created_at, locale)}</span>
                    </div>
                  </div>
                </button>
              </li>
            ))}
            {summary.recent_participation.slice(0, 4).map(pt => {
              const path = objectPath(pt.source_object_type, pt.source_object_id)
              return (
                <li key={pt.id}>
                  <button
                    type="button"
                    disabled={!path}
                    onClick={() => path && onOpen(pt.source_space_id, path)}
                    className="w-full text-left px-4 py-2.5 hover:bg-accent transition-colors flex items-center gap-3 disabled:hover:bg-transparent"
                  >
                    <Clock className="size-3.5 text-muted-foreground shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] text-foreground truncate">{t('home.participation_label', { role: pt.role, type: pt.source_object_type })}</div>
                      <div className="flex flex-wrap items-center gap-1.5 mt-1">
                        <SpaceBadge spaceId={pt.source_space_id} />
                        <span className="text-[10px] text-muted-foreground" style={{ fontFamily: 'var(--font-mono)' }}>{fmt(pt.occurred_at, locale)}</span>
                      </div>
                    </div>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </Card>
    </div>
  )
}

/* ── Recent Timeline (cross-space pointers) ──────────────────────────────────── */
function RecentTimeline({ timeline, onOpen }: { timeline: MeTimelineEntry[]; onOpen: (spaceId: string, path: string) => void }) {
  const { t, locale } = useAppTranslation()
  if (timeline.length === 0) return null
  return (
    <div>
      <Eyebrow count={timeline.length}>{t('home.recent_timeline')}</Eyebrow>
      <Card className="p-4">
        <ul className="m-0 p-0 list-none flex flex-col gap-2.5">
          {timeline.slice(0, 12).map(entry => {
            const path = objectPath(entry.source_object_type, entry.source_object_id)
            const label = t('home.timeline_label', { role: entry.role ?? t('home.touched'), type: entry.source_object_type ?? t('home.item') })
            return (
              <li key={entry.id} className="flex items-center justify-between gap-3">
                <div className="min-w-0 flex items-center gap-2">
                  <span className="size-1.5 rounded-full bg-muted-foreground/40 shrink-0" />
                  {path && entry.source_space_id ? (
                    <button type="button" onClick={() => onOpen(entry.source_space_id!, path)} className="text-[13px] text-accent-foreground hover:underline truncate">
                      {label}
                    </button>
                  ) : (
                    <span className="text-[13px] text-foreground truncate">{label}</span>
                  )}
                  <SpaceBadge spaceId={entry.source_space_id} />
                </div>
                <span className="text-[10px] text-muted-foreground shrink-0" style={{ fontFamily: 'var(--font-mono)' }}>{fmt(entry.occurred_at, locale)}</span>
              </li>
            )
          })}
        </ul>
      </Card>
    </div>
  )
}

/* ── Suggested Actions (derived from real aggregate, never fabricated) ───────── */
interface Suggestion { id: string; label: string; reason: string; to: string }

function SuggestedActions({ suggestions, onGo }: { suggestions: Suggestion[]; onGo: (path: string) => void }) {
  const { t } = useAppTranslation()
  if (suggestions.length === 0) return null
  return (
    <div>
      <Eyebrow>{t('home.suggested')}</Eyebrow>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
        {suggestions.map(s => (
          <button
            key={s.id}
            type="button"
            onClick={() => onGo(s.to)}
            className="text-left bg-card border border-border rounded-lg p-3.5 hover:bg-accent transition-colors"
          >
            <div className="text-[13px] font-medium text-foreground">{s.label}</div>
            <div className="text-[11px] text-muted-foreground mt-0.5">{s.reason}</div>
          </button>
        ))}
      </div>
    </div>
  )
}

/* ── Right panel ─────────────────────────────────────────────────────────────── */
function RightPanel({
  summary, pending, tasks, onOpen, onGo, canUseContextOps,
}: {
  summary: MeSummaryOut
  pending: MePendingProposalItem[]
  tasks: MeTaskItem[]
  onOpen: (spaceId: string, path: string) => void
  onGo: (path: string) => void
  canUseContextOps: boolean
}) {
  const { t } = useAppTranslation()
  const activeRuns = summary.recent_runs.filter(r => r.status === 'running' || r.status === 'queued')
  const contextLayerItems = [
    ...(canUseContextOps ? [{ label: t('home.context_health'), path: '/context-ops' }] : []),
    { label: t('home.maintenance_scans'), path: '/automations' },
    { label: t('home.briefs_and_reports'), path: '/artifacts' },
    { label: t('home.source_governance'), path: '/sources' },
    { label: t('home.retrieval_settings'), path: '/retrieval-settings' },
  ]
  return (
    <div className="flex flex-col gap-3 min-w-0">
      <Card className="p-4 flex flex-col gap-2.5">
        <div className="flex items-baseline justify-between">
          <span className="text-[11px] font-bold tracking-[.1em] uppercase text-muted-foreground">{t('home.pending_review')}</span>
          <button onClick={() => onGo('/proposals')} className="text-[11px] text-accent-foreground flex items-center gap-1 hover:underline">
            {t('home.all')} <ChevronRight className="size-3" />
          </button>
        </div>
        {pending.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">{t('home.no_pending_proposals')}</p>
        ) : pending.slice(0, 4).map(p => (
          <button key={p.id} onClick={() => onOpen(p.space_id, `/proposals/${p.id}`)} className="text-left rounded-md -mx-1 px-1 py-1 hover:bg-accent transition-colors">
            <div className="text-[12px] text-foreground truncate">{p.title}</div>
            <div className="mt-0.5"><SpaceBadge spaceId={p.space_id} /></div>
          </button>
        ))}
      </Card>

      <Card className="p-4 flex flex-col gap-2.5">
        <span className="text-[11px] font-bold tracking-[.1em] uppercase text-muted-foreground">{t('home.active_runs')}</span>
        {activeRuns.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">{t('home.no_active_runs')}</p>
        ) : activeRuns.slice(0, 5).map(r => (
          <button key={r.id} onClick={() => onOpen(r.space_id, `/runs/${r.id}`)} className="text-left rounded-md -mx-1 px-1 py-1 hover:bg-accent transition-colors flex items-center gap-2">
            <StatusBadge status={r.status} />
            <SpaceBadge spaceId={r.space_id} />
          </button>
        ))}
      </Card>

      <Card className="p-4 flex flex-col gap-2.5">
        <span className="text-[11px] font-bold tracking-[.1em] uppercase text-muted-foreground">{t('home.your_tasks')}</span>
        {tasks.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">{t('home.no_tasks_assigned')}</p>
        ) : tasks.slice(0, 5).map(t => (
          <button key={t.id} onClick={() => onOpen(t.space_id, `/tasks/${t.id}`)} className="text-left rounded-md -mx-1 px-1 py-1 hover:bg-accent transition-colors">
            <div className="text-[12px] text-foreground truncate">{t.title}</div>
            <div className="flex items-center gap-1.5 mt-0.5"><StatusBadge status={t.status} /><SpaceBadge spaceId={t.space_id} /></div>
          </button>
        ))}
      </Card>

      <Card className="p-4 flex flex-col gap-2.5">
        <span className="text-[11px] font-bold tracking-[.1em] uppercase text-muted-foreground">{t('home.context_layer')}</span>
        {contextLayerItems.map(item => (
          <button
            key={item.path}
            onClick={() => onGo(item.path)}
            className="text-left rounded-md -mx-1 px-1 py-1 hover:bg-accent transition-colors flex items-center gap-2"
          >
            <Cpu className="size-3.5 text-muted-foreground" />
            <span className="text-[12px] text-foreground">{item.label}</span>
          </button>
        ))}
      </Card>
    </div>
  )
}

/* ── Page ────────────────────────────────────────────────────────────────────── */
export default function HomePage() {
  const { t, locale } = useAppTranslation()
  const navigate = useNavigate()
  const { currentUser } = useAuth()
  const { spaces, preferredSpaceId } = useSpace()
  const preferredSpace = spaces.find(space => space.id === preferredSpaceId)
  const canManagePreferredSpace = preferredSpace?.role === 'owner' || preferredSpace?.role === 'admin'
  const preferredSpaceCanMemberReview = preferredSpace?.role === 'reviewer' || preferredSpace?.role === 'member'
  const [preferredContextOpsReviewMode, setPreferredContextOpsReviewMode] = useState<'private_only' | 'admins' | 'members'>('private_only')
  const [preferredContextOpsScanMode, setPreferredContextOpsScanMode] = useState<'admins' | 'members'>('admins')

  const [summary, setSummary] = useState<MeSummaryOut | null>(null)
  const [timeline, setTimeline] = useState<MeTimelineEntry[]>([])
  const [tasks, setTasks] = useState<MeTaskItem[]>([])
  const [pending, setPending] = useState<MePendingProposalItem[]>([])
  const [loading, setLoading] = useState(true)

  // Home is user-scoped: it reads cross-space /me aggregates and is NEVER filtered by the
  // active Space. (meApi calls omit space params by design.)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const [s, tl, t, p] = await Promise.all([
          meApi.summary({ recent_runs_limit: '8', recent_participation_limit: '6' }),
          meApi.timeline({ limit: '20' }),
          meApi.tasks({ limit: '20' }),
          meApi.pending({ limit: '20' }),
        ])
        if (cancelled) return
        setSummary(s); setTimeline(tl); setTasks(t.items); setPending(p)
      } catch (e) {
        if (!cancelled) toast.error(errMsg(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!preferredSpaceId) {
      setPreferredContextOpsReviewMode('private_only')
      setPreferredContextOpsScanMode('admins')
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const settings = await spacesApi.getRetrievalSettings(preferredSpaceId)
        if (!cancelled) {
          setPreferredContextOpsReviewMode(settings.context_ops_review_mode)
          setPreferredContextOpsScanMode(settings.context_ops_scan_mode)
        }
      } catch {
        if (!cancelled) {
          setPreferredContextOpsReviewMode('private_only')
          setPreferredContextOpsScanMode('admins')
        }
      }
    })()
    return () => { cancelled = true }
  }, [preferredSpaceId])

  // Cross-space items carry their own Space id → open them in that Space's URL.
  const openInSpace = useCallback((spaceId: string, path: string) => {
    navigate(spacePath(spaceId || preferredSpaceId, path))
  }, [navigate, preferredSpaceId])

  // Aggregate shortcuts (no single Space) open the preferred Space's list.
  const goList = useCallback((path: string) => {
    navigate(spacePath(preferredSpaceId, path))
  }, [navigate, preferredSpaceId])

  const greeting = useMemo(() => {
    const h = new Date().getHours()
    return h < 5 ? 'hello' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 22 ? 'evening' : 'hello'
  }, [])

  const displayName = currentUser?.display_name ?? t('home.there')
  const s = summary
  const canUsePreferredContextOps = canManagePreferredSpace || (
    preferredSpaceCanMemberReview
    && (preferredContextOpsReviewMode === 'members' || preferredContextOpsScanMode === 'members')
  )

  const suggestions: Suggestion[] = useMemo(() => {
    if (!s) return []
    const out: Suggestion[] = []
    if (s.pending_proposals_count > 0) out.push({ id: 'review', label: t('home.review_pending_proposals'), reason: t('home.proposals_waiting_across_spaces', { total: s.pending_proposals_count }), to: '/proposals' })
    if (s.recent_runs.some(r => r.status === 'failed')) out.push({ id: 'failed', label: t('home.inspect_failed_runs'), reason: t('home.recent_runs_failed_reason'), to: '/runs' })
    if (s.assigned_tasks_count > 0) out.push({ id: 'tasks', label: t('home.pick_up_your_tasks'), reason: t('home.tasks_assigned_count', { total: s.assigned_tasks_count }), to: '/tasks' })
    out.push({ id: 'review-artifacts', label: t('home.review_analysis_artifacts'), reason: t('home.artifacts_reason'), to: '/artifacts' })
    out.push({ id: 'capture', label: t('home.process_your_captures'), reason: t('home.captures_reason'), to: '/activity' })
    return out
  }, [s, t, locale])

  const failedRunSpaces = useMemo(() => (s ? s.recent_runs.filter(r => r.status === 'failed').map(r => r.space_id) : []), [s])

  return (
    <div className="page-dashboard">
      {/* main */}
      <div className="flex flex-col gap-5 min-w-0">
        <div className="flex flex-col gap-1">
          <div className="text-[10px] font-bold tracking-[.1em] uppercase" style={{ color: 'color-mix(in oklch, var(--muted-foreground) 70%, transparent)' }}>
            {t((spaces.length || s?.accessible_spaces_count) === 1 ? 'home.across_one' : 'home.across_many', { total: spaces.length || (s?.accessible_spaces_count ?? 0) })}
          </div>
          <h1 className="text-2xl font-semibold tracking-tight m-0">
            {t(`home.greeting_${greeting}`)}{t('home.greeting_separator')}<span className="text-accent-foreground">{displayName}</span>{t('home.greeting_end')}
          </h1>
          <p className="text-[13px] text-muted-foreground">
            {t('home.command_center_description')}
          </p>
        </div>


        {loading || !s ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : (
          <>
            <NeedsAttention summary={s} failedRunSpaces={failedRunSpaces} onGo={goList} />
            <BySpace spaces={s.spaces} onOpen={openInSpace} />
            <ReviewPackets pending={pending} onOpen={openInSpace} />
            <ContinueWorking summary={s} onOpen={openInSpace} />
            <SuggestedActions suggestions={suggestions} onGo={goList} />
            <RecentTimeline timeline={timeline} onOpen={openInSpace} />
          </>
        )}
      </div>

      {/* right panel */}
      {loading || !s ? (
        <Skeleton className="h-72 w-full" />
      ) : (
        <RightPanel
          summary={s}
          pending={pending}
          tasks={tasks}
          onOpen={openInSpace}
          onGo={goList}
          canUseContextOps={canUsePreferredContextOps}
        />
      )}
    </div>
  )
}
