import { useState } from 'react'
import { History } from 'lucide-react'
import { toast } from 'sonner'
import { ambientSessionsApi } from '../../api/client'
import { errMsg } from '../../lib/utils'
import { SpaceLink as Link } from '../../core/spaceNav'
import { useAppTranslation } from '../../i18n'
import { Card } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../../components/ui/dialog'
import { useAmbientImportOffers } from './useAmbientImportOffers'

/** Reminder preferences and import completion are independent. The manual entry always remains. */
export function ProjectHistoryImport({ projectId, showReminder = true }: { projectId: string; showReminder?: boolean }) {
  const { t } = useAppTranslation()
  const { offers, reload } = useAmbientImportOffers(projectId)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const offer = offers.find(item => {
    const reminder = item.policy.reminder
    const pending = item.attention && item.attention.new_sessions + item.attention.updated_sessions + item.attention.incomplete_sessions > 0
    return pending && reminder?.enabled !== false && (!reminder?.snoozed_until || Date.parse(reminder.snoozed_until) <= Date.now())
  })
  async function remind(mode: 'later' | 'never') {
    if (!offer) return
    setBusy(true)
    try { await ambientSessionsApi.setReminder(offer.location.id, mode); await reload() }
    catch (error) { toast.error(errMsg(error)) }
    finally { setBusy(false) }
  }
  const folderLink = (id: string) => `/projects/${projectId}/folders/${id}`
  if (offers.length === 0) return null
  return (
    <div className="space-y-3" data-testid="ambient-import-entry">
      <div className="flex justify-end">
        <Button size="sm" variant="ghost" onClick={() => setOpen(true)}><History className="size-4" />{t('conversation_ui.imported.import_history')}</Button>
      </div>
      {showReminder && offer && <Card className="flex flex-wrap items-start gap-3 border-dashed p-4" data-testid="ambient-import-banner">
        <History className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="break-words text-sm font-medium">{t('conversation_ui.imported.history_pending', { folder: offer.folderName })}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t('conversation_ui.imported.history_counts', { new: offer.attention.new_sessions, updated: offer.attention.updated_sessions, incomplete: offer.attention.incomplete_sessions })}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t('conversation_ui.imported.history_scope')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" asChild><Link to={folderLink(offer.location.project_folder_id)}>{t('conversation_ui.imported.review_import')}</Link></Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void remind('later')}>{t('conversation_ui.imported.remind_later')}</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void remind('never')}>{t('conversation_ui.imported.remind_never')}</Button>
        </div>
      </Card>}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('conversation_ui.imported.import_history')}</DialogTitle><DialogDescription>{t('conversation_ui.imported.history_scope')}</DialogDescription></DialogHeader>
          <div className="max-h-[60dvh] space-y-3 overflow-y-auto">
            {offers.map(item => <div key={item.location.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3">
              <div className="min-w-0 flex-1"><p className="break-words text-sm font-medium">{item.folderName}</p><p className="text-xs text-muted-foreground">{item.attention.uncertain ? t('conversation_ui.imported.history_unknown') : t('conversation_ui.imported.history_counts', { new: item.attention.new_sessions, updated: item.attention.updated_sessions, incomplete: item.attention.incomplete_sessions })}</p></div>
              <Button size="sm" variant="outline" asChild><Link to={folderLink(item.location.project_folder_id)} onClick={() => setOpen(false)}>{t('conversation_ui.imported.review_import')}</Link></Button>
            </div>)}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
