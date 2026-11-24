import { useEffect, useState, useCallback } from 'react'
import { useSpace } from '../../contexts/SpaceContext'
import { pluginsApi } from '../../api/client'
import { useAppTranslation } from '../../i18n'
import { formatDate } from '../../i18n/format'
import { Button } from '../../components/ui/button'
import { Badge } from '../../components/ui/badge'
import { Card } from '../../components/ui/card'
import type { OfficialPluginCleanupStatus } from '@rainver/protocol'
import { announcePluginStateChanged } from './pluginStateEvents'

interface EffectiveState {
  plugin_id: string
  installed: boolean
  install_status?: string | null
  installed_version?: string | null
  enabled: boolean
  visible: boolean
  settings: Record<string, unknown>
  enabled_at?: string | null
  disabled_at?: string | null
}

interface PluginDescriptor {
  operation_api?:1
  id: string
  name: string
  description: string
  version: string
  category: string
  default_enabled: boolean
  scope: string
  lifecycle_status: string
  permissions: Record<string, unknown>
}

interface PluginListItem {
  descriptor: PluginDescriptor
  effective: EffectiveState
  /** Present only for a person who administers the plugin here, while a disable's cleanup is unfinished. */
  cleanup?: OfficialPluginCleanupStatus | null
}

type ActionState = Record<string, 'idle' | 'loading' | 'success' | 'error' | 'cleanup_failed'>

export default function PluginsPage() {
  const { activeSpaceId, preferredSpaceId, userId } = useSpace()
  const spaceId = activeSpaceId ?? preferredSpaceId
  return spaceId ? <ScopedPluginsPage key={JSON.stringify([userId, spaceId])} spaceId={spaceId} /> : null
}

function ScopedPluginsPage({ spaceId }: { spaceId: string }) {
  const { t } = useAppTranslation()
  const [items, setItems] = useState<PluginListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actions, setActions] = useState<ActionState>({})

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    pluginsApi.list({ spaceId })
      .then((data: { items?: unknown[] }) => {
        setItems((data?.items ?? []) as PluginListItem[])
        setLoading(false)
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : t('management_ui.plugins.load_failed'))
        setLoading(false)
      })
  }, [spaceId, t])

  useEffect(() => { load() }, [load])

  const setAction = (id: string, state: ActionState[string]) =>
    setActions(prev => ({ ...prev, [id]: state }))

  const notifyShell = announcePluginStateChanged

  const handleInstall = async (pluginId: string) => {
    setAction(pluginId, 'loading')
    try {
      await pluginsApi.install(pluginId, undefined, { spaceId })
      setAction(pluginId, 'success')
      load()
      notifyShell()
    } catch {
      setAction(pluginId, 'error')
    }
  }

  const handleEnable = async (pluginId: string) => {
    setAction(pluginId, 'loading')
    try {
      await pluginsApi.enable(pluginId, {}, undefined, { spaceId })
      setAction(pluginId, 'success')
      load()
      notifyShell()
    } catch {
      setAction(pluginId, 'error')
    }
  }

  const handleDisable = async (pluginId: string) => {
    setAction(pluginId, 'loading')
    try {
      await pluginsApi.disable(pluginId, {}, undefined, { spaceId })
      setAction(pluginId, 'success')
      load()
      notifyShell()
    } catch {
      setAction(pluginId, 'error')
    }
  }

  // A retry is a new disable round: it re-releases what the last one could not.
  const handleRetryCleanup = async (pluginId: string) => {
    setAction(pluginId, 'loading')
    try {
      const out = await pluginsApi.disable(pluginId, {}, undefined, { spaceId }) as { cleanup_pending?: boolean } | undefined
      setAction(pluginId, out?.cleanup_pending ? 'cleanup_failed' : 'success')
      load()
      notifyShell()
    } catch {
      setAction(pluginId, 'error')
    }
  }

  return (
    <div className="mx-auto my-8 max-w-3xl space-y-6 px-4 sm:px-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">{t('management_ui.plugins.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('management_ui.plugins.subtitle')}</p>
      </header>

      {loading && <p className="text-sm text-muted-foreground">{t('management_ui.plugins.loading')}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{t('management_ui.plugins.error', { message: error })}</p>}

      {!loading && items.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('management_ui.plugins.none')}</p>
      )}

      <div className="space-y-4">
        {items.map(({ descriptor, effective, cleanup }) => (
          <Card key={descriptor.id} className="mb-0">
            <div className="flex flex-col gap-4 sm:flex-row sm:justify-between">
              <div className="min-w-0 flex-1">
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <h2 className="font-semibold text-foreground">{descriptor.name}</h2>
                  <Badge variant="muted" className="capitalize">{descriptor.category}</Badge>
                  <span className="text-xs text-muted-foreground">v{descriptor.version}</span>
                  {descriptor.lifecycle_status === 'deprecated' && (
                    <Badge variant="warning">{t('management_ui.plugins.deprecated')}</Badge>
                  )}
                </div>
                <p className="text-sm text-muted-foreground">
                  {descriptor.description}
                </p>
                <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                  <span>
                    {descriptor.scope === 'user' ? t('management_ui.plugins.scope_account') : t('management_ui.plugins.scope_space')}
                  </span>
                  {effective.installed && (
                    <span className="text-success">
                      {effective.installed_version ? t('management_ui.plugins.installed_version', { version: effective.installed_version }) : t('management_ui.plugins.installed')}
                    </span>
                  )}
                  {!effective.installed && (
                    <span>{t('management_ui.plugins.not_installed')}</span>
                  )}
                  {effective.enabled && effective.enabled_at && (
                    <span className="text-success">
                      {t('management_ui.plugins.enabled_on', { date: formatDate(effective.enabled_at) })}
                    </span>
                  )}
                  {!effective.enabled && effective.disabled_at && (
                    <span>{t('management_ui.plugins.disabled_on', { date: formatDate(effective.disabled_at) })}</span>
                  )}
                  {!effective.enabled && !effective.disabled_at && (
                    <span>{t('management_ui.plugins.not_yet_enabled')}</span>
                  )}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 self-start sm:max-w-xs">
                <Badge variant={effective.enabled ? 'success' : 'muted'}>
                  {effective.enabled ? t('management_ui.plugins.state_enabled') : effective.installed ? t('management_ui.plugins.installed') : t('management_ui.plugins.state_available')}
                </Badge>
                {!effective.installed ? descriptor.operation_api===1 ? (
                  <span className="text-sm text-muted-foreground">{t('plugin_ui.offline')}</span>
                ) : (
                  <Button size="sm" type="button"
                    onClick={() => handleInstall(descriptor.id)}
                    disabled={actions[descriptor.id] === 'loading'}
                  >
                    {actions[descriptor.id] === 'loading' ? t('management_ui.plugins.installing') : t('management_ui.plugins.install')}
                  </Button>
                ) : effective.enabled ? (
                  <Button size="sm" type="button" variant="outline"
                    onClick={() => handleDisable(descriptor.id)}
                    disabled={actions[descriptor.id] === 'loading'}
                  >
                    {actions[descriptor.id] === 'loading' ? t('management_ui.plugins.disabling') : t('management_ui.plugins.disable')}
                  </Button>
                ) : (
                  <Button size="sm" type="button"
                    onClick={() => handleEnable(descriptor.id)}
                    disabled={actions[descriptor.id] === 'loading' || !!cleanup}
                  >
                    {actions[descriptor.id] === 'loading' ? t('management_ui.plugins.enabling') : t('management_ui.plugins.enable')}
                  </Button>
                )}
              </div>
            </div>

            {cleanup && (
              <CleanupNotice
                cleanup={cleanup}
                retrying={actions[descriptor.id] === 'loading'}
                refreshing={loading}
                onRetry={() => handleRetryCleanup(descriptor.id)}
                onRefresh={load}
              />
            )}
            {actions[descriptor.id] === 'cleanup_failed' && (
              <p className="mt-2 mb-0 text-xs text-destructive">{t('management_ui.plugins.cleanup_retry_failed')}</p>
            )}
            {actions[descriptor.id] === 'error' && (
              <p className="mt-2 text-sm text-destructive">
                {t('management_ui.plugins.action_failed')}
              </p>
            )}
          </Card>
        ))}
      </div>

      <p className="text-xs text-muted-foreground">
        {t('management_ui.plugins.footer')}
      </p>
    </div>
  )
}

/**
 * The unfinished cleanup of a disable, beside the card's (disabled) Enable.
 * A failed release is retried by a new disable round; a hold kept by its live
 * service process is not, so that state offers only a status refresh and
 * explains that it clears after the process restarts or exits.
 */
function CleanupNotice({ cleanup, retrying, refreshing, onRetry, onRefresh }: {
  cleanup: OfficialPluginCleanupStatus
  retrying: boolean
  refreshing: boolean
  onRetry: () => void
  onRefresh: () => void
}) {
  const { t } = useAppTranslation()
  const restart = cleanup.awaiting_restart ?? 0
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <div role="status" className="flex flex-1 basis-60 flex-col gap-1 text-xs text-warning">
        {cleanup.attention > 0 && <p className="m-0">{t('management_ui.plugins.cleanup_attention', { count: cleanup.attention })}</p>}
        {restart > 0 && <p className="m-0">{t('management_ui.plugins.cleanup_awaiting_restart', { count: restart })}</p>}
        {cleanup.pending > 0 && <p className="m-0">{t('management_ui.plugins.cleanup_pending', { count: cleanup.pending })}</p>}
        {cleanup.last_attempt_at && (
          <span className="text-muted-foreground">{t('management_ui.plugins.cleanup_last_attempt', { date: formatDate(cleanup.last_attempt_at) })}</span>
        )}
      </div>
      {cleanup.state === 'awaiting_restart' ? (
        <Button size="sm" variant="outline" onClick={onRefresh} disabled={refreshing}>
          {t('management_ui.plugins.cleanup_refresh')}
        </Button>
      ) : (
        <Button size="sm" variant="outline" onClick={onRetry} disabled={retrying}>
          {retrying ? t('management_ui.plugins.cleanup_retrying') : t('management_ui.plugins.cleanup_retry')}
        </Button>
      )}
    </div>
  )
}
