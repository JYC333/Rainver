import { useEffect, useState, useCallback } from 'react'
import { pluginsApi } from '../../api/client'

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
}

type ActionState = Record<string, 'idle' | 'loading' | 'success' | 'error'>

export default function PluginsPage() {
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
        setError(err instanceof Error ? err.message : 'Failed to load plugins')
        setLoading(false)
      })
  }, [])

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

  return (
    <div style={{ maxWidth: 720, margin: '32px auto', padding: '0 24px', fontFamily: 'inherit' }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>Optional Modules</h1>
      <p style={{ color: '#666', marginBottom: 28, fontSize: 14 }}>
        Official optional modules are developed by rainver maintainers and can be
        enabled or disabled per account. This is not a third-party plugin marketplace.
      </p>

      {loading && <p style={{ color: '#888' }}>Loading…</p>}
      {error && <p style={{ color: '#b71c1c' }}>Error: {error}</p>}

      {!loading && items.length === 0 && (
        <p style={{ color: '#888' }}>No official optional modules registered.</p>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {items.map(({ descriptor, effective }) => (
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
                      Deprecated
                    </span>
                  )}
                </div>
                <p style={{ margin: 0, color: '#555', fontSize: 14, lineHeight: 1.5 }}>
                  {descriptor.description}
                </p>
                <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 12, color: '#888' }}>
                    Scope: {descriptor.scope === 'user' ? 'per account' : 'per space'}
                  </span>
                  {effective.installed && (
                    <span style={{ fontSize: 12, color: '#4caf50' }}>
                      Installed {effective.installed_version ? `v${effective.installed_version}` : ''}
                    </span>
                  )}
                  {!effective.installed && (
                    <span style={{ fontSize: 12, color: '#999' }}>Not installed</span>
                  )}
                  {effective.enabled && effective.enabled_at && (
                    <span style={{ fontSize: 12, color: '#4caf50' }}>
                      Enabled {new Date(effective.enabled_at).toLocaleDateString()}
                    </span>
                  )}
                  {!effective.enabled && effective.disabled_at && (
                    <span style={{ fontSize: 12, color: '#999' }}>
                      Disabled {new Date(effective.disabled_at).toLocaleDateString()}
                    </span>
                  )}
                  {!effective.enabled && !effective.disabled_at && (
                    <span style={{ fontSize: 12, color: '#bbb' }}>Not yet enabled</span>
                  )}
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                <span style={{
                  width: 8, height: 8, borderRadius: '50%', display: 'inline-block',
                  background: effective.enabled ? '#4caf50' : effective.installed ? '#90a4ae' : '#bdbdbd',
                }} />
                <span style={{ fontSize: 13, color: effective.enabled ? '#2e7d32' : '#757575', fontWeight: 500 }}>
                  {effective.enabled ? 'Enabled' : effective.installed ? 'Installed' : 'Available'}
                </span>
                {!effective.installed ? (
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
                    {actions[descriptor.id] === 'loading' ? 'Installing…' : 'Install'}
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
                    {actions[descriptor.id] === 'loading' ? 'Disabling…' : 'Disable'}
                  </button>
                ) : (
                  <button
                    onClick={() => handleEnable(descriptor.id)}
                    disabled={actions[descriptor.id] === 'loading'}
                    style={{
                      padding: '6px 14px', borderRadius: 6, border: 'none',
                      background: '#1976d2', color: '#fff', cursor: 'pointer',
                      fontSize: 13, fontWeight: 500,
                      opacity: actions[descriptor.id] === 'loading' ? 0.6 : 1,
                    }}
                  >
                    {actions[descriptor.id] === 'loading' ? 'Enabling…' : 'Enable'}
                  </button>
                )}
              </div>
            </div>

            {actions[descriptor.id] === 'error' && (
              <p style={{ margin: '8px 0 0', color: '#b71c1c', fontSize: 13 }}>
                Action failed. Please try again.
              </p>
            )}
          </div>
        ))}
      </div>

      <p style={{ marginTop: 32, fontSize: 12, color: '#bbb' }}>
        Install runs the official plugin package migrations. Third-party plugin downloads are not implemented yet.
      </p>
    </div>
  )
}
