import { Navigate, useSearchParams } from 'react-router-dom'
import { GmailOAuthCallbackResultSchema } from '@rainver/protocol'
import { useSpace } from '../../../contexts/SpaceContext'
import { spacePath } from '../../../core/navigation'
import { useAppTranslation } from '../../../i18n'

/**
 * The Gmail OAuth callback answers `/sources?gmail=<fixed code>` (no Space in
 * the URL). This forwards only a known result code to the person's preferred
 * Space's Access page; any other query is dropped.
 */
export default function GmailCallbackLanding() {
  const [params] = useSearchParams()
  const { preferredSpaceId } = useSpace()
  const { t } = useAppTranslation()
  if (!preferredSpaceId) return <p role="status" className="p-6 text-sm text-muted-foreground">{t('gmail_ui.landing')}</p>
  const result = GmailOAuthCallbackResultSchema.safeParse(params.get('gmail'))
  return <Navigate replace to={spacePath(preferredSpaceId, '/sources/access') + (result.success ? `?gmail=${result.data}` : '')} />
}
