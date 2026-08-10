import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import type { GraphProjection, GraphProjectionNode } from '@agent-space/protocol'
import { AlertTriangle, Ban, FlaskConical, HelpCircle } from 'lucide-react'
import { inquiryApi } from '../../../api/client'
import { errMsg } from '../../../lib/utils'
import { useTheme } from '../../../contexts/ThemeContext'
import type { InquiryCandidate, InquiryThread } from '../../../types/api'
import { Badge } from '../../../components/ui/badge'
import { Card } from '../../../components/ui/card'
import { EmptyState } from '../../../components/ui/empty-state'
import { Skeleton } from '../../../components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../components/ui/tabs'
import { flattenThreadTree } from './threadGrouping'

const GraphView = lazy(async () => {
  const graph = await import('../../../components/graph')
  return { default: graph.GraphView }
})

/** A blocked Thread shows its blocker instead, so the two never both appear. */
function nextFocusLabel(thread: InquiryThread): string | null {
  if (thread.blocked_reason) return null
  return thread.next_focus_kind ? thread.next_focus_kind.replace(/_/g, ' ') : null
}

function StructureTree({ threads, candidates, selectedId, onSelect }: {
  threads: InquiryThread[]
  candidates: InquiryCandidate[]
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  const pendingByThread = new Map<string, number>()
  for (const candidate of candidates) {
    pendingByThread.set(candidate.thread_id, (pendingByThread.get(candidate.thread_id) ?? 0) + 1)
  }
  const rows = flattenThreadTree(threads)

  if (rows.length === 0) {
    return <EmptyState title="No Questions or Hypotheses yet" description="Create a Thread to start mapping this Project." />
  }

  return (
    <div className="space-y-1 py-2">
      {rows.map(({ thread, depth }) => {
        const pending = pendingByThread.get(thread.id) ?? 0
        return (
          <button
            key={thread.id}
            type="button"
            onClick={() => onSelect(thread.id)}
            style={{ marginLeft: `${Math.min(depth, 6) * 20}px` }}
            className={`flex w-full items-center gap-2 rounded-md border p-2 text-left transition-colors ${
              selectedId === thread.id ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'
            }`}
          >
            {thread.kind === 'question'
              ? <HelpCircle className="size-4 shrink-0 text-muted-foreground" />
              : <FlaskConical className="size-4 shrink-0 text-accent-foreground" />}
            <span className="min-w-0 flex-1 truncate text-sm">{thread.statement}</span>
            {thread.lifecycle_status !== 'active' && (
              <Badge variant="secondary" className="text-[10px]">{thread.lifecycle_status}</Badge>
            )}
            {thread.blocked_reason && (
              <span className="flex shrink-0 items-center gap-1 text-[11px] text-destructive">
                <Ban className="size-3" />blocked
              </span>
            )}
            {nextFocusLabel(thread) && (
              <span className="shrink-0 text-[11px] text-muted-foreground">{nextFocusLabel(thread)}</span>
            )}
            {pending > 0 && (
              <span className="flex shrink-0 items-center gap-1 text-[11px] text-amber-600">
                <AlertTriangle className="size-3" />{pending}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

function RelationGraph({ projectId, onSelect }: { projectId: string; onSelect: (id: string) => void }) {
  const { theme } = useTheme()
  const [projection, setProjection] = useState<GraphProjection | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    inquiryApi.graph(projectId)
      .then(result => { if (!cancelled) { setProjection(result); setError(null) } })
      .catch(loadError => { if (!cancelled) setError(errMsg(loadError)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [projectId])

  const handleNodeSelect = useCallback((node: GraphProjectionNode | null) => {
    if (node) onSelect(node.id)
  }, [onSelect])

  if (loading) return <Skeleton className="h-[520px] w-full" />
  if (error) return <p className="py-6 text-sm text-destructive">{error}</p>
  if (!projection || projection.nodes.length === 0) {
    return <EmptyState title="Nothing to map yet" description="Typed relations between Threads appear here once they exist." />
  }

  return (
    <div className="py-2">
      <Suspense fallback={<Skeleton className="h-[520px] w-full" />}>
        <GraphView
          projection={projection}
          themeMode={theme}
          onNodeSelect={handleNodeSelect}
          className="h-[520px] w-full"
        />
      </Suspense>
      <p className="mt-2 text-xs text-muted-foreground">
        Select a Thread to open it in the Focus view. Edges are working Project relations, not canonical Ontology relations.
      </p>
    </div>
  )
}

/**
 * The step-back view. The structure tree answers "what is this Project
 * chasing and where is it stuck"; the relation graph answers "how do these
 * Threads bear on each other" — the same split the domain already makes
 * between the acyclic primary-parent tree and typed relations.
 */
export function MapView({ projectId, threads, candidates, selectedId, onSelect }: {
  projectId: string
  threads: InquiryThread[]
  candidates: InquiryCandidate[]
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  const [tab, setTab] = useState('structure')

  return (
    <Card className="p-4">
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="structure">Structure</TabsTrigger>
          <TabsTrigger value="relations">Relations</TabsTrigger>
        </TabsList>
        <TabsContent value="structure">
          <StructureTree threads={threads} candidates={candidates} selectedId={selectedId} onSelect={onSelect} />
        </TabsContent>
        <TabsContent value="relations">
          <RelationGraph projectId={projectId} onSelect={onSelect} />
        </TabsContent>
      </Tabs>
    </Card>
  )
}
