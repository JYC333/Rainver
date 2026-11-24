import { useEffect, useState } from 'react'
import { Button } from '../../../components/ui/button'
import { useAppTranslation } from '../../../i18n'
import { currentBuild, fetchLatestBuild, reloadLatestBuild, type AppBuild } from '../appVersion'

import { probeRevision } from './topComparison'

export function ProbeVersion() {
  const { t } = useAppTranslation()
  const [latest, setLatest] = useState<AppBuild | null>(null)
  const [status, setStatus] = useState<'checking' | 'current' | 'available' | 'updating' | 'kept' | 'error'>('checking')
  async function check() {
    setStatus('checking'); setLatest(null)
    try {
      const build = await fetchLatestBuild()
      setLatest(build)
      setStatus(build.id === currentBuild.id && (!build.inputsHash || !currentBuild.inputsHash || build.inputsHash === currentBuild.inputsHash) ? 'current' : 'available')
    } catch { setStatus('error') }
  }
  useEffect(() => { void check() }, [])
  async function reload() {
    setStatus('updating')
    try { await reloadLatestBuild(); setStatus('kept') } catch { setStatus('error') }
  }
  return <section className="space-y-2 rounded border border-border bg-card p-3" aria-label={t('viewport_test.version')}>
    <p className="font-semibold">{t('viewport_test.version')} · {probeRevision}</p>
    <details className="text-xs">
      <summary className="cursor-pointer">{t('viewport_test.build_details')}</summary>
    <p className="break-all text-xs">{t('app_version.running')} {currentBuild.id}</p>
    {latest && <p className="break-all text-xs">{t('viewport_test.server_build')} {latest.id}</p>}
    {currentBuild.inputsHash && <p className="break-all text-xs">{t('viewport_test.fingerprint')} {currentBuild.inputsHash}</p>}
    </details>
    <p role="status" data-probe-version-status={status} className="text-sm font-medium">{t(`app_version.${status}`)}</p>
    <p className="text-xs text-muted-foreground">{t('viewport_test.version_hint')}</p>
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" onClick={() => void check()} disabled={status === 'checking' || status === 'updating'}>{t('app_version.check')}</Button>
      <Button onClick={() => void reload()} disabled={status === 'checking' || status === 'updating'}>{t('viewport_test.reload_scheme')}</Button>
    </div>
    <p className="text-xs text-muted-foreground">{t('viewport_test.reload_hint')}</p>
  </section>
}
