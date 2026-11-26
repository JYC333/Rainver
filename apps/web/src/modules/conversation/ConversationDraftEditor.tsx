import { useState } from 'react'
import { FileText, X } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogTitle, DialogTrigger } from '../../components/ui/dialog'
import { Textarea } from '../../components/ui/textarea'
import { useAppTranslation } from '../../i18n'
import { MessageResponse } from '../../components/ai-elements/message'

export function isLongPaste(text: string): boolean {
  const content = text.trim()
  return content.length >= 1_200 || content.split(/\r\n|\r|\n/, 16).length >= 16
}

export function withPastedText(text: string, paste: string): string {
  return [text.trim(), paste.trim()].filter(Boolean).join('\n\n')
}

export function ConversationUserText({ text }: { text: string }) {
  const { t } = useAppTranslation()
  if (!text) return null
  if (!isLongPaste(text)) return <MessageResponse>{text}</MessageResponse>

  const label = t('conversation_ui.composer.view_long_text')
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" className="max-w-full justify-start gap-2 bg-background text-foreground hover:bg-accent" aria-label={label}>
          <FileText className="size-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 truncate">{text.trim().slice(0, 120)}</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="w-[calc(100%-2rem)] max-w-3xl p-4 sm:p-6" aria-describedby={undefined}>
        <DialogTitle>{label}</DialogTitle>
        <Textarea aria-label={label} value={text} readOnly className="h-[min(52dvh,28rem)] resize-none" />
      </DialogContent>
    </Dialog>
  )
}

export function ConversationDraftEditor({ text, onChange, disabled }: {
  text: string; onChange: (value: string) => void; disabled: boolean
}) {
  const { t } = useAppTranslation()
  const [open, setOpen] = useState(false)
  const [edit, setEdit] = useState('')
  const label = t('conversation_ui.composer.edit_draft')
  return <div className="flex min-w-0 max-w-44 items-start gap-1 rounded-md border border-border bg-background p-1">
    <Dialog open={open} onOpenChange={next => {
      if (next) setEdit(text)
      setOpen(next)
    }}>
      <DialogTrigger asChild>
        <Button type="button" variant="ghost" disabled={disabled} aria-label={label}
          className="min-w-0 max-w-48 justify-start gap-2 px-2 text-left">
          <FileText className="size-4 shrink-0" aria-hidden="true" />
          <span className="truncate">{text.trim().slice(0, 120)}</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="w-[calc(100%-2rem)] max-w-3xl p-4 sm:p-6" aria-describedby={undefined}>
        <DialogTitle className="mb-3 pr-6">{label}</DialogTitle>
        <Textarea aria-label={label} value={edit} onChange={event => setEdit(event.target.value)}
          className="h-[min(52dvh,28rem)] resize-none" />
        <DialogFooter className="mt-3 border-0 pt-0">
          <Button type="button" disabled={disabled} onClick={() => { onChange(edit.trim()); setOpen(false) }}>
            {t('conversation_ui.composer.done_editing')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <Button type="button" size="icon-sm" variant="ghost" disabled={disabled}
      aria-label={t('conversation_ui.composer.remove_pasted_text')} onClick={() => onChange('')}>
      <X className="size-3.5" />
    </Button>
  </div>
}
