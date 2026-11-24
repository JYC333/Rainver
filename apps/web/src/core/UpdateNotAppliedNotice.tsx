import { useState, useSyncExternalStore } from 'react'
import { Button } from '../components/ui/button'
import { Card } from '../components/ui/card'
import { useAppTranslation } from '../i18n'
import { dismissUpdateNotApplied, readUpdateNotApplied, reloadLatestBuild, subscribeUpdateNotApplied } from '../modules/settings/appVersion'

/**
 * The tab reloaded to apply an update past its unsaved-input prompt, but the
 * new worker then timed out or became redundant. Shown on every page, above
 * sign-in too; nothing retries by itself, and retrying is the same explicit
 * update action as Settings.
 */
export function UpdateNotAppliedNotice() {
  const { t } = useAppTranslation()
  const shown = useSyncExternalStore(subscribeUpdateNotApplied, readUpdateNotApplied, () => false)
  const [status, setStatus] = useState<'idle' | 'updating' | 'kept' | 'error'>('idle')
  if (!shown) return null
  async function retry() {
    setStatus('updating')
    try { await reloadLatestBuild(); setStatus('kept') } catch { setStatus('error') }
  }
  return (
    <div className="pointer-events-none fixed inset-x-0 z-50 flex justify-center px-3 top-[calc(0.75rem+var(--app-safe-top))]">
      <Card role="alert" className="pointer-events-auto w-full max-w-md space-y-3 p-4">
        <p className="text-sm">{t('app_version.not_applied')}</p>
        {status !== 'idle' && <p role="status" className="text-xs text-muted-foreground">{t(`app_version.${status}`)}</p>}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void retry()} disabled={status === 'updating'}>{t('app_version.reload')}</Button>
          <Button variant="ghost" size="sm" onClick={() => { setStatus('idle'); dismissUpdateNotApplied() }}>{t('app_version.dismiss')}</Button>
        </div>
      </Card>
    </div>
  )
}
