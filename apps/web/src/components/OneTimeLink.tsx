import { useState } from 'react'
import { Check, Copy, X } from 'lucide-react'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { useAppTranslation } from '../i18n'

/**
 * A one-time link shown where it was generated, so it is never lost to a
 * clipboard that refuses the write. "Copied" appears only after a write that
 * succeeded; otherwise the person selects and copies it by hand. Dismissing
 * it removes it from the page: it is not kept, logged or shared anywhere.
 */
export function OneTimeLink({
  link,
  label,
  secret = false,
  onDismiss,
}: {
  link: string
  label: string
  /** A credential (a password reset link): said so, and never left on screen. */
  secret?: boolean
  onDismiss: () => void
}) {
  const { t } = useAppTranslation()
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle')

  async function copyLink() {
    try {
      if (!navigator.clipboard) throw new Error('clipboard unavailable')
      await navigator.clipboard.writeText(link)
      setCopy('copied')
    } catch {
      setCopy('failed')
    }
  }

  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3" role="region" aria-label={label}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">{label}</p>
        <Button type="button" size="icon" variant="ghost" className="size-7" aria-label={t('core_ui.one_time_link.dismiss')} onClick={onDismiss}>
          <X className="size-3.5" />
        </Button>
      </div>
      <div className="flex gap-2">
        <Input readOnly value={link} className="font-mono text-xs" onFocus={event => event.currentTarget.select()} aria-label={label} />
        <Button type="button" size="sm" variant="outline" onClick={() => void copyLink()}>
          {copy === 'copied' ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copy === 'copied' ? t('core_ui.one_time_link.copied') : t('core_ui.one_time_link.copy')}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground" role="status">
        {copy === 'failed'
          ? t('core_ui.one_time_link.copy_failed')
          : secret
            ? t('core_ui.one_time_link.secret_hint')
            : t('core_ui.one_time_link.plain_hint')}
      </p>
    </div>
  )
}
