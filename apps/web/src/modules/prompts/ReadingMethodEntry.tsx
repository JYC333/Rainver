import { Button } from '../../components/ui/button';
import { readingMethodReturn } from './readingMethodLinks';
import { useEffect, useState } from 'react';
import { useSpace } from '../../contexts/SpaceContext';
import { SpaceLink } from '../../core/spaceNav';
import { useAppTranslation } from '../../i18n';
import { sessionEpoch } from '../../lib/sessionResidue';
import { observeReadingMethodScope } from './readingMethodEntryScope';
/** This context link grants nothing; the server checks actual material and maintenance rights. */
export function ReadingMethodEntry({
  itemId,
  projectId,
  artifactId,
  readerHref,
  onNavigate
}: {
  itemId: string;
  projectId?: string | null;
  artifactId?: string | null;
  readerHref?: string;
  onNavigate?: () => void;
}) {
  const {
    activeSpaceId,
    userId
  } = useSpace();
  const {
    t
  } = useAppTranslation();
  const [allowed, setAllowed] = useState<{
    projectId: string | null;
    scope: string;
    epoch: number;
  } | null>(null);
  const scope = `${activeSpaceId}:${userId}:${projectId}`;
  useEffect(() => {
    const epoch = sessionEpoch();
    setAllowed(null);
    if (!activeSpaceId || !userId) return;
    return observeReadingMethodScope(activeSpaceId ?? '', userId ?? '', projectId ?? null, r => setAllowed(r?.can_manage ? {
      projectId: projectId ?? null,
      scope,
      epoch
    } : null));
  }, [activeSpaceId, userId, projectId, scope]);
  return allowed && allowed.scope === scope && allowed.epoch === sessionEpoch() ? <Button size="sm" variant="ghost" asChild><SpaceLink aria-label={t('readingMethod.improve_the_reading_method_for_this_result')} onClick={onNavigate} to={`/prompts?${new URLSearchParams({
      reading_method: '1',
      item_id: itemId,
      reader: readingMethodReturn(itemId, readerHref ?? null, allowed.projectId),
      ...(artifactId ? {
        artifact_id: artifactId
      } : {}),
      ...(allowed.projectId ? {
        project_id: allowed.projectId
      } : {})
    })}`}>{t('readingMethod.improve_result')}</SpaceLink></Button> : null;
}
