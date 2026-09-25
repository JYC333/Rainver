import { useEffect, useState } from 'react'
import { DatabaseBackup, Loader2, RefreshCw, Save } from 'lucide-react'
import { toast } from 'sonner'
import { instanceOperationsApi } from '../../api/client'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Card, CardTitle } from '../../components/ui/card'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { errMsg } from '../../lib/utils'
import type { InstanceOperationsSettings, InstanceOperationsSettingsUpdate } from '../../types/api'

type Draft = Required<InstanceOperationsSettingsUpdate>

function draftFrom(settings: InstanceOperationsSettings): Draft {
  return {
    backup_interval_hours: settings.backup_interval_hours,
    backup_retention_count: settings.backup_retention_count,
    backup_include_logs: settings.backup_include_logs,
    backup_on_startup: settings.backup_on_startup,
    content_access_log_retention_enabled: settings.content_access_log_retention_enabled,
    content_access_log_retention_days: settings.content_access_log_retention_days,
    managed_host_egress_mode: settings.managed_host_egress_mode,
    managed_host_proxy_url: settings.managed_host_proxy_url,
    managed_host_no_proxy: settings.managed_host_no_proxy,
  }
}

function Toggle({ label, checked, disabled, onChange }: {
  label: string
  checked: boolean
  disabled: boolean
  onChange(value: boolean): void
}) {
  return (
    <label className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
      <span className="text-sm font-medium">{label}</span>
      <input
        type="checkbox"
        role="switch"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={event => onChange(event.target.checked)}
      />
    </label>
  )
}

export function OperationsSettingsPanel() {
  const [settings, setSettings] = useState<InstanceOperationsSettings | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  async function load() {
    setLoading(true)
    try {
      const next = await instanceOperationsApi.get()
      setSettings(next)
      setDraft(draftFrom(next))
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  async function save() {
    if (!draft) return
    setSaving(true)
    try {
      const next = await instanceOperationsApi.update(draft)
      setSettings(next)
      setDraft(draftFrom(next))
      toast.success('Operations settings saved')
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setSaving(false)
    }
  }

  const busy = loading || saving
  const dirty = Boolean(settings && draft && JSON.stringify(draft) !== JSON.stringify(draftFrom(settings)))

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2"><DatabaseBackup className="size-3.5" /> Operations &amp; retention</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Instance policy stored in the database. Ports, credentials, storage paths, and hard capacity limits remain deployment settings.
          </p>
        </div>
        {settings && <Badge variant={settings.backup_service_enabled ? 'success' : 'warning'}>{settings.backup_service_enabled ? 'backup available' : 'backup disabled by deployment'}</Badge>}
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={load} disabled={busy}>
          {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} Refresh
        </Button>
        <Button size="sm" onClick={save} disabled={!dirty || busy || !draft}>
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />} Save
        </Button>
      </div>

      {loading && !draft ? <p className="mt-4 text-sm text-muted-foreground">Loading operations settings…</p> : draft ? (
        <div className="mt-4 space-y-5">
          <section className="space-y-3">
            <div><h3 className="text-sm font-semibold">Automatic backups</h3><p className="text-xs text-muted-foreground">The deployment must enable the backup service; these values control its runtime policy.</p></div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div><Label htmlFor="backup-interval">Interval (hours)</Label><Input id="backup-interval" type="number" min={1} max={168} value={draft.backup_interval_hours} disabled={busy} onChange={event => setDraft(current => current ? { ...current, backup_interval_hours: Number(event.target.value) } : current)} /></div>
              <div><Label htmlFor="backup-retention">Automatic backups retained</Label><Input id="backup-retention" type="number" min={1} max={365} value={draft.backup_retention_count} disabled={busy} onChange={event => setDraft(current => current ? { ...current, backup_retention_count: Number(event.target.value) } : current)} /></div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Toggle label="Include logs in backups" checked={draft.backup_include_logs} disabled={busy} onChange={value => setDraft(current => current ? { ...current, backup_include_logs: value } : current)} />
              <Toggle label="Create a backup on server startup" checked={draft.backup_on_startup} disabled={busy} onChange={value => setDraft(current => current ? { ...current, backup_on_startup: value } : current)} />
            </div>
          </section>

          <section className="space-y-3 border-t border-border pt-4">
            <div><h3 className="text-sm font-semibold">Access audit retention</h3><p className="text-xs text-muted-foreground">Controls automatic pruning of cross-owner content access records.</p></div>
            <Toggle label="Prune expired access logs" checked={draft.content_access_log_retention_enabled} disabled={busy} onChange={value => setDraft(current => current ? { ...current, content_access_log_retention_enabled: value } : current)} />
            <div className="max-w-xs"><Label htmlFor="access-log-retention">Retention (days)</Label><Input id="access-log-retention" type="number" min={1} max={3650} value={draft.content_access_log_retention_days} disabled={busy || !draft.content_access_log_retention_enabled} onChange={event => setDraft(current => current ? { ...current, content_access_log_retention_days: Number(event.target.value) } : current)} /></div>
          </section>

          <section className="space-y-3 border-t border-border pt-4">
            <div>
              <h3 className="text-sm font-semibold">Built-in Host network</h3>
              <p className="text-xs text-muted-foreground">Controls how Managed Runs and verified built-in Host runtime downloads reach public services. Changes apply to the next Run or install request; no container restart is needed.</p>
            </div>
            <div className="max-w-md">
              <Label htmlFor="managed-host-egress-mode">Public network route</Label>
              <select
                id="managed-host-egress-mode"
                className="flex h-9 w-full rounded-md border border-border bg-input px-3 text-sm"
                value={draft.managed_host_egress_mode}
                disabled={busy}
                onChange={event => setDraft(current => current ? { ...current, managed_host_egress_mode: event.target.value as Draft['managed_host_egress_mode'] } : current)}
              >
                <option value="direct">Direct network</option>
                <option value="system_tun">System TUN / virtual network adapter</option>
                <option value="http_proxy">HTTP proxy</option>
              </select>
            </div>
            {draft.managed_host_egress_mode === 'system_tun' && (
              <p className="rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
                Use this when public domains resolve to RFC 2544 fake-IP addresses routed through a system-level TUN adapter. Runtime downloads still require a pinned SHA-256.
              </p>
            )}
            {draft.managed_host_egress_mode === 'http_proxy' && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="managed-host-proxy-url">Proxy URL</Label>
                  <Input id="managed-host-proxy-url" placeholder="http://proxy.example:7890" value={draft.managed_host_proxy_url ?? ''} disabled={busy} onChange={event => setDraft(current => current ? { ...current, managed_host_proxy_url: event.target.value || null } : current)} />
                  <p className="mt-1 text-xs text-muted-foreground">HTTP(S) URL only. Credentials are not stored in this setting.</p>
                </div>
                <div>
                  <Label htmlFor="managed-host-no-proxy">Direct exceptions</Label>
                  <Input id="managed-host-no-proxy" placeholder="localhost,.example.internal" value={draft.managed_host_no_proxy ?? ''} disabled={busy} onChange={event => setDraft(current => current ? { ...current, managed_host_no_proxy: event.target.value || null } : current)} />
                  <p className="mt-1 text-xs text-muted-foreground">Optional comma-separated NO_PROXY entries.</p>
                </div>
              </div>
            )}
          </section>
        </div>
      ) : <p className="mt-4 text-sm text-muted-foreground">Operations settings are unavailable.</p>}
    </Card>
  )
}
