import { useMemo } from 'react'
import { informationBriefingsApi } from '../../api/client'
import { useAppTranslation } from '../../i18n'
import { readerHrefFor } from '../library/readingLinks'
import { BriefingPanel, type BriefingScopeApi } from '../library/briefing/BriefingPanel'

/**
 * The Project's briefing inside its Sources digest area. Readers read what
 * the server re-authorized for the whole Project; writers may also generate,
 * cancel and switch the daily briefing. Mount it keyed by Space and Project.
 */
export function ProjectBriefingPanel({ spaceId, projectId }: { spaceId: string; projectId: string }) {
  const { t } = useAppTranslation()
  const api = useMemo<BriefingScopeApi>(() => ({
    scope: { type: 'project', projectId },
    followUp: (briefingId, index) => informationBriefingsApi.followUp(spaceId, projectId, briefingId, index),
    previewAdoption: (briefingId, index) => informationBriefingsApi.previewAdoption(spaceId, projectId, briefingId, index),
    adopt: (briefingId, index, hash) => informationBriefingsApi.adopt(spaceId, projectId, briefingId, index, hash),
    overview: () => informationBriefingsApi.project(spaceId, projectId),
    get: (briefingId) => informationBriefingsApi.get(spaceId, projectId, briefingId),
    generate: () => informationBriefingsApi.generate(spaceId, projectId),
    cancel: (briefingId) => informationBriefingsApi.cancel(spaceId, projectId, briefingId),
    setDaily: (enabled) => informationBriefingsApi.setDaily(spaceId, projectId, enabled),
  }), [spaceId, projectId])
  return (
    <BriefingPanel
      api={api}
      testId="project-briefing"
      title={t('briefing.title')}
      hint={t('briefing.hint')}
      readOnlyNote={t('briefing.readers_only')}
      evidenceHref={evidence => readerHrefFor(evidence.source_item_id, 'project', `/projects/${projectId}/sources?tab=digest`)}
    />
  )
}
