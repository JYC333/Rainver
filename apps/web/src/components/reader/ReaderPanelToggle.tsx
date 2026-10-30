import { PanelRight } from 'lucide-react'
import { Button } from '../ui/button'
import { useAppTranslation } from '../../i18n'

/** Inspector toggle for Reader wrappers; marks unsent comments kept for this document. */
export function ReaderPanelToggle({ panelOpen, togglePanel, unsentComments }: { panelOpen: boolean; togglePanel: () => void; unsentComments: number }) {
  const { t } = useAppTranslation()
  const label = panelOpen ? t('reading.hideInspector') : unsentComments > 0 ? t('reading.showInspectorWithDrafts', { count: unsentComments }) : t('reading.showInspector')
  return <Button variant="ghost" size="icon-sm" className="relative" onClick={togglePanel} aria-label={label} title={label}>
    <PanelRight className="size-4"/>
    {!panelOpen && unsentComments > 0 && <span aria-hidden className="absolute right-0.5 top-0.5 size-2 rounded-full bg-primary"/>}
  </Button>
}
