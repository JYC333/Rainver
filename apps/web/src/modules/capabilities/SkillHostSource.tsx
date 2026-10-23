import { useEffect, useState } from 'react'
import { Loader2, RefreshCw, Monitor } from 'lucide-react'
import type { HostSkillScan, SkillImportPreviewRequest } from '@rainver/protocol'
import { capabilitiesFrameworkApi, hostsApi } from '../../api/client'
import type { Host } from '../../types/api'
import { useAuth } from '../../contexts/AuthContext'
import { SpaceLink } from '../../core/spaceNav'
import { useAppTranslation } from '../../i18n'
import { errMsg } from '../../lib/utils'
import { Button } from '../../components/ui/button'
import { Select } from '../../components/ui/select'

export function SkillHostSource({ spaceId, disabled, onSelect }: {
  spaceId: string; disabled: boolean; onSelect: (source: SkillImportPreviewRequest | null) => void
}) {
  const { t } = useAppTranslation()
  const { currentUser } = useAuth()
  const [hosts, setHosts] = useState<Host[]>([])
  const [hostId, setHostId] = useState('')
  const [result, setResult] = useState<HostSkillScan | null>(null)
  const [selected, setSelected] = useState('')
  const [loadingHosts, setLoadingHosts] = useState(true)
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    hostsApi.list({ spaceId, signal: controller.signal }).then(page => {
      if (controller.signal.aborted) return
      const owned = page.items.filter(host => (host.kind === 'remote' && host.owner_user_id === currentUser?.id) || (host.kind === 'server' && currentUser?.is_instance_admin))
      setHosts(owned)
      setHostId(owned.find(host => host.kind === 'remote' && host.status === 'online')?.id
        ?? owned.find(host => host.status === 'online')?.id ?? '')
    }).catch(error => { if (!controller.signal.aborted) setError(errMsg(error)) })
      .finally(() => { if (!controller.signal.aborted) setLoadingHosts(false) })
    return () => controller.abort()
  }, [spaceId, currentUser?.is_instance_admin])
  useEffect(() => {
    setResult(null); setSelected(''); setError('')
    if (!hostId) return
    const controller = new AbortController()
    setScanning(true)
    capabilitiesFrameworkApi.scanHostSkills(hostId, { spaceId, signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setResult(result)
    }).catch(error => { if (!controller.signal.aborted) setError(errMsg(error)) })
      .finally(() => { if (!controller.signal.aborted) setScanning(false) })
    return () => controller.abort()
  }, [hostId, spaceId, revision])
  return <div className="space-y-4">
    <p className="text-sm text-muted-foreground">{t('skill_packages.scan_hint')}</p>
    {loadingHosts ? <p role="status" className="flex items-center gap-2 text-sm"><Loader2 className="size-4 animate-spin" />{t('skill_packages.loading_hosts')}</p>
      : hosts.length === 0 ? !error && <div className="rounded-lg border border-dashed border-border p-5 text-sm text-muted-foreground">
        <Monitor className="mb-2 size-5" /><p>{t('skill_packages.no_hosts')}</p>
        <SpaceLink className="mt-2 inline-block text-primary underline" to="/command-center">{t('skill_packages.manage_hosts')}</SpaceLink>
      </div> : <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1 space-y-1.5"><label className="text-sm font-medium">{t('skill_packages.scan_host')}</label>
          <Select ariaLabel={t('skill_packages.scan_host')} value={hostId} disabled={disabled}
            options={[{ value: '', label: t('skill_packages.choose_host'), disabled: true }, ...hosts.map(host => ({ value: host.id, label: `${host.name} · ${host.status === 'online' ? t('skill_packages.online') : t('skill_packages.offline')}`, disabled: host.status !== 'online' }))]}
            onChange={id => { onSelect(null); setHostId(id) }} />
        </div>
        <Button variant="outline" disabled={disabled || !hostId || scanning} onClick={() => { onSelect(null); setRevision(value => value + 1) }}>
          <RefreshCw className={`mr-2 size-4 ${scanning ? 'animate-spin' : ''}`} />{t('skill_packages.rescan')}
        </Button>
      </div>}
    {!loadingHosts && hosts.length > 0 && !hostId && <p className="text-sm text-muted-foreground">{t('skill_packages.offline_hint')}</p>}
    {scanning && <p role="status" className="flex items-center gap-2 py-5 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t('skill_packages.scanning')}</p>}
    {error && <p role="alert" className="rounded-lg bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}
    {result && <div className="space-y-2">
      <p className="text-xs text-muted-foreground">{t('skill_packages.discovered', { count: result.items.length })}</p>
      {result.items.length === 0 ? <p className="rounded-lg border border-dashed border-border p-5 text-sm text-muted-foreground">{t('skill_packages.scan_empty')}</p>
        : <div role="radiogroup" aria-label={t('skill_packages.discovered_skills')} className="max-h-64 space-y-2 overflow-y-auto pr-1">
          {result.items.map(skill => <label key={skill.id} className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${selected === skill.id ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/40'}`}>
            <input type="radio" className="mt-1 accent-primary" name="global-skill" checked={selected === skill.id} disabled={disabled} onChange={() => {
              setSelected(skill.id); onSelect({ source_type: 'local_workspace', host_id: hostId, skill_id: skill.id })
            }} />
            <span className="min-w-0 flex-1"><span className="block text-sm font-medium break-words">{skill.name}</span>
              <span className="block break-all text-xs text-muted-foreground">{skill.runtime_key === 'claude_code' ? 'Claude Code' : skill.runtime_key === 'codex_cli' ? 'Codex' : 'OpenCode'} · {skill.installation === 'own' ? t('skill_packages.own_cli') : t('skill_packages.managed_cli')}</span>
              <span className="block break-all font-mono text-xs text-muted-foreground">{skill.display_path}</span>
            </span>
          </label>)}
        </div>}
      {result.truncated && <p className="text-xs text-muted-foreground">{t('skill_packages.scan_truncated')}</p>}
      {result.warnings.map(warning => <p key={warning} className="text-xs text-muted-foreground">{warning}</p>)}
    </div>}
  </div>
}
