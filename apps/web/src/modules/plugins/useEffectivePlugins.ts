import { useState, useEffect, useCallback, useMemo } from 'react'
import type { OfficialPluginEffectiveMap } from '@rainver/protocol'
import { pluginsApi } from '../../api/client'
import { MODULE_REGISTRY, modulesWithEffectivePlugins, type Module } from '../registry'

type EffectivePluginMap = OfficialPluginEffectiveMap

interface UseEffectivePluginsResult {
  plugins: EffectivePluginMap
  loading: boolean
  error: string | null
  refresh: () => void
  isEnabled: (pluginId: string) => boolean
  isVisible: (pluginId: string) => boolean
}

/**
 * Fetches effective plugin state from GET /api/v1/plugins/effective and exposes
 * it as a map keyed by plugin_id.
 *
 * The frontend is NOT the source of truth for plugin enabled state.
 * This hook bridges the static MODULE_REGISTRY with the backend control plane.
 *
 * Usage:
 *   const { isEnabled, isVisible, loading } = useEffectivePlugins()
 *   const showDiary = isEnabled('diary')
 */
export function useEffectivePlugins(): UseEffectivePluginsResult {
  const [plugins, setPlugins] = useState<EffectivePluginMap>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetch = useCallback(() => {
    setLoading(true)
    setError(null)
    pluginsApi.effective()
      .then((data) => {
        setPlugins(data?.plugins ?? {})
        setLoading(false)
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load plugin state')
        setLoading(false)
      })
  }, [])

  useEffect(() => {
    fetch()
  }, [fetch])

  const isEnabled = useCallback(
    (pluginId: string): boolean => plugins[pluginId]?.enabled ?? false,
    [plugins],
  )

  const isVisible = useCallback(
    (pluginId: string): boolean => plugins[pluginId]?.visible ?? true,
    [plugins],
  )

  return { plugins, loading, error, refresh: fetch, isEnabled, isVisible }
}

interface UseEffectiveModulesResult {
  modules: Module[]
  refresh: () => void
}

export function useEffectiveModules(): UseEffectiveModulesResult {
  const { plugins, refresh } = useEffectivePlugins()
  const modules = useMemo(
    () => modulesWithEffectivePlugins(MODULE_REGISTRY, plugins),
    [plugins],
  )
  return { modules, refresh }
}
