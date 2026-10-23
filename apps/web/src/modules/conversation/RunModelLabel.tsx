import type { RunModelSelection } from '@rainver/protocol'
import { useAppTranslation } from '../../i18n'

export function RunModelLabel({ model }: { model?: RunModelSelection }) {
  const { t } = useAppTranslation()
  if (!model) return null
  return <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
    <span>{t('conversation_ui.model.requested')}: {model.requested ?? t('conversation_ui.model.runtime_default')}</span>
    <span>{t('conversation_ui.model.reported')}: {model.reported ?? t(`conversation_ui.model.${model.status === 'pending' ? 'pending' : 'unknown'}`)}</span>
    {/* A saved choice the runtime withdrew: the run went ahead on its default. */}
    {model.dropped?.map(selection => (
      <span key={selection.id} role="status" className="basis-full text-warning">
        {t('conversation_ui.model.dropped', { option: selection.category ?? selection.id, value: String(selection.value) })}
      </span>
    ))}
  </div>
}
