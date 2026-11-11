import { useEffect, useState, useCallback } from 'react'
import { pluginsApi } from '../../api/client'
import { useAppTranslation } from '../../i18n'
import { formatDate } from '../../i18n/format'
import { Button } from '../../components/ui/button'
import type { OfficialPluginCleanupStatus } from '@rainver/protocol'

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
  const { t } = useAppTranslation()
  const [items, setItems] = useState<PluginListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actions, setActions] = useState<ActionState>({})

  const load = useCallback(() => {
    setLoading(true)
    pluginsApi.list()
      .then((data: { items?: unknown[] }) => {
        setItems((data?.items ?? []) as PluginListItem[])
        setLoading(false)
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : t('management_ui.plugins.load_failed'))
        setLoading(false)
      })
  }, [t])

  useEffect(() => { load() }, [load])

  const setAction = (id: string, state: ActionState[string]) =>
    setActions(prev => ({ ...prev, [id]: state }))

  const notifyShell = () =>
    window.dispatchEvent(new CustomEvent('rainver:plugin-state-changed'))

  const handleInstall = async (pluginId: string) => {
    setAction(pluginId, 'loading')
    try {
      await pluginsApi.install(pluginId)
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
      await pluginsApi.enable(pluginId)
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
      await pluginsApi.disable(pluginId)
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
      const out = await pluginsApi.disable(pluginId) as { cleanup_pending?: boolean } | undefined
      setAction(pluginId, out?.cleanup_pending ? 'cleanup_failed' : 'success')
      load()
      notifyShell()
    } catch {
      setAction(pluginId, 'error')
    }
  }

  return (
    <div style={{ maxWidth: 720, margin: '32px auto', padding: '0 24px', fontFamily: 'inherit' }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>{t('management_ui.plugins.title')}</h1>
      <p style={{ color: '#666', marginBottom: 28, fontSize: 14 }}>
        {t('management_ui.plugins.subtitle')}
      </p>

      {loading && <p style={{ color: '#888' }}>{t('management_ui.plugins.loading')}</p>}
      {error && <p style={{ color: '#b71c1c' }}>{t('management_ui.plugins.error', { message: error })}</p>}

      {!loading && items.length === 0 && (
        <p style={{ color: '#888' }}>{t('management_ui.plugins.none')}</p>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {items.map(({ descriptor, effective, cleanup }) => (
          <div key={descriptor.id} style={{
            border: '1px solid #e0e0e0', borderRadius: 10, padding: '20px 24px',
            background: '#fff',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                  <span style={{ fontWeight: 700, fontSize: 16 }}>{descriptor.name}</span>
                  <span style={{
                    fontSize: 11, fontWeight: 600, background: '#f5f5f5',
                    color: '#666', borderRadius: 4, padding: '1px 7px',
                    textTransform: 'capitalize',
                  }}>
                    {descriptor.category}
                  </span>
                  <span style={{
                    fontSize: 11, color: '#999',
                  }}>
                    v{descriptor.version}
                  </span>
                  {descriptor.lifecycle_status === 'deprecated' && (
                    <span style={{
                      fontSize: 11, fontWeight: 600, background: '#fff3e0',
                      color: '#e65100', borderRadius: 4, padding: '1px 7px',
                    }}>
                      {t('management_ui.plugins.deprecated')}
                    </span>
                  )}
                </div>
                <p style={{ margin: 0, color: '#555', fontSize: 14, lineHeight: 1.5 }}>
                  {descriptor.description}
                </p>
                <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 12, color: '#888' }}>
                    {descriptor.scope === 'user' ? t('management_ui.plugins.scope_account') : t('management_ui.plugins.scope_space')}
                  </span>
                  {effective.installed && (
                    <span style={{ fontSize: 12, color: '#4caf50' }}>
                      {effective.installed_version ? t('management_ui.plugins.installed_version', { version: effective.installed_version }) : t('management_ui.plugins.installed')}
                    </span>
                  )}
                  {!effective.installed && (
                    <span style={{ fontSize: 12, color: '#999' }}>{t('management_ui.plugins.not_installed')}</span>
                  )}
                  {effective.enabled && effective.enabled_at && (
                    <span style={{ fontSize: 12, color: '#4caf50' }}>
                      {t('management_ui.plugins.enabled_on', { date: formatDate(effective.enabled_at) })}
                    </span>
                  )}
                  {!effective.enabled && effective.disabled_at && (
                    <span style={{ fontSize: 12, color: '#999' }}>
                      {t('management_ui.plugins.disabled_on', { date: formatDate(effective.disabled_at) })}
                    </span>
                  )}
                  {!effective.enabled && !effective.disabled_at && (
                    <span style={{ fontSize: 12, color: '#bbb' }}>{t('management_ui.plugins.not_yet_enabled')}</span>
                  )}
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                <span style={{
                  width: 8, height: 8, borderRadius: '50%', display: 'inline-block',
                  background: effective.enabled ? '#4caf50' : effective.installed ? '#90a4ae' : '#bdbdbd',
                }} />
                <span style={{ fontSize: 13, color: effective.enabled ? '#2e7d32' : '#757575', fontWeight: 500 }}>
                  {effective.enabled ? t('management_ui.plugins.state_enabled') : effective.installed ? t('management_ui.plugins.installed') : t('management_ui.plugins.state_available')}
                </span>
                {!effective.installed ? descriptor.operation_api===1 ? (
                  <span className="text-sm text-muted-foreground">{t('plugin_ui.offline')}</span>
                ) : (
                  <button
                    onClick={() => handleInstall(descriptor.id)}
                    disabled={actions[descriptor.id] === 'loading'}
                    style={{
                      padding: '6px 14px', borderRadius: 6, border: 'none',
                      background: '#1976d2', color: '#fff', cursor: 'pointer',
                      fontSize: 13, fontWeight: 500,
                      opacity: actions[descriptor.id] === 'loading' ? 0.6 : 1,
                    }}
                  >
                    {actions[descriptor.id] === 'loading' ? t('management_ui.plugins.installing') : t('management_ui.plugins.install')}
                  </button>
                ) : effective.enabled ? (
                  <button
                    onClick={() => handleDisable(descriptor.id)}
                    disabled={actions[descriptor.id] === 'loading'}
                    style={{
                      padding: '6px 14px', borderRadius: 6, border: '1px solid #e0e0e0',
                      background: '#fafafa', cursor: 'pointer', fontSize: 13, fontWeight: 500,
                      opacity: actions[descriptor.id] === 'loading' ? 0.6 : 1,
                    }}
                  >
                    {actions[descriptor.id] === 'loading' ? t('management_ui.plugins.disabling') : t('management_ui.plugins.disable')}
                  </button>
                ) : (
                  <button
                    onClick={() => handleEnable(descriptor.id)}
                    disabled={actions[descriptor.id] === 'loading' || !!cleanup}
                    style={{
                      padding: '6px 14px', borderRadius: 6, border: 'none',
                      background: '#1976d2', color: '#fff',
                      fontSize: 13, fontWeight: 500,
                      opacity: actions[descriptor.id] === 'loading' || cleanup ? 0.6 : 1,
                      cursor: cleanup ? 'not-allowed' : 'pointer',
                    }}
                  >
                    {actions[descriptor.id] === 'loading' ? t('management_ui.plugins.enabling') : t('management_ui.plugins.enable')}
                  </button>
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
              <p style={{ margin: '8px 0 0', color: '#b71c1c', fontSize: 13 }}>
                {t('management_ui.plugins.action_failed')}
              </p>
            )}
          </div>
        ))}
      </div>

      <p style={{ marginTop: 32, fontSize: 12, color: '#bbb' }}>
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
