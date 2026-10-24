import { useState } from 'react'
import { Card, CardTitle } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { useAppTranslation } from '../../i18n'
import { currentBuild, fetchLatestBuild, readLayoutDiagnostics, reloadLatestBuild, type AppBuild } from './appVersion'

export function AppVersionPanel() {
  const { t } = useAppTranslation()
  const [latest, setLatest] = useState<AppBuild | null>(null)
  const [status, setStatus] = useState<'idle' | 'checking' | 'current' | 'available' | 'updating' | 'error'>('idle')
  const [diagnostics, setDiagnostics] = useState('')
  async function check() {
    setStatus('checking'); setLatest(null)
    try { const build = await fetchLatestBuild(); setLatest(build); setStatus(build.id === currentBuild.id ? 'current' : 'available') }
    catch { setStatus('error') }
  }
  async function update() {
    setStatus('updating')
    try { await reloadLatestBuild() } catch { setStatus('error') }
  }
  return <Card className="space-y-3 p-5">
    <CardTitle>{t('app_version.title')}</CardTitle>
    <p className="text-sm">{t('app_version.running')} <code className="break-all text-xs select-all">{currentBuild.id}</code></p>
    <p className="text-xs text-muted-foreground">{t('app_version.description')}</p>
    {status === 'available' && latest && <p className="break-all text-xs">{t('app_version.available')}: {latest.id}</p>}
    <p role="status" className="text-xs">{status !== 'idle' && t(`app_version.${status}`)}</p>
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" onClick={() => void check()} disabled={status === 'checking' || status === 'updating'}>{t('app_version.check')}</Button>
      {status === 'available' && <Button size="sm" onClick={() => void update()}>{t('app_version.reload')}</Button>}
    </div>
    {status === 'available' && <p className="text-xs text-muted-foreground">{t('app_version.reload_hint')}</p>}
    <details className="text-xs">
      <summary className="cursor-pointer text-muted-foreground">{t('app_version.diagnostics')}</summary>
      <Button size="sm" variant="ghost" className="my-2" onClick={() => setDiagnostics(JSON.stringify(readLayoutDiagnostics(), null, 2))}>{t('app_version.collect')}</Button>
      {diagnostics && <textarea readOnly aria-label={t('app_version.diagnostics')} value={diagnostics} className="h-56 w-full rounded border bg-background p-2 font-mono text-xs" onFocus={event => event.target.select()} />}
    </details>
  </Card>
}
