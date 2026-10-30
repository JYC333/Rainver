import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { useAppTranslation } from '../../i18n'
import { useState } from 'react'
import { Button } from '../ui/button'
import { READER_SHORTCUTS, useReaderShortcuts } from './readerShortcuts'

interface ReaderShortcutsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ReaderShortcutsDialog({ open, onOpenChange }: ReaderShortcutsDialogProps) {
  const { t } = useAppTranslation()
  const { keys, save } = useReaderShortcuts()
  const [error, setError] = useState(false)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-32px)] max-w-sm overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('reading.shortcutsTitle')}</DialogTitle>
          <DialogDescription>{t('reading.shortcutsDescription')}</DialogDescription>
        </DialogHeader>
        <dl className="space-y-2 text-sm">
          {READER_SHORTCUTS.map(({ id, action, configurable }) => (
            <div key={id} className="flex items-center justify-between gap-4">
              <dt>
                {configurable ? <input aria-label={t(action)} value={keys[id]} maxLength={1} className="min-h-[44px] min-w-[44px] w-12 rounded border bg-muted px-1.5 py-1 text-center font-mono text-[16px]"
                  onChange={event => setError(!save({ ...keys, [id]: event.target.value.toLowerCase() }))}
                  onFocus={() => setError(false)} onClick={event => event.currentTarget.select()} />
                  : <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs">{keys[id]}</kbd>}
              </dt>
              <dd className="text-muted-foreground text-right">{t(action)}</dd>
            </div>
          ))}
        </dl>
        <p className="text-xs text-muted-foreground">{t('reading.shortcutKeyHint')}</p>
        {error && <p role="alert" className="text-sm text-destructive">{t('reading.shortcutKeyConflict')}</p>}
        <Button variant="outline" className="min-h-[44px]" onClick={() => setError(!save(null))}>{t('reading.shortcutKeyReset')}</Button>
      </DialogContent>
    </Dialog>
  )
}
