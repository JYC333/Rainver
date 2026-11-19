import {useCallback, useEffect, useRef, useState} from 'react'
import type {OperationOutput} from '@rainver/protocol'
import {queryOperation} from '../../api/client'
import {useSpace} from '../../contexts/SpaceContext'
import {registerInMemoryResidue, sessionEpoch} from '../../lib/sessionResidue'
import {bundledOperationPlugins} from './manifestCatalog'
import {onPluginStateChanged} from './pluginStateEvents'

export type ProjectPluginBindings = OperationOutput<'official_plugin.project_binding.list'>
const CHANGED = 'rainver:project-plugin-bindings-changed'

/** Whether any bundled package needs a Project binding; without one, nothing mounts this hook or asks the server. */
export const hasProjectBoundPlugins = () => bundledOperationPlugins.some(p => p.manifest.project_binding === 'required')
export const isProjectBound = (pluginId: string) => bundledOperationPlugins.some(p => p.manifest.id === pluginId && p.manifest.project_binding === 'required')

/** Tell every mounted reader of this Project's bindings to read them again. */
export function announceProjectPluginBindingsChanged(projectId: string) {
  window.dispatchEvent(new CustomEvent(CHANGED, {detail: {projectId}}))
}

/** Subscribe to binding changes announced for one Project; returns the unsubscribe. */
export function onProjectPluginBindingsChanged(projectId: string, listener: () => void): () => void {
  const changed = (event: Event) => { if ((event as CustomEvent<{projectId?: string}>).detail?.projectId === projectId) listener() }
  window.addEventListener(CHANGED, changed)
  return () => window.removeEventListener(CHANGED, changed)
}

/**
 * One Project's plugin bindings as the server reports them for this person.
 * The server stays the authority: entries render only for `effective` items,
 * and every operation is checked again. A refusal or failure shows nothing.
 */
export function useProjectPluginBindings(projectId: string | null) {
  const {userId, activeSpaceId, preferredSpaceId} = useSpace()
  const spaceId = activeSpaceId ?? preferredSpaceId ?? ''
  const scope = `${userId}:${spaceId}:${projectId}`
  const sequence = useRef(0)
  const [state, setState] = useState<{scope: string; data: ProjectPluginBindings | null; failed: boolean}>({scope: '', data: null, failed: false})
  const refresh = useCallback(() => {
    if (!projectId || !spaceId) return
    const call = ++sequence.current, epoch = sessionEpoch()
    queryOperation('official_plugin.project_binding.list', {project_id: projectId}, {spaceId})
      .then(result => {
        if (call !== sequence.current || epoch !== sessionEpoch()) return
        setState({scope, data: 'status' in result && result.status === 'succeeded' ? result.data : null, failed: !('status' in result && result.status === 'succeeded')})
      })
      .catch(() => {
        if (call !== sequence.current || epoch !== sessionEpoch()) return
        setState({scope, data: null, failed: true})
      })
  }, [projectId, spaceId, scope])
  useEffect(() => {
    refresh()
    const unsubscribe = projectId ? onProjectPluginBindingsChanged(projectId, refresh) : () => {}
    // Enabling or disabling a package changes which bindings are effective, as a binding change does.
    const unsubscribeState = onPluginStateChanged(refresh)
    window.addEventListener('focus', refresh)
    return () => { ++sequence.current; unsubscribe(); unsubscribeState(); window.removeEventListener('focus', refresh) }
  }, [refresh, projectId])
  useEffect(() => registerInMemoryResidue(() => { ++sequence.current; setState({scope: '', data: null, failed: false}) }), [])
  const current = state.scope === scope ? state : {scope, data: null, failed: false}
  const isBound = useCallback((pluginId: string) => current.data?.items.some(i => i.plugin_id === pluginId && i.effective) ?? false, [current.data])
  return {bindings: current.data, failed: current.failed, loading: !current.data && !current.failed, refresh, isBound}
}
