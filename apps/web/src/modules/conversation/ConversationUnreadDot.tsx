import { useAppTranslation } from '../../i18n'
import { Loader2 } from 'lucide-react'

function ConversationUnreadDot() {
  const { t } = useAppTranslation()
  return <span role="status" aria-label={t('collab_ui.room.unread')} title={t('collab_ui.room.unread')}
    className="size-2 shrink-0 rounded-full bg-primary" />
}

/** Execution wins: unread is presented only once every Agent has ended. */
export function ConversationStatusIndicator({ running, unread }: { running?: boolean; unread: boolean }) {
  const { t } = useAppTranslation()
  if (running) return <Loader2 role="status" aria-label={t('collab_ui.room.running')} className="size-3.5 shrink-0 animate-spin" />
  return unread ? <ConversationUnreadDot /> : null
}
