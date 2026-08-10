import { useState } from 'react'
import { ExternalLink } from 'lucide-react'
import type { InformationDigest, Project } from '../../types/api'
import { Badge } from '../../components/ui/badge'
import { Card } from '../../components/ui/card'
import { EmptyState } from '../../components/ui/empty-state'
import { SpaceLink as Link } from '../../core/spaceNav'

type Feedback = 'interesting' | 'neutral' | 'never'

export function InformationDigestView({ digest, project = false, onSerendipityFeedback, projects = [], onFileToProject }: {
  digest: InformationDigest
  project?: boolean
  onSerendipityFeedback?: (itemId: string, feedback: Feedback) => Promise<void>
  projects?: Array<Pick<Project, 'id' | 'name'>>
  onFileToProject?: (itemId: string, sourceItemId: string, projectId: string) => Promise<void>
}) {
  const [projectByItem, setProjectByItem] = useState<Record<string, string>>({})
  if (digest.items.length === 0) {
    return (
      <EmptyState
        title="Nothing new today"
        description={project
          ? "No newly admitted, annotated Source items entered this Project's Corpus today."
          : 'No annotated items arrived today from your subscribed sources.'}
      />
    )
  }
  const interest = digest.items.filter(item => item.section === 'interest')
  const serendipity = digest.items.filter(item => item.section === 'serendipity')
  const renderItems = (items: InformationDigest['items']) => items.map(item => (
        <Card key={item.id} className="p-4 space-y-2">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <Link className="font-medium hover:underline" to={`/library/items/${item.source_item_id}`}>
                {item.title}
              </Link>
              <div className="mt-1 flex flex-wrap gap-1.5">
                <Badge variant="outline">{item.domain_key}</Badge>
                <Badge variant="muted">{item.depth}</Badge>
                <Badge variant="muted">{item.genre}</Badge>
                {item.read_status !== 'unread' && <Badge variant="success">{item.read_status}</Badge>}
                {project && item.anonymous_read_count !== null && <Badge variant="outline">{item.anonymous_read_count} people read this</Badge>}
              </div>
            </div>
            {item.source_uri && (
              <a className="text-muted-foreground hover:text-foreground" href={item.source_uri} target="_blank" rel="noreferrer" aria-label={`Open source for ${item.title}`}>
                <ExternalLink className="size-4" />
              </a>
            )}
          </div>
          {(item.summary || item.excerpt) && <p className="text-sm text-muted-foreground">{item.summary ?? item.excerpt}</p>}
          {item.rationale && <p className="text-xs text-muted-foreground border-l-2 pl-2">{item.rationale}</p>}
          <div className="text-[11px] text-muted-foreground">
            Slot {item.quota_slot} · score {item.score.toFixed(3)}
          </div>
          {item.section === 'serendipity' && onSerendipityFeedback && (
            item.serendipity_feedback ? (
              <p className="text-xs text-muted-foreground" role="status">
                Feedback: {item.serendipity_feedback === 'interesting' ? 'Interesting — keep going' : item.serendipity_feedback === 'neutral' ? 'Neutral' : 'Never this direction again'}
              </p>
            ) : (
              <div className="flex flex-wrap gap-2" aria-label={`Serendipity feedback for ${item.title}`}>
                <button className="rounded border px-2 py-1 text-xs hover:bg-accent" type="button" onClick={() => void onSerendipityFeedback(item.id, 'interesting')}>Interesting — keep going</button>
                <button className="rounded border px-2 py-1 text-xs hover:bg-accent" type="button" onClick={() => void onSerendipityFeedback(item.id, 'neutral')}>Neutral</button>
                <button className="rounded border px-2 py-1 text-xs text-destructive hover:bg-destructive/10" type="button" onClick={() => void onSerendipityFeedback(item.id, 'never')}>Never this direction again</button>
              </div>
            )
          )}
          {!project && onFileToProject && projects.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 border-t pt-2">
              <select
                className="h-8 rounded border bg-background px-2 text-xs"
                aria-label={`Project for ${item.title}`}
                value={projectByItem[item.id] ?? ''}
                onChange={event => setProjectByItem(current => ({ ...current, [item.id]: event.target.value }))}
              >
                <option value="">File into a Project…</option>
                {projects.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
              </select>
              <button
                className="rounded border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
                type="button"
                disabled={!projectByItem[item.id]}
                onClick={() => void onFileToProject(item.id, item.source_item_id, projectByItem[item.id]!)}
              >
                Add to Project Corpus
              </button>
            </div>
          )}
        </Card>
      ))
  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold">For your interests</h3>
          <p className="text-xs text-muted-foreground">Balanced across recency, relevance, and source diversity.</p>
        </div>
        {renderItems(interest)}
      </section>
      {serendipity.length > 0 && (
        <section className="space-y-3 border-t pt-5">
          <div>
            <h3 className="text-sm font-semibold">Outside your usual view</h3>
            <p className="text-xs text-muted-foreground">A separate quota from outside your subscriptions; it does not change your interest profile.</p>
          </div>
          {renderItems(serendipity)}
        </section>
      )}
    </div>
  )
}
