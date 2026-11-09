import {useSpace} from '../../contexts/SpaceContext'
import {registerInMemoryResidue,sessionEpoch} from '../../lib/sessionResidue'
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import type { OfficialPluginEffectiveMap } from '@rainver/protocol'
import { pluginsApi } from '../../api/client'
import i18n from '../../i18n'
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
  const {userId,activeSpaceId,preferredSpaceId}=useSpace()
  const space=activeSpaceId??preferredSpaceId
  const scope=`${userId}:${space}`
  const sequence=useRef(0)
  const [loadedScope,setLoadedScope]=useState('')
  const [plugins, setPlugins] = useState<EffectivePluginMap>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetch = useCallback(() => {
    const call=++sequence.current,epoch=sessionEpoch()
    setLoading(true)
    setError(null)
    pluginsApi.effective(space?{spaceId:space}:{})
      .then((data) => {
        if(call!==sequence.current||epoch!==sessionEpoch())return
        setLoadedScope(scope)
        setPlugins(data?.plugins ?? {})
        setLoading(false)
      })
      .catch((err: unknown) => {
        if(call!==sequence.current||epoch!==sessionEpoch())return
        setPlugins({});setLoadedScope(scope)
        setError(err instanceof Error ? err.message : i18n.t('management_ui.plugins.state_load_failed'))
        setLoading(false)
      })
  }, [scope,space])

  useEffect(() => {
    fetch()
    const refresh=()=>fetch()
    window.addEventListener('focus',refresh)
    const timer=window.setInterval(refresh,30000)
    return()=>{++sequence.current;window.removeEventListener('focus',refresh);window.clearInterval(timer)}
  }, [fetch])
  useEffect(()=>registerInMemoryResidue(()=>{++sequence.current;setPlugins({});setLoadedScope('')}),[])
  const visiblePlugins=loadedScope===scope?plugins:{}

  const isEnabled = useCallback(
    (pluginId: string): boolean => visiblePlugins[pluginId]?.enabled ?? false,
    [visiblePlugins],
  )

  const isVisible = useCallback(
    (pluginId: string): boolean => visiblePlugins[pluginId]?.visible ?? true,
    [visiblePlugins],
  )

  return { plugins:visiblePlugins, loading:loading||loadedScope!==scope, error, refresh: fetch, isEnabled, isVisible }
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
