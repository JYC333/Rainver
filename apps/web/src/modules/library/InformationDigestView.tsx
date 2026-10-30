import {ReadingMethodEntry} from '../prompts/ReadingMethodEntry'
import { readingHref } from './readingLinks'
import { useState } from 'react'
import { ExternalLink } from 'lucide-react'
import type { InformationDigest, Project } from '../../types/api'
import { Badge } from '../../components/ui/badge'
import { ReadingCard } from './ReadingCard'
import { EmptyState } from '../../components/ui/empty-state'
import { SpaceLink as Link } from '../../core/spaceNav'
import { SafeExternalLink } from '../../components/SafeExternalLink'
import { useAppTranslation } from '../../i18n'
import { Button } from '../../components/ui/button'
import { Select } from '../../components/ui/select'
import { formatDateTime, formatNumber } from '../../i18n/format'

type Feedback = 'interesting' | 'neutral' | 'never'

export function InformationDigestView({ digest, project = false, onSerendipityFeedback, projects = [], onFileToProject, reading = false }: {
  digest: InformationDigest
  project?: boolean
  reading?: boolean
  onSerendipityFeedback?: (itemId: string, feedback: Feedback) => Promise<void>
  projects?: Array<Pick<Project, 'id' | 'name'>>
  onFileToProject?: (itemId: string, sourceItemId: string, projectId: string) => Promise<void>
}) {
  const { t } = useAppTranslation()
  const [projectByItem, setProjectByItem] = useState<Record<string, string>>({})
  if (digest.items.length === 0) {
    return (
      <EmptyState
        title={digest.settings.ranking === 'project_monitoring' ? t(`monitoring.${String(digest.settings.coverage ?? 'not_run')}`) : t('workspace_ui.digest.empty_title')}
        description={digest.settings.ranking === 'project_monitoring' ? t(`monitoring.${String(digest.settings.coverage ?? 'not_run')}`) : project ? t('workspace_ui.digest.empty_project') : t('workspace_ui.digest.empty_personal')}
      />
    )
  }
  const projectId = digest.digest_type === 'project' ? digest.project_id ?? undefined : undefined
  const interest = digest.items.filter(item => item.section === 'interest')
  const serendipity = digest.items.filter(item => item.section === 'serendipity')
  const renderItems = (items: InformationDigest['items']) => items.map(item => (
        <ReadingCard key={item.id}
          title={<Link className="hover:underline" to={readingHref({ source_item_id: item.source_item_id, reader_origin: projectId ? 'project' : item.section === 'serendipity' ? 'serendipity' : 'library' }, projectId, 'digest', digest.digest_date)}>
                {item.title}
              </Link>}
          summary={item.summary ?? item.excerpt ?? null}
          metadata={<>{!reading && <>
                <Badge variant="outline">{item.domain_key}</Badge>
                <Badge variant="muted">{item.depth}</Badge>
                <Badge variant="muted">{item.genre}</Badge>
                {item.read_status !== 'unread' && <Badge variant="success">{item.read_status}</Badge>}
                </>}
                {reading && item.read_status !== 'unread' && <Badge variant="success">{t(`reading.status_${item.read_status}`)}</Badge>}
                {reading && item.occurred_at && <span className="text-xs text-muted-foreground">{formatDateTime(item.occurred_at)}</span>}
                {project && item.anonymous_read_count !== null && <Badge variant="outline">{t('workspace_ui.digest.people_read', { count: item.anonymous_read_count })}</Badge>}
              </>}
          details={<>{item.provenance_json?.version_id && <p className="text-xs text-muted-foreground">v{item.provenance_json.version} · {t(item.provenance_json.evidence_depth === 'title' ? 'monitoring.titleOnly' : 'monitoring.depth')} · {formatDateTime(item.occurred_at)} · {t('monitoring.date')}: {formatDateTime(item.provenance_json.ready_at as string | undefined)}</p>}
          {item.rationale && <p className="break-words text-sm text-muted-foreground border-l-2 border-border pl-3">{item.rationale}</p>}
          {!reading && <div className="text-[11px] text-muted-foreground">
            {t('workspace_ui.digest.slot_score', { slot: item.quota_slot, score: formatNumber(item.score, { minimumFractionDigits: 3, maximumFractionDigits: 3 }) })}
          </div>}
          </>}
          actions={<>
            <Button size="sm" variant="outline" asChild><Link to={readingHref({source_item_id:item.source_item_id,reader_origin:projectId?'project':item.section==='serendipity'?'serendipity':'library'},projectId,'digest',digest.digest_date)}>{t('reading.open')}</Link></Button><ReadingMethodEntry itemId={item.source_item_id} projectId={projectId} readerHref={readingHref({source_item_id:item.source_item_id,reader_origin:projectId?'project':item.section==='serendipity'?'serendipity':'library'},projectId,'digest',digest.digest_date)}/>
            {item.source_uri && (
              <SafeExternalLink className="text-muted-foreground hover:text-foreground" href={item.source_uri} aria-label={t('workspace_ui.digest.open_source', { title: item.title })}>
                <ExternalLink className="size-4" />
              </SafeExternalLink>
            )}{item.section === 'serendipity' && onSerendipityFeedback && (
            item.serendipity_feedback ? (
              <p className="text-xs text-muted-foreground" role="status">
                {t('workspace_ui.digest.feedback', { choice: t(`workspace_ui.digest.feedback_${item.serendipity_feedback}`) })}
              </p>
            ) : (
              <div className="flex flex-wrap gap-1" aria-label={t('workspace_ui.digest.feedback_group', { title: item.title })}>
                <Button size="sm" variant="outline" type="button" onClick={() => void onSerendipityFeedback(item.id, 'interesting')}>{t('workspace_ui.digest.feedback_interesting')}</Button>
                <Button size="sm" variant="outline" type="button" onClick={() => void onSerendipityFeedback(item.id, 'neutral')}>{t('workspace_ui.digest.feedback_neutral')}</Button>
                <Button size="sm" variant="destructive" type="button" onClick={() => void onSerendipityFeedback(item.id, 'never')}>{t('workspace_ui.digest.feedback_never')}</Button>
              </div>
            )
          )}
          {!project && onFileToProject && projects.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <Select
                size="sm"
                className="w-full"
                ariaLabel={t('workspace_ui.digest.project_for', { title: item.title })}
                value={projectByItem[item.id] ?? ''}
                onChange={value => setProjectByItem(current => ({ ...current, [item.id]: value }))}
                options={[{ value: '', label: t('workspace_ui.digest.file_into_project') }, ...projects.map(option => ({ value: option.id, label: option.name }))]}
              />
              <Button
                size="sm" variant="outline"
                type="button"
                disabled={!projectByItem[item.id]}
                onClick={() => void onFileToProject(item.id, item.source_item_id, projectByItem[item.id]!)}
              >
                {t('workspace_ui.digest.add_to_corpus')}
              </Button>
            </div>
          )}
        </>}
        />
      ))
  return (
    <div className="space-y-6">
      {digest.settings.coverage_scope === 'current_only' && <p className="text-sm">{t('monitoring.currentOnly')}</p>}
      {digest.settings.ranking === 'project_monitoring' && <p className="text-sm">{t(`monitoring.${String(digest.settings.coverage ?? 'not_run')}`)}</p>}
      <section className="grid gap-3">
        <div>
          <h3 className="text-sm font-semibold">{t('workspace_ui.digest.interests_title')}</h3>
          <p className="text-xs text-muted-foreground">{t('workspace_ui.digest.interests_hint')}</p>
        </div>
        {renderItems(interest)}
      </section>
      {serendipity.length > 0 && (
        <section className="grid gap-3 border-t border-border pt-5">
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
