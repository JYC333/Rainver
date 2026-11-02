import { useMemo } from 'react'
import { personalBriefingsApi } from '../../../api/client'
import { useAppTranslation } from '../../../i18n'
import { readerHrefFor } from '../readingLinks'
import { BriefingPanel, type BriefingScopeApi } from './BriefingPanel'

/**
 * The reader's own briefing at the top of their Reading: a synthesis of
 * their Following, subscribed Sources and the Projects they opted into
 * Reading. Private to them; collapsed to its status and overview so the
 * reading list stays within reach. Mount it keyed by Space.
 */
export function PersonalBriefingPanel({ spaceId }: { spaceId: string }) {
  const { t } = useAppTranslation()
  const api = useMemo<BriefingScopeApi>(() => ({
    scope: { type: 'personal' },
    followUp: (briefingId, index) => personalBriefingsApi.followUp(spaceId, briefingId, index),
    previewAdoption: (briefingId, index) => personalBriefingsApi.previewAdoption(spaceId, briefingId, index),
    adopt: (briefingId, index, hash) => personalBriefingsApi.adopt(spaceId, briefingId, index, hash),
    overview: () => personalBriefingsApi.overview(spaceId),
    get: (briefingId) => personalBriefingsApi.get(spaceId, briefingId),
    generate: () => personalBriefingsApi.generate(spaceId),
    cancel: (briefingId) => personalBriefingsApi.cancel(spaceId, briefingId),
    setDaily: (enabled) => personalBriefingsApi.setDaily(spaceId, enabled),
  }), [spaceId])
  return (
    <BriefingPanel
      api={api}
      testId="personal-briefing"
      collapsible
      title={t('briefing.personal_title')}
      hint={t('briefing.personal_hint')}
      readOnlyNote=""
      evidenceHref={evidence => readerHrefFor(evidence.source_item_id, 'library', '/library/reading')}
    />
  )
}
