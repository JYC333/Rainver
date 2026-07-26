import { useCallback, useEffect, useState } from 'react'
import { SpaceLink as Link } from '../../core/spaceNav'
import { ArrowRight, Clock } from 'lucide-react'
import { toast } from 'sonner'
import { knowledgeApi, notesApi, knowledgeSourcesApi } from '../../api/client'
import { useSpace } from '../../contexts/SpaceContext'
import { errMsg } from '../../lib/utils'
import type { KnowledgeItemSummary, KnowledgeSourceSummary, KnowledgeSummary, NoteSummary } from '../../types/api'
import { Card, CardTitle } from '../../components/ui/card'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Skeleton } from '../../components/ui/skeleton'
import { EmptyState } from '../../components/ui/empty-state'
import KnowledgeSectionHeader from './KnowledgeSectionHeader'
import RetrievalBriefPanel from './RetrievalBriefPanel'

function fmt(dt: string | null | undefined) {
  return dt ? new Date(dt).toLocaleString() : '—'
}

function recent<T extends { updated_at: string }>(items: T[], n: number): T[] {
  return [...items].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1)).slice(0, n)
}

/** Sources still awaiting curation (raw/processing) — honest "needs review" set. */
function needsReview(s: KnowledgeSourceSummary): boolean {
  return s.status === 'raw' || s.status === 'processing'
}

/**
 * Knowledge Home — an optional, lightweight status hub (reached via the breadcrumb
 * switcher or a direct link, never the forced default landing). It surfaces real
 * recent activity with honest empty states; it is not a menu grid and does not
 * compete with the Notes/Wiki/Sources/Cards sections.
 */
export default function KnowledgeOverviewPage() {
  const { activeSpaceId } = useSpace()
  const [summary, setSummary] = useState<KnowledgeSummary | null>(null)
  const [notes, setNotes] = useState<NoteSummary[]>([])
  const [wiki, setWiki] = useState<KnowledgeItemSummary[]>([])
  const [sources, setSources] = useState<KnowledgeSourceSummary[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!activeSpaceId) {
      setSummary(null); setNotes([]); setWiki([]); setSources([]); setLoading(false)
      return
    }
    setLoading(true)
    try {
      const [s, n, w, src] = await Promise.all([
        knowledgeApi.summary().catch(() => null),
        notesApi.list({ limit: 50 }).then(p => p.items).catch(() => [] as NoteSummary[]),
        knowledgeApi.list({ status: 'active', limit: 50 }).then(p => p.items).catch(() => [] as KnowledgeItemSummary[]),
        knowledgeSourcesApi.list({ limit: 50 }).then(p => p.items).catch(() => [] as KnowledgeSourceSummary[]),
      ])
      setSummary(s); setNotes(n); setWiki(w); setSources(src)
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setLoading(false)
    }
  }, [activeSpaceId])

  useEffect(() => { load() }, [load])

  const resume = recent(notes, 1)[0] ?? null
  const reviewSources = sources.filter(needsReview)

  return (
    <div className="p-6 space-y-6">
      <KnowledgeSectionHeader
        section="home"
        actions={
          <Button size="sm" variant="outline" asChild>
            <Link to="/knowledge/notes">Open Notes</Link>
          </Button>
        }
      />

      {!activeSpaceId ? (
        <Card>
          <EmptyState
            title="Select an operational space"
            description="Choose a space to see its Knowledge activity."
          />
        </Card>
      ) : loading ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <>
          {/* Counts */}
          <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
            <CountCard label="Notes" value={summary?.notes.active ?? notes.filter(n => n.status === 'active').length}
              hint={`${summary?.notes.total ?? notes.length} total · ${summary?.notes.archived ?? 0} archived`} to="/knowledge/notes" />
            <CountCard label="Wiki" value={summary?.wiki.active ?? wiki.length} hint="active canonical items" to="/knowledge/wiki" />
            <CountCard label="Sources" value={summary?.sources.total ?? sources.length} hint={`${reviewSources.length} need review`} to="/knowledge/sources" />
            <CountCard label="Cards" value="—" hint="coming soon" to="/knowledge/cards" />
          </div>

          {/* Continue working */}
          <Card>
            <CardTitle className="flex items-center gap-1.5"><Clock className="size-3.5" /> Continue working</CardTitle>
            {resume ? (
              <Link
                to={`/knowledge/notes/${resume.id}`}
                className="mt-3 flex items-center justify-between gap-3 rounded-md border border-border p-3 hover:bg-accent/30"
              >
                <div className="min-w-0">
                  <p className="font-medium text-sm truncate">{resume.title}</p>
                  <p className="text-xs text-muted-foreground">Edited {fmt(resume.updated_at)}</p>
                </div>
                <ArrowRight className="size-4 text-muted-foreground shrink-0" />
              </Link>
            ) : (
              <p className="mt-3 text-sm text-muted-foreground">No recent notes yet. Start one from the Notes section.</p>
            )}
          </Card>

          {/* Compact status sections */}
          <RetrievalBriefPanel hasOperationalSpace={Boolean(activeSpaceId)} />

          <div className="grid gap-3 lg:grid-cols-2">
            <SectionCard title="Recent notes" to="/knowledge/notes" actionLabel="All notes">
              {recent(notes, 5).length === 0 ? (
                <EmptyText>No notes yet — capture your first working note.</EmptyText>
              ) : (
                recent(notes, 5).map(n => (
                  <RowLink key={n.id} to={`/knowledge/notes/${n.id}`} title={n.title} meta={fmt(n.updated_at)} badge={n.status} />
                ))
              )}
            </SectionCard>

            <SectionCard title="Recent wiki updates" to="/knowledge/wiki" actionLabel="Open Wiki">
              {recent(wiki, 5).length === 0 ? (
                <EmptyText>No canonical wiki items yet.</EmptyText>
              ) : (
                recent(wiki, 5).map(w => (
                  <RowLink key={w.id} to={`/knowledge/wiki/${w.id}`} title={w.title} meta={fmt(w.updated_at)} badge={w.knowledge_kind} />
                ))
              )}
            </SectionCard>

            <SectionCard title="Sources needing review" to="/knowledge/sources" actionLabel="All sources">
              {reviewSources.length === 0 ? (
                <EmptyText>No sources need review.</EmptyText>
              ) : (
                recent(reviewSources, 5).map(s => (
                  <RowLink key={s.id} to="/knowledge/sources" title={s.title} meta={fmt(s.created_at)} badge={s.status} />
                ))
              )}
            </SectionCard>

            <SectionCard title="Process captures" to="/activity" actionLabel="Open Inbox">
              <p className="text-sm text-muted-foreground">
                Captures and activities are raw material — review them in the Activity Inbox, then turn them into Notes or Wiki items.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" variant="outline" asChild><Link to="/activity">Activity Inbox</Link></Button>
                <Button size="sm" variant="outline" asChild><Link to="/capture">Capture something</Link></Button>
              </div>
            </SectionCard>

            <SectionCard title="Cards due" to="/knowledge/cards" actionLabel="Open Cards">
              <EmptyText>Spaced-repetition review cards are coming soon.</EmptyText>
            </SectionCard>
          </div>
        </>
      )}
    </div>
  )
}

function CountCard({ label, value, hint, to }: { label: string; value: number | string; hint: string; to: string }) {
  return (
    <Link to={to} className="block">
      <Card className="hover:bg-accent/30 transition-colors mb-0">
        <CardTitle>{label}</CardTitle>
        <p className="text-2xl font-semibold mt-1">{value}</p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </Card>
    </Link>
  )
}

function SectionCard({ title, to, actionLabel, children }: { title: string; to: string; actionLabel: string; children: React.ReactNode }) {
  return (
    <Card className="h-full mb-0">
      <div className="flex items-center justify-between gap-2">
        <CardTitle className="mb-0">{title}</CardTitle>
        <Link to={to} className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-0.5">
          {actionLabel} <ArrowRight className="size-3" />
        </Link>
      </div>
      <div className="mt-3 space-y-1">{children}</div>
    </Card>
  )
}

function RowLink({ to, title, meta, badge }: { to: string; title: string; meta: string; badge?: string }) {
  return (
    <Link to={to} className="flex items-center justify-between gap-2 rounded-md -mx-1 px-1 py-1.5 hover:bg-accent/30">
      <div className="flex items-center gap-1.5 min-w-0">
        <span className="text-sm truncate">{title}</span>
        {badge && <Badge variant="outline" className="shrink-0">{badge}</Badge>}
      </div>
      <span className="text-xs text-muted-foreground shrink-0">{meta}</span>
    </Link>
  )
}

function EmptyText({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>
}
