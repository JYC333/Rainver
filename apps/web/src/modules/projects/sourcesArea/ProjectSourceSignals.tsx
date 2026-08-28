import { useCallback, useEffect, useState } from 'react'
import { CheckCircle, FileText, Target } from 'lucide-react'
import { readerApi, sourcesApi } from '../../../api/client'
import { SpaceLink as Link } from '../../../core/spaceNav'
import { Badge } from '../../../components/ui/badge'
import { Card } from '../../../components/ui/card'
import type {
  ExtractedEvidence, ReaderAnnotation, SourceChannel, SourcePostProcessingItemDecision,
} from '../../../types/api'

/**
 * What the Project's bound sources have produced beyond the raw item list:
 * active evidence, post-processing relevance decisions, and shared reader
 * annotations.
 */
export function ProjectSourceSignals({
  projectId,
  channels,
}: {
  projectId: string
  channels: SourceChannel[]
}) {
  const [evidence, setEvidence] = useState<ExtractedEvidence[]>([])
  const [recommendations, setRecommendations] = useState<SourcePostProcessingItemDecision[]>([])
  const [annotations, setAnnotations] = useState<ReaderAnnotation[]>([])

  const load = useCallback(async () => {
    if (!projectId) return
    await Promise.all([
      sourcesApi.evidence({ project_id: projectId, status: 'active', limit: 5 })
        .then(rows => setEvidence(rows.items))
        .catch(() => setEvidence([])),
      sourcesApi.postProcessingDecisions({ project_id: projectId, limit: 20 })
        .then(rows => setRecommendations(rows.items.filter(item => item.relevance !== 'not_relevant').slice(0, 5)))
        .catch(() => setRecommendations([])),
      readerApi.listByProject(projectId, 5)
        .then(rows => setAnnotations(rows.items))
        .catch(() => setAnnotations([])),
    ])
  }, [projectId])

  useEffect(() => { void load() }, [load])

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Derived from these sources</h2>
      <div className="grid gap-3 lg:grid-cols-3">
        <Card className="p-4">
          <div className="mb-3 flex items-center gap-2 text-muted-foreground">
            <CheckCircle className="size-3.5" />
            <span className="text-xs font-medium uppercase tracking-wide">Active evidence</span>
          </div>
          {evidence.length === 0 ? (
            <p className="text-xs text-muted-foreground">No active evidence is linked to this project.</p>
          ) : (
            <div className="space-y-2">
              {evidence.map(row => (
                <div key={row.id} className="min-w-0">
                  <p className="truncate text-sm font-medium">{row.title}</p>
                  <p className="line-clamp-2 text-xs text-muted-foreground">{row.content_excerpt ?? row.source_uri ?? row.evidence_type}</p>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card className="p-4">
          <div className="mb-3 flex items-center gap-2 text-muted-foreground">
            <Target className="size-3.5" />
            <span className="text-xs font-medium uppercase tracking-wide">Source recommendations</span>
          </div>
          {recommendations.length === 0 ? (
            <p className="text-xs text-muted-foreground">No post-processing recommendations for this project yet.</p>
          ) : (
            <div className="space-y-2">
              {recommendations.map(decision => {
                const channel = channels.find(item => item.id === decision.source_channel_id)
                return (
                  <div key={decision.id} className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <Badge variant={decision.relevance === 'relevant' ? 'default' : decision.relevance === 'maybe' ? 'outline' : 'muted'}>
                        {decision.relevance}
                      </Badge>
                      {decision.confidence !== null && <Badge variant="muted">{Math.round(decision.confidence * 100)}%</Badge>}
                    </div>
                    <p className="mt-1 truncate text-sm font-medium">{decision.item.title ?? decision.source_item_id}</p>
                    <p className="line-clamp-2 text-xs text-muted-foreground">{decision.reason ?? decision.item.source_domain ?? decision.review_status}</p>
                    {channel && (
                      <Link to={`/sources/${channel.source_connection_id}`} className="mt-1 block text-xs text-accent-foreground hover:underline">
                        {channel.source_name}
                      </Link>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </Card>

        <Card className="p-4">
          <div className="mb-3 flex items-center gap-2 text-muted-foreground">
            <FileText className="size-3.5" />
            <span className="text-xs font-medium uppercase tracking-wide">Reader annotations</span>
          </div>
          {annotations.length === 0 ? (
            <p className="text-xs text-muted-foreground">No shared reader annotations from sources bound to this project.</p>
          ) : (
            <div className="space-y-2">
              {annotations.map(annotation => (
                annotation.document_type === 'source_item' ? (
                  <Link
                    key={annotation.id}
                    to={`/library/items/${annotation.document_id}`}
                    className="-mx-1 block min-w-0 rounded px-1 py-0.5 transition-colors hover:bg-muted/50"
                  >
                    <p className="text-xs capitalize text-muted-foreground">{annotation.annotation_type}</p>
                    <p className="line-clamp-2 text-sm italic">{annotation.quote_text}</p>
                  </Link>
                ) : (
                  <div key={annotation.id} className="min-w-0">
                    <p className="text-xs capitalize text-muted-foreground">{annotation.annotation_type}</p>
                    <p className="line-clamp-2 text-sm italic">{annotation.quote_text}</p>
                  </div>
                )
              ))}
            </div>
          )}
        </Card>
      </div>
    </section>
  )
}
