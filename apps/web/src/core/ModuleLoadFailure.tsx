import { useCallback, useEffect, useState } from 'react'
import { Button } from '../components/ui/button'
import { Card } from '../components/ui/card'
import { useAppTranslation } from '../i18n'
import { currentBuild, fetchLatestBuild, reloadLatestBuild } from '../modules/settings/appVersion'

// Chromium, WebKit and Firefox wording for a dynamic import whose script could
// not be fetched, plus Vite's own preload failure.
const MODULE_LOAD_FAILURE = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/i

export function isModuleLoadFailure(error: unknown): boolean {
  return error instanceof Error && MODULE_LOAD_FAILURE.test(error.message)
}

type Status = 'checking' | 'offline' | 'available' | 'current' | 'updating' | 'kept' | 'error'

/**
 * A lazy feature of this tab's build could not be downloaded. The browser
 * keeps that failed import for the life of the document, so only a reload
 * recovers it. This panel never reloads by itself: it asks the same version
 * check as Settings which reload would help, and leaves the decision (and any
 * unsaved input, whose own beforeunload guards still apply) to the person.
 * Staying at that prompt applies nothing and keeps the update offered.
 */
export function ModuleLoadFailurePanel() {
  const { t } = useAppTranslation()
  const [status, setStatus] = useState<Status>('checking')
  const check = useCallback(async () => {
    setStatus('checking')
    if (!navigator.onLine) { setStatus('offline'); return }
    try {
      const latest = await fetchLatestBuild()
      setStatus(latest.id === currentBuild.id ? 'current' : 'available')
    } catch { setStatus('offline') }
  }, [])
  useEffect(() => { void check() }, [check])
  async function update() {
    setStatus('updating')
    // Staying at the unsaved-input prompt keeps this panel and its update.
    try { await reloadLatestBuild(); setStatus('kept') } catch { setStatus('error') }
  }
  const message = status === 'checking' ? t('app_version.checking')
    : status === 'updating' ? t('app_version.updating')
    : status === 'error' || status === 'kept' ? t(`app_version.${status}`)
    : t(`core_ui.module_load.${status}`)
  return (
    <Card className="mb-0 text-center">
      <p className="mb-1 text-sm font-medium">{t('core_ui.module_load.title')}</p>
      <p role="status" className="mb-4 text-xs text-muted-foreground">{message}</p>
      <div className="flex flex-wrap justify-center gap-2">
        {(status === 'offline' || status === 'error') && <Button variant="outline" size="sm" onClick={() => void check()}>{t('core_ui.module_load.check_again')}</Button>}
        {(status === 'available' || status === 'kept') && <Button size="sm" onClick={() => void update()}>{t('app_version.reload')}</Button>}
        {status === 'current' && <Button size="sm" onClick={() => window.location.reload()}>{t('core_ui.module_load.reload_tab')}</Button>}
      </div>
      {(status === 'available' || status === 'current') && <p className="mt-3 text-xs text-muted-foreground">{t('app_version.reload_hint')}</p>}
    </Card>
  )
}
