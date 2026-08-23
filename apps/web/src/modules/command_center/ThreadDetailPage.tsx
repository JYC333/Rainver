import { useCallback, useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { SpaceLink as Link } from '../../core/spaceNav'
import { hostsApi, projectFoldersApi, runsApi } from '../../api/client'
import { errMsg } from '../../lib/utils'
import type { Host, HostTaskThread, ProjectFolder, Run } from '../../types/api'
import { Badge } from '../../components/ui/badge'
import { Card } from '../../components/ui/card'
import { Skeleton } from '../../components/ui/skeleton'
import ThreadConversation from './ThreadConversation'
import DispatchComposer from './DispatchComposer'

export default function ThreadDetailPage() {
  const { threadId } = useParams<{ threadId: string }>()
  const [searchParams] = useSearchParams()
  const projectId = searchParams.get('project_id') ?? ''
  const folderId = searchParams.get('folder_id') ?? ''

  const [thread, setThread] = useState<HostTaskThread | null>(null)
  const [host, setHost] = useState<Host | null>(null)
  const [folder, setFolder] = useState<ProjectFolder | null>(null)
  const [runs, setRuns] = useState<Run[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!threadId || !projectId) {
      setLoading(false)
      return
    }
    try {
      const [threadsResult, hostsResult, folderResult, runList] = await Promise.all([
        hostsApi.listThreads(projectId),
        hostsApi.list(),
        folderId ? projectFoldersApi.get(projectId, folderId) : Promise.resolve(null),
        runsApi.list({ project_id: projectId, limit: 200 }),
      ])
      const found = threadsResult.items.find(t => t.id === threadId) ?? null
      setThread(found)
      setHost(found ? hostsResult.items.find(h => h.id === found.host_id) ?? null : null)
      setFolder(folderResult)
      setRuns(
        runList
          .filter(run => run.host_task_thread_id === threadId)
          .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()),
      )
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setLoading(false)
    }
  }, [threadId, projectId, folderId])

  useEffect(() => { void load() }, [load])

  if (loading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }

  if (!thread) {
    return (
      <div className="p-6">
        <p className="text-sm text-muted-foreground">
          Thread not found. <Link to="/command-center" className="text-accent-foreground hover:underline">Back to Command Center</Link>
        </p>
      </div>
    )
  }

  return (
    <div className="p-6 h-[calc(100vh-10rem)] min-h-[500px] flex flex-col">
      <div className="shrink-0 flex items-center gap-3 pb-4">
        <Link to="/command-center" className="text-sm text-accent-foreground hover:underline">← Command Center</Link>
      </div>

      <Card className="flex-1 min-h-0 flex flex-col overflow-hidden">
        <div className="shrink-0 border-b border-border px-4 py-3 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={host?.status === 'online' ? 'success' : 'muted'}>{host?.name ?? 'Unknown host'}</Badge>
            <span className="text-sm text-muted-foreground">{folder?.name ?? thread.project_folder_id}</span>
            {thread.status === 'session_reset' && <Badge variant="warning">session reset</Badge>}
          </div>
          {thread.vendor_session_id && (
            <p className="text-xs text-muted-foreground">
              Remote Claude session: <span className="font-mono select-all text-foreground">{thread.vendor_session_id}</span>
            </p>
          )}
        </div>

        <div className="flex-1 min-h-0">
          <ThreadConversation thread={thread} runs={runs} onThreadChanged={load} />
        </div>

        <div className="shrink-0 border-t border-border p-3">
          <DispatchComposer
            initialProjectId={projectId}
            fixedThreadId={thread.id}
            fixedFolderId={thread.project_folder_id}
            fixedAdapterType={thread.adapter_type}
            onDispatched={() => { void load() }}
          />
        </div>
      </Card>
    </div>
  )
}
