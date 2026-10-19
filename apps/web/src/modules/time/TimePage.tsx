import { Clock } from 'lucide-react'
import { Badge } from '../../components/ui/badge'
import { useAppTranslation } from '../../i18n'

export default function TimePage() {
  const { t } = useAppTranslation()
  return (
    <div className="p-6 space-y-6 max-w-3xl">
      <div className="flex items-center gap-4 pb-4 border-b border-border">
        <div
          className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
          style={{
            background: 'color-mix(in oklch, var(--primary) 12%, transparent)',
            border: '1px solid color-mix(in oklch, var(--primary) 35%, transparent)',
          }}
        >
          <Clock className="size-5 text-accent-foreground" />
        </div>
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">{t('management_ui.time.title')} <Badge variant="muted">{t('management_ui.time.planned')}</Badge></h1>
          <p className="text-sm text-muted-foreground">{t('management_ui.time.subtitle')}</p>
        </div>
      </div>
      <div className="border border-dashed border-border rounded-lg p-12 text-center">
        <p className="text-sm text-muted-foreground">{t('management_ui.time.placeholder')}</p>
      </div>
    </div>
  )
}
