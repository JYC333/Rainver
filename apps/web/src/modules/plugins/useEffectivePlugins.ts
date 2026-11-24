import {useSpace} from '../../contexts/SpaceContext'
import {registerInMemoryResidue,sessionEpoch} from '../../lib/sessionResidue'
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { OfficialPluginEffectiveMap } from '@rainver/protocol'
import { pluginsApi } from '../../api/client'
import i18n from '../../i18n'
import { MODULE_REGISTRY, modulesWithEffectivePlugins, type Module } from '../registry'
import { onPluginStateChanged } from './pluginStateEvents'

type EffectivePluginMap = OfficialPluginEffectiveMap

interface UseEffectivePluginsResult {
  plugins: EffectivePluginMap
  loading: boolean
  error: string | null
  refresh: () => void
  isEnabled: (pluginId: string) => boolean
  isVisible: (pluginId: string) => boolean
}

interface ReadState { plugins: EffectivePluginMap; loading: boolean; error: string | null; settled: boolean }
const INITIAL: ReadState = { plugins: {}, loading: true, error: null, settled: false }

/**
 * One read per signed-in session (epoch), person and Space, shared by every mounted
 * reader (the Shell rail, Project navigation and plugin slots). A response is
 * applied only to the scope and the read that asked for it; a newer read, a
 * Space switch, an unmount of the last reader or a sign-out makes it stale.
 */
interface Scope {
  key: string
  space: string | null
  state: ReadState
  listeners: Set<() => void>
  /** Advanced for every read that supersedes the one in flight. */
  generation: number
  request: Promise<void> | null
  /** Session epoch the read in flight began in; a later session never joins it. */
  requestEpoch: number
  stop: (() => void) | null
}

const scopes = new Map<string, Scope>()

function publish(scope: Scope, state: ReadState) {
  scope.state = state
  for (const listener of [...scope.listeners]) listener()
}

/** Join the read in flight unless `fresh` asks for one that starts after now. */
function read(scope: Scope, fresh = false): Promise<void> {
  const epoch = sessionEpoch()
  if (scope.request && !fresh && scope.requestEpoch === epoch) return scope.request
  const generation = ++scope.generation
  const current = () => generation === scope.generation && epoch === sessionEpoch() && scopes.get(scope.key) === scope
  if (!scope.state.loading || scope.state.error) publish(scope, { ...scope.state, loading: true, error: null })
  const request = pluginsApi.effective(scope.space ? { spaceId: scope.space } : {})
    .then(data => { if (current()) publish(scope, { plugins: data?.plugins ?? {}, loading: false, error: null, settled: true }) },
      (err: unknown) => {
        if (current()) publish(scope, { plugins: {}, loading: false, settled: true,
          error: err instanceof Error ? err.message : i18n.t('management_ui.plugins.state_load_failed') })
      })
    .finally(() => { if (scope.request === request) scope.request = null })
  scope.request = request
  scope.requestEpoch = epoch
  return request
}

function scopeFor(key: string, space: string | null): Scope {
  let scope = scopes.get(key)
  if (!scope) {
    scope = { key, space, state: INITIAL, listeners: new Set(), generation: 0, request: null, requestEpoch: -1, stop: null }
    scopes.set(key, scope)
  }
  return scope
}

function forget(scope: Scope) {
  scope.stop?.()
  scope.stop = null
  scope.generation++
  scope.request = null
  if (scopes.get(scope.key) === scope) scopes.delete(scope.key)
}

function subscribe(scope: Scope, listener: () => void): () => void {
  // A reader can render a scope and subscribe after the previous reader let it go.
  if (!scopes.has(scope.key)) scopes.set(scope.key, scope)
  scope.listeners.add(listener)
  // A reader mounting after the first read settled reuses it; a failure, or a
  // read abandoned when the last reader left, is read again.
  if (!scope.request && (!scope.state.settled || scope.state.error || scope.state.loading)) void read(scope)
  if (!scope.stop) {
    // One set of triggers per scope, however many readers share it.
    const refresh = () => { void read(scope) }
    const changed = () => { void read(scope, true) }
    window.addEventListener('focus', refresh)
    const unsubscribe = onPluginStateChanged(changed)
    const timer = window.setInterval(refresh, 30000)
    scope.stop = () => { window.removeEventListener('focus', refresh); unsubscribe(); window.clearInterval(timer) }
  }
  return () => {
    scope.listeners.delete(listener)
    // A StrictMode or route remount resubscribes in the same task.
    queueMicrotask(() => { if (scope.listeners.size === 0) forget(scope) })
  }
}

// Sign-out, a 401 and another tab's sign-out: nothing read for that session
// stays visible, and its read in flight is never applied or joined. No read
// starts here — a reader still mounted reads again on its next trigger, as
// before, rather than answering a sign-out with another refused request.
registerInMemoryResidue(() => {
  for (const scope of scopes.values()) {
    scope.generation++
    scope.request = null
    publish(scope, INITIAL)
  }
})

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
  const space=activeSpaceId??preferredSpaceId??null
  const key=`${userId}:${space}`
  const scope=useMemo(()=>scopeFor(key,space),[key,space])
  const listen=useCallback((listener:()=>void)=>subscribe(scope,listener),[scope])
  const state=useSyncExternalStore(listen,()=>scope.state)
  const refresh=useCallback(()=>{void read(scope,true)},[scope])
  const visiblePlugins=state.plugins

  const isEnabled = useCallback(
    (pluginId: string): boolean => visiblePlugins[pluginId]?.enabled ?? false,
    [visiblePlugins],
  )

  const isVisible = useCallback(
    (pluginId: string): boolean => visiblePlugins[pluginId]?.visible ?? true,
    [visiblePlugins],
  )

  return { plugins:visiblePlugins, loading:state.loading||!state.settled, error:state.error, refresh, isEnabled, isVisible }
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
