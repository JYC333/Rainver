import { useEffect, useState } from 'react'
import { Loader2, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { roomsApi } from '../../api/client'
import { useAppTranslation } from '../../i18n'
import { formatDate, formatDateTime } from '../../i18n/format'
import { errMsg } from '../../lib/utils'
import type { RoomConversation as RoomConversationRecord } from '../../types/api'
import { Button } from '../../components/ui/button'
import { Card } from '../../components/ui/card'
import { loadAllPages } from './loadAllPages'

/**
 * A Room's recycle bin: conversations deleted within the last 30 days, each
 * restorable to the list it was deleted from. The page shows this only to
 * someone who can delete here; the server enforces the same rule.
 */
export function RoomConversationTrash({ roomId, onRestored }: {
  roomId: string
  onRestored: () => Promise<void> | void
}) {
  const { t } = useAppTranslation()
  const [items, setItems] = useState<RoomConversationRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [restoring, setRestoring] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setItems([])
    setError(null)
    setLoading(true)
    void loadAllPages((limit, offset) => roomsApi.conversations(roomId, { limit, offset, status: 'deleted' }))
      .then(next => { if (!cancelled) setItems(next) })
      .catch(failure => { if (!cancelled) setError(errMsg(failure)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [roomId])

  async function restore(conversation: RoomConversationRecord) {
    setRestoring(conversation.id)
    try {
      await roomsApi.restoreDeletedConversation(conversation.room_id, conversation.id, { spaceId: conversation.space_id })
      setItems(current => current.filter(item => item.id !== conversation.id))
      await onRestored()
    } catch (failure) {
      toast.error(errMsg(failure))
    } finally {
      setRestoring(null)
    }
  }

  if (loading) {
    return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t('collab_ui.common.loading')}</div>
  }
  if (error) return <p role="alert" className="text-sm text-destructive">{error}</p>
  const visible = items.filter(item => item.room_id === roomId)
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">{t('collab_ui.room.trash_hint')}</p>
      {visible.length === 0
        ? <p className="text-sm text-muted-foreground">{t('collab_ui.room.no_deleted_conversations')}</p>
        : (
          <ul className="space-y-1.5">
            {visible.map(conversation => (
              <li key={conversation.id}>
                <Card className="mb-0 flex items-center justify-between gap-2 px-3 py-1.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm">{conversation.title || t('collab_ui.room.untitled')}</p>
                    {conversation.deleted_at && conversation.purge_after && (
                      <p className="text-xs text-muted-foreground">
                        {t('collab_ui.room.deleted_conversation_meta', {
                          when: formatDateTime(conversation.deleted_at),
                          until: formatDate(conversation.purge_after),
                        })}
                      </p>
                    )}
                  </div>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="shrink-0"
                    aria-label={t('collab_ui.room.restore_deleted_conversation')}
                    title={t('collab_ui.room.restore_deleted_conversation')}
                    disabled={restoring !== null}
                    onClick={() => void restore(conversation)}
                  >
                    <RotateCcw className="size-4" />
                  </Button>
                </Card>
              </li>
            ))}
          </ul>
        )}
    </div>
  )
}
