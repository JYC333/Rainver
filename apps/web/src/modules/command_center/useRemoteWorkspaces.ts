import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { hostsApi, projectFoldersApi } from '../../api/client'
import { errMsg } from '../../lib/utils'
import type { Host, ProjectFolder, WorkspaceLocation } from '../../types/api'

export interface RemoteWorkspace {
  folder: ProjectFolder
  location: WorkspaceLocation
  host: Host | null
}

const REFRESH_INTERVAL_MS = 3_000

/**
 * Every remote WorkspaceLocation in a Project, joined with its logical Folder
 * and ExecutionHost. A logical Folder can therefore appear more than once.
 *
 * Refreshes every 3s in the background (matching HostsPanel's own cadence)
 * so a workspace's joined host status — the exact fact `DispatchComposer`
 * gates dispatch eligibility on — doesn't go stale while a message is being
 * composed.
 */
export function useRemoteWorkspaces(projectId: string): { workspaces: RemoteWorkspace[]; loading: boolean } {
  const [workspaces, setWorkspaces] = useState<RemoteWorkspace[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!projectId) {
      setWorkspaces([])
      setLoading(false)
      return
    }
    let cancelled = false
    const load = (showLoading: boolean) => {
      if (showLoading) setLoading(true)
      return Promise.all([
        projectFoldersApi.list(projectId, { status: 'active', limit: '200' }),
        hostsApi.list(),
      ])
        .then(async ([folderPage, hostsResult]) => {
          if (cancelled) return
          const hostsById = new Map(hostsResult.items.map(host => [host.id, host]))
          const locations = await Promise.all(folderPage.items.map(async folder => ({
            folder,
            locations: await projectFoldersApi.locations(projectId, folder.id),
          })))
          if (cancelled) return
          setWorkspaces(locations.flatMap(({ folder, locations: folderLocations }) =>
            folderLocations
              .filter(location => location.execution_host_kind === 'remote')
              .map(location => ({ folder, location, host: hostsById.get(location.execution_host_id) ?? null })),
          ))
        })
        // Background refreshes should not toast on every transient failure.
        .catch(error => { if (showLoading) toast.error(errMsg(error)) })
        .finally(() => { if (!cancelled && showLoading) setLoading(false) })
    }
    void load(true)
    const timer = window.setInterval(() => { void load(false) }, REFRESH_INTERVAL_MS)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [projectId])

  return { workspaces, loading }
}

const LAST_WORKSPACE_KEY_PREFIX = 'agent-space:command-center:last-workspace:'

export function lastUsedWorkspaceId(projectId: string): string | null {
  try {
    return localStorage.getItem(LAST_WORKSPACE_KEY_PREFIX + projectId)
  } catch {
    return null
  }
}

export function rememberWorkspaceId(projectId: string, locationId: string): void {
  try {
    localStorage.setItem(LAST_WORKSPACE_KEY_PREFIX + projectId, locationId)
  } catch {
    // Best-effort only — a private-browsing session without storage access
    // just loses "last used", never breaks dispatch.
  }
}
