import { useEffect, useState } from 'react'
import { Globe2, Loader2, Plus, ShieldAlert, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { networkProfilesApi } from '../../api/client'
import type { NetworkProfileMode, NetworkProfileOut } from '../../types/api'
import { useSpace } from '../../contexts/SpaceContext'
import { Card, CardTitle } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Badge } from '../../components/ui/badge'
import { errMsg } from '../../lib/utils'
import { useAppTranslation } from '../../i18n'

function defaultNoProxy() {
  return 'localhost,127.0.0.1,::1'
}

function ProfileForm({
  initial,
  onCancel,
  onSaved,
}: {
  initial?: NetworkProfileOut
  onCancel: () => void
  onSaved: (profile: NetworkProfileOut) => void
}) {
  const { t } = useAppTranslation()
  const [name, setName] = useState(initial?.name ?? '')
  const [mode, setMode] = useState<NetworkProfileMode>(initial?.mode ?? 'http_proxy')
  const [proxyUrl, setProxyUrl] = useState(initial?.proxy_url ?? '')
  const [noProxy, setNoProxy] = useState(initial?.no_proxy ?? defaultNoProxy())
  const [enabled, setEnabled] = useState(initial?.enabled ?? true)
  const [saving, setSaving] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) {
      toast.error(t('management_ui.network_profiles.name_required'))
      return
    }
    if (mode === 'http_proxy' && !proxyUrl.trim()) {
      toast.error(t('management_ui.network_profiles.proxy_required'))
      return
    }
    setSaving(true)
    try {
      const body = {
        name: name.trim(),
        mode,
        proxy_url: mode === 'http_proxy' ? proxyUrl.trim() : null,
        no_proxy: noProxy.trim() || null,
        enabled,
      }
      const saved = initial
        ? await networkProfilesApi.patch(initial.id, body)
        : await networkProfilesApi.create(body)
      toast.success(initial ? t('management_ui.network_profiles.updated') : t('management_ui.network_profiles.added'))
      onSaved(saved)
    } catch (err) {
      toast.error(errMsg(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded-lg border border-border bg-accent/30 p-4">
      <div className="space-y-1.5">
        <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{t('management_ui.network_profiles.name')}</label>
        <Input value={name} onChange={e => setName(e.target.value)} placeholder={t('management_ui.network_profiles.name_placeholder')} />
      </div>
      <div className="space-y-1.5">
        <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{t('management_ui.network_profiles.mode')}</label>
        <select
          value={mode}
          onChange={e => setMode(e.target.value as NetworkProfileMode)}
          className="flex h-9 w-full rounded-md border border-border bg-input px-3 text-sm"
        >
          <option value="http_proxy">{t('management_ui.network_profiles.http_proxy')}</option>
          <option value="direct">{t('management_ui.network_profiles.direct')}</option>
        </select>
      </div>
      {mode === 'http_proxy' && (
        <div className="space-y-1.5">
          <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{t('management_ui.network_profiles.proxy_url')}</label>
          <Input value={proxyUrl} onChange={e => setProxyUrl(e.target.value)} placeholder="http://127.0.0.1:7890" className="font-mono text-sm" />
        </div>
      )}
      <div className="space-y-1.5">
        <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{t('management_ui.network_profiles.no_proxy')}</label>
        <Input value={noProxy} onChange={e => setNoProxy(e.target.value)} placeholder={defaultNoProxy()} className="font-mono text-sm" />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} className="accent-primary" />
        {t('management_ui.network_profiles.enabled')}
      </label>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={saving}>{saving ? <Loader2 className="size-3.5 animate-spin" /> : t('management_ui.network_profiles.save')}</Button>
        <Button type="button" size="sm" variant="outline" onClick={onCancel}>{t('management_ui.network_profiles.cancel')}</Button>
      </div>
    </form>
  )
}

function ProfileCard({
  profile,
  onUpdated,
  onDeleted,
}: {
  profile: NetworkProfileOut
  onUpdated: (profile: NetworkProfileOut) => void
  onDeleted: (id: string) => void
}) {
  const { t } = useAppTranslation()
  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState(false)

  if (editing) {
    return (
      <Card>
        <ProfileForm
          initial={profile}
          onCancel={() => setEditing(false)}
          onSaved={saved => {
            onUpdated(saved)
            setEditing(false)
          }}
        />
      </Card>
    )
  }

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <CardTitle>{profile.name}</CardTitle>
            <Badge variant="muted" className="text-[10px]">{profile.mode === 'direct' ? t('management_ui.network_profiles.direct') : t('management_ui.network_profiles.http_proxy')}</Badge>
            {!profile.enabled && <Badge variant="muted" className="text-[10px]">{t('management_ui.network_profiles.disabled')}</Badge>}
          </div>
          {profile.proxy_url && <p className="truncate font-mono text-xs text-muted-foreground">{profile.proxy_url}</p>}
          {profile.no_proxy && <p className="mt-1 truncate font-mono text-xs text-muted-foreground">NO_PROXY={profile.no_proxy}</p>}
        </div>
        <div className="flex shrink-0 gap-2">
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>{t('management_ui.network_profiles.edit')}</Button>
          <Button
            size="sm"
            variant="outline"
            className="text-red-500"
            disabled={deleting}
            onClick={async () => {
              setDeleting(true)
              try {
                await networkProfilesApi.delete(profile.id)
                onDeleted(profile.id)
                toast.success(t('management_ui.network_profiles.deleted'))
              } catch (err) {
                toast.error(errMsg(err))
              } finally {
                setDeleting(false)
              }
            }}
          >
            {deleting ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
          </Button>
        </div>
      </div>
    </Card>
  )
}

export default function NetworkProfilesPage() {
  const { t } = useAppTranslation()
  const { activeSpaceId, activeSpaceName, spaces } = useSpace()
  const activeSpace = spaces.find(s => s.id === activeSpaceId)
  const manageable = activeSpace?.role === 'owner' || activeSpace?.role === 'admin'
  const waitingForSpace = Boolean(activeSpaceId && !activeSpace && spaces.length === 0)
  const [profiles, setProfiles] = useState<NetworkProfileOut[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)

  async function load() {
    setLoading(true)
    try {
      setProfiles(activeSpaceId && manageable ? await networkProfilesApi.list() : [])
    } catch (err) {
      toast.error(errMsg(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [activeSpaceId, manageable])

  return (
    <div className="max-w-3xl space-y-6 p-6">
      <div className="flex items-center gap-4 border-b border-border pb-4">
        <div
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl"
          style={{
            background: 'color-mix(in oklch, var(--primary) 12%, transparent)',
            border: '1px solid color-mix(in oklch, var(--primary) 35%, transparent)',
          }}
        >
          <Globe2 className="size-5 text-accent-foreground" />
        </div>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t('management_ui.network_profiles.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('management_ui.network_profiles.subtitle')}</p>
          <p className="text-xs text-muted-foreground">{t('management_ui.network_profiles.viewing', { space: activeSpaceName ?? activeSpaceId ?? t('management_ui.network_profiles.no_space') })}</p>
        </div>
      </div>

      {waitingForSpace || loading ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <Loader2 className="mr-2 size-5 animate-spin" /> {t('management_ui.network_profiles.loading')}
        </div>
      ) : activeSpaceId && !manageable ? (
        <Card>
          <CardTitle className="flex items-center gap-2">
            <ShieldAlert className="size-3.5" /> {t('management_ui.network_profiles.admin_required')}
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {t('management_ui.network_profiles.admin_only')}
          </p>
        </Card>
      ) : (
        <div className="space-y-4">
          {adding ? (
            <ProfileForm
              onCancel={() => setAdding(false)}
              onSaved={profile => {
                setProfiles(prev => [profile, ...prev])
                setAdding(false)
              }}
            />
          ) : (
            <Button size="sm" variant="outline" onClick={() => setAdding(true)} disabled={!activeSpaceId}>
              <Plus className="mr-1.5 size-3.5" />
              {t('management_ui.network_profiles.add')}
            </Button>
          )}

          {!activeSpaceId ? (
            <Card><p className="p-4 text-sm text-muted-foreground">{t('management_ui.network_profiles.select_space')}</p></Card>
          ) : profiles.length === 0 && !adding ? (
            <Card><p className="p-4 text-sm text-muted-foreground">{t('management_ui.network_profiles.none')}</p></Card>
          ) : (
            profiles.map(profile => (
              <ProfileCard
                key={profile.id}
                profile={profile}
                onUpdated={updated => setProfiles(prev => prev.map(p => p.id === updated.id ? updated : p))}
                onDeleted={id => setProfiles(prev => prev.filter(p => p.id !== id))}
              />
            ))
          )}
        </div>
      )}
    </div>
  )
}
