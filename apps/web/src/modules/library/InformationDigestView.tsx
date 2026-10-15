import { useState } from 'react'
import { ExternalLink } from 'lucide-react'
import type { InformationDigest, Project } from '../../types/api'
import { Badge } from '../../components/ui/badge'
import { Card } from '../../components/ui/card'
import { EmptyState } from '../../components/ui/empty-state'
import { SpaceLink as Link } from '../../core/spaceNav'
import { SafeExternalLink } from '../../components/SafeExternalLink'
import { useAppTranslation } from '../../i18n'
import { formatNumber } from '../../i18n/format'

type Feedback = 'interesting' | 'neutral' | 'never'

export function InformationDigestView({ digest, project = false, onSerendipityFeedback, projects = [], onFileToProject }: {
  digest: InformationDigest
  project?: boolean
  onSerendipityFeedback?: (itemId: string, feedback: Feedback) => Promise<void>
  projects?: Array<Pick<Project, 'id' | 'name'>>
  onFileToProject?: (itemId: string, sourceItemId: string, projectId: string) => Promise<void>
}) {
  const { t } = useAppTranslation()
  const [projectByItem, setProjectByItem] = useState<Record<string, string>>({})
  if (digest.items.length === 0) {
    return (
      <EmptyState
        title={t('workspace_ui.digest.empty_title')}
        description={project ? t('workspace_ui.digest.empty_project') : t('workspace_ui.digest.empty_personal')}
      />
    )
  }
  const interest = digest.items.filter(item => item.section === 'interest')
  const serendipity = digest.items.filter(item => item.section === 'serendipity')
  const renderItems = (items: InformationDigest['items']) => items.map(item => (
        <Card key={item.id} className="p-4 space-y-2">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <Link className="font-medium hover:underline" to={`/library/items/${item.source_item_id}${item.section === 'serendipity' ? '?from=serendipity' : ''}`}>
                {item.title}
              </Link>
              <div className="mt-1 flex flex-wrap gap-1.5">
                <Badge variant="outline">{item.domain_key}</Badge>
                <Badge variant="muted">{item.depth}</Badge>
                <Badge variant="muted">{item.genre}</Badge>
                {item.read_status !== 'unread' && <Badge variant="success">{item.read_status}</Badge>}
                {project && item.anonymous_read_count !== null && <Badge variant="outline">{t('workspace_ui.digest.people_read', { count: item.anonymous_read_count })}</Badge>}
              </div>
            </div>
            {item.source_uri && (
              <SafeExternalLink className="text-muted-foreground hover:text-foreground" href={item.source_uri} aria-label={t('workspace_ui.digest.open_source', { title: item.title })}>
                <ExternalLink className="size-4" />
              </SafeExternalLink>
            )}
          </div>
          {(item.summary || item.excerpt) && <p className="text-sm text-muted-foreground">{item.summary ?? item.excerpt}</p>}
          {item.rationale && <p className="text-xs text-muted-foreground border-l-2 pl-2">{item.rationale}</p>}
          <div className="text-[11px] text-muted-foreground">
            {t('workspace_ui.digest.slot_score', { slot: item.quota_slot, score: formatNumber(item.score, { minimumFractionDigits: 3, maximumFractionDigits: 3 }) })}
          </div>
          {item.section === 'serendipity' && onSerendipityFeedback && (
            item.serendipity_feedback ? (
              <p className="text-xs text-muted-foreground" role="status">
                {t('workspace_ui.digest.feedback', { choice: t(`workspace_ui.digest.feedback_${item.serendipity_feedback}`) })}
              </p>
            ) : (
              <div className="flex flex-wrap gap-2" aria-label={t('workspace_ui.digest.feedback_group', { title: item.title })}>
                <button className="rounded border px-2 py-1 text-xs hover:bg-accent" type="button" onClick={() => void onSerendipityFeedback(item.id, 'interesting')}>{t('workspace_ui.digest.feedback_interesting')}</button>
                <button className="rounded border px-2 py-1 text-xs hover:bg-accent" type="button" onClick={() => void onSerendipityFeedback(item.id, 'neutral')}>{t('workspace_ui.digest.feedback_neutral')}</button>
                <button className="rounded border px-2 py-1 text-xs text-destructive hover:bg-destructive/10" type="button" onClick={() => void onSerendipityFeedback(item.id, 'never')}>{t('workspace_ui.digest.feedback_never')}</button>
              </div>
            )
          )}
          {!project && onFileToProject && projects.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 border-t pt-2">
              <select
                className="h-8 rounded border bg-background px-2 text-xs"
                aria-label={t('workspace_ui.digest.project_for', { title: item.title })}
                value={projectByItem[item.id] ?? ''}
                onChange={event => setProjectByItem(current => ({ ...current, [item.id]: event.target.value }))}
              >
                <option value="">{t('workspace_ui.digest.file_into_project')}</option>
                {projects.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
              </select>
              <button
                className="rounded border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
                type="button"
                disabled={!projectByItem[item.id]}
                onClick={() => void onFileToProject(item.id, item.source_item_id, projectByItem[item.id]!)}
              >
                {t('workspace_ui.digest.add_to_corpus')}
              </button>
            </div>
          )}
        </Card>
      ))
  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold">{t('workspace_ui.digest.interests_title')}</h3>
          <p className="text-xs text-muted-foreground">{t('workspace_ui.digest.interests_hint')}</p>
        </div>
        {renderItems(interest)}
      </section>
      {serendipity.length > 0 && (
        <section className="space-y-3 border-t pt-5">
          <div>
            <h3 className="text-sm font-semibold">{t('workspace_ui.digest.serendipity_title')}</h3>
            <p className="text-xs text-muted-foreground">{t('workspace_ui.digest.serendipity_hint')}</p>
          </div>
          {renderItems(serendipity)}
        </section>
      )}
    </div>
  )
}
