import { useState } from 'react'
import { Bell, X } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { useAppTranslation } from '../../i18n'
import type { RoomMessage } from '../../types/api'

export function isCollaborationReminder(message: RoomMessage) {
  return message.role === 'system'
    && message.metadata_json?.room_display === 'system_notice'
    && message.metadata_json.execution_event === 'collaboration_reminder'
}

export function ConversationCollaborationReminder({ message, dismissalKey }: {
  message: RoomMessage
  dismissalKey: string
}) {
  const { t } = useAppTranslation()
  const [dismissedId, setDismissedId] = useState(() => {
    try { return sessionStorage.getItem(dismissalKey) } catch { return null }
  })
  if (dismissedId === message.id) return null
  const metadata = message.metadata_json
  const count = metadata?.room_display === 'system_notice' ? metadata.execution_details?.delegations_used : undefined

  function dismiss() {
    setDismissedId(message.id)
    try { sessionStorage.setItem(dismissalKey, message.id) } catch { /* Still dismissed in this view. */ }
  }

  return (
    <div className="flex shrink-0 items-start gap-2 border-t border-border bg-card px-3 py-2 text-xs"
      data-testid="conversation-collaboration-reminder">
      <Bell aria-hidden="true" className="mt-1 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1 self-center">
        <p role="status">{typeof count === 'number'
          ? t('conversation_ui.collaboration.reminder_reached', { count })
          : t('conversation_ui.collaboration.reminder_title')}</p>
        <details key={message.id}>
          <summary className="cursor-pointer text-muted-foreground">{t('conversation_ui.collaboration.show_details')}</summary>
          <p className="max-h-24 overflow-y-auto whitespace-pre-line break-words">{message.content}</p>
        </details>
      </div>
      <span className="reading-touch">
        <Button type="button" size="icon" variant="ghost" onClick={dismiss}
          aria-label={t('conversation_ui.collaboration.dismiss_reminder')}>
          <X aria-hidden="true" className="size-4" />
        </Button>
      </span>
    </div>
  )
}
