import { useEffect, useState } from 'react'
import { Loader2, RefreshCw, Save, ShieldAlert } from 'lucide-react'
import { toast } from 'sonner'
import { sourcesApi } from '../../api/client'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Card, CardTitle } from '../../components/ui/card'
import { errMsg } from '../../lib/utils'
import type { CustomSourceInstanceRunnerSettings } from '../../types/api'

function bytesLabel(value: number): string {
  if (value >= 1024 * 1024) return `${Math.round(value / (1024 * 1024))} MB`
  if (value >= 1024) return `${Math.round(value / 1024)} KB`
  return `${value} B`
}

function msLabel(value: number): string {
  if (value >= 1000) return `${Math.round(value / 1000)} s`
  return `${value} ms`
}

function AvailabilityBadge({ available }: { available: boolean }) {
  return <Badge variant={available ? 'success' : 'secondary'}>{available ? 'available' : 'disabled'}</Badge>
}

export function SourceExecutionSettingsPanel() {
  const [settings, setSettings] = useState<CustomSourceInstanceRunnerSettings | null>(null)
  const [draftRunnerEnabled, setDraftRunnerEnabled] = useState<boolean | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  async function load() {
    setLoading(true)
    try {
      const next = await sourcesApi.customSourceInstanceRunnerSettings()
      setSettings(next)
      setDraftRunnerEnabled(next.runner_enabled)
    } catch (err) {
      toast.error(errMsg(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  async function saveRunnerEnabled() {
    if (!settings || draftRunnerEnabled === null) return
    setSaving(true)
    try {
      const next = await sourcesApi.updateCustomSourceInstanceRunnerSettings({
        runner_enabled: draftRunnerEnabled,
      })
      setSettings(next)
      setDraftRunnerEnabled(next.runner_enabled)
      toast.success('Source execution settings updated')
    } catch (err) {
      toast.error(errMsg(err))
    } finally {
      setSaving(false)
    }
  }

  const runnerEnabled = draftRunnerEnabled ?? settings?.runner_enabled ?? true
  const dirty = settings ? runnerEnabled !== settings.runner_enabled : false

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2">
            <ShieldAlert className="size-3.5" /> Sources Execution
          </CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Review the server-wide execution policy and resource limits for Sources.
          </p>
        </div>
        <Badge variant={runnerEnabled ? 'success' : 'secondary'} className="shrink-0">
          {runnerEnabled ? 'enabled' : 'disabled'}
        </Badge>
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={load} disabled={loading}>
          {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          Refresh
        </Button>
        <Button size="sm" onClick={saveRunnerEnabled} disabled={!dirty || loading || saving || !settings}>
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
          Save
        </Button>
      </div>

      {loading && !settings ? (
        <p className="mt-4 text-sm text-muted-foreground">Loading Source execution settings…</p>
      ) : settings ? (
        <div className="mt-4 space-y-4">
          <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
            <div>
              <div className="text-sm font-medium">Runner availability</div>
              <p className="text-xs text-muted-foreground">Server-wide execution gate for Source Goals and declarative pipelines.</p>
            </div>
            <label className="relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center">
              <input
                type="checkbox"
                role="switch"
                aria-label="Source execution availability"
                className="peer sr-only"
                checked={runnerEnabled}
                disabled={loading || saving}
                onChange={event => setDraftRunnerEnabled(event.target.checked)}
              />
              <span className="h-6 w-11 rounded-full bg-muted transition-colors peer-checked:bg-primary peer-disabled:opacity-60" />
              <span className="absolute left-0.5 size-5 rounded-full bg-background shadow-sm transition-transform peer-checked:translate-x-5" />
            </label>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-md border border-border p-3">
              <div className="text-xs text-muted-foreground">Allowed languages</div>
              <div className="mt-1 text-sm font-medium">
                {settings.allowed_languages.length > 0 ? settings.allowed_languages.join(', ') : 'none'}
              </div>
            </div>
            <div className="rounded-md border border-border p-3">
              <div className="text-xs text-muted-foreground">Network hard denies</div>
              <div className="mt-1 text-sm font-medium">
                {settings.network_hard_deny_rules.length > 0 ? settings.network_hard_deny_rules.join(', ') : 'none'}
              </div>
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            <div className="rounded-md border border-border p-3">
              <div className="text-xs text-muted-foreground">Timeout max</div>
              <div className="mt-1 text-sm font-medium">{msLabel(settings.timeout_ms_max)}</div>
            </div>
            <div className="rounded-md border border-border p-3">
              <div className="text-xs text-muted-foreground">Output max</div>
              <div className="mt-1 text-sm font-medium">{bytesLabel(settings.output_bytes_max)}</div>
            </div>
            <div className="rounded-md border border-border p-3">
              <div className="text-xs text-muted-foreground">Log max</div>
              <div className="mt-1 text-sm font-medium">{bytesLabel(settings.log_bytes_max)}</div>
            </div>
            <div className="rounded-md border border-border p-3">
              <div className="text-xs text-muted-foreground">File count max</div>
              <div className="mt-1 text-sm font-medium">{settings.max_files}</div>
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-3">
            <div className="flex items-center justify-between gap-3 rounded-md border border-border p-3">
              <span className="text-sm font-medium">Browser automation</span>
              <AvailabilityBadge available={settings.browser_automation_available} />
            </div>
            <div className="flex items-center justify-between gap-3 rounded-md border border-border p-3">
              <span className="text-sm font-medium">Shell</span>
              <AvailabilityBadge available={settings.shell_available} />
            </div>
            <div className="flex items-center justify-between gap-3 rounded-md border border-border p-3">
              <span className="text-sm font-medium">Dependency install</span>
              <AvailabilityBadge available={settings.dependency_installation_available} />
            </div>
          </div>
        </div>
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">Source execution settings are unavailable.</p>
      )}
    </Card>
  )
}
