import { useCallback, useEffect, useRef, useState } from 'react'
import { ambientSessionsApi, projectFoldersApi } from '../../api/client'
import type { WorkspaceLocation } from '../../types/api'

type Offer = Awaited<ReturnType<typeof ambientSessionsApi.offer>> & { location: WorkspaceLocation; folderName: string }

/** Owner-gated discovery. Refresh reads cached metadata, never starts an import. */
export function useAmbientImportOffers(projectId: string) {
  const [state, setState] = useState<{ projectId: string; offers: Offer[] }>({ projectId, offers: [] })
  const generation = useRef(0)
  const activeProject = useRef(projectId)
  activeProject.current = projectId
  const load = useCallback(async () => {
    if (activeProject.current !== projectId) return
    const request = ++generation.current
    try {
      const folders = await projectFoldersApi.list(projectId)
      const groups = await Promise.all(folders.items.map(async folder => {
        const locations = await projectFoldersApi.locations(projectId, folder.id).catch(() => [])
        return Promise.all(locations.filter(location => location.execution_host_kind === 'remote').map(async location => {
          // A refusal removes the old result too; never retain a colleague's history metadata.
          const offer = await ambientSessionsApi.offer(location.id).catch(() => null)
          return offer ? { ...offer, location, folderName: folder.name } : null
        }))
      }))
      if (request === generation.current) setState({ projectId, offers: groups.flat().filter((offer): offer is Offer => offer !== null) })
    } catch {
      if (request === generation.current) setState({ projectId, offers: [] })
    }
  }, [projectId])
  useEffect(() => {
    void load()
    const refresh = () => { if (document.visibilityState === 'visible') void load() }
    const timer = window.setInterval(refresh, 60_000)
    window.addEventListener('focus', refresh)
    return () => { generation.current++; window.clearInterval(timer); window.removeEventListener('focus', refresh) }
  }, [load])
  return { offers: state.projectId === projectId ? state.offers : [], reload: load }
}
