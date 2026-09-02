import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Server } from 'lucide-react'
import { toast } from 'sonner'
import { useSpace } from '../../contexts/SpaceContext'
import type { Run } from '../../types/api'
import { ProjectSelector } from '../../components/ProjectFolderSelectors'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs'
import DispatchComposer from './DispatchComposer'
import WorkStreamList from './WorkStreamList'
import HostsPanel from './HostsPanel'

export default function CommandCenterPage() {
  const { activeSpaceId, activeSpaceName, preferredSpaceId, spaces } = useSpace()
  const browsingSpaceId = activeSpaceId ?? preferredSpaceId
  const browsingSpaceName = activeSpaceName ?? spaces.find(s => s.id === browsingSpaceId)?.name ?? null

  // C10: the Work Stream's own filter — independent of whatever Project the
  // composer below is currently pointed at. Empty means the cross-project
  // landing view (no pre-selection wall), never a blocker.
  const [filterProjectId, setFilterProjectId] = useState('')
  // Remounting the composer (via `key`) is the cleanest way to push a fresh
  // initial project/workspace/prompt into it from a "dispatch diagnostic
  // run" quick action without turning it into a fully controlled component.
  const [composerSeed, setComposerSeed] = useState({ nonce: 0, projectId: '', folderId: '', prompt: '' })
  const [searchParams, setSearchParams] = useSearchParams()
  const tab = searchParams.get('tab') === 'hosts' ? 'hosts' : 'work-stream'
  const [refreshNonce, setRefreshNonce] = useState(0)

  function diagnose(run: Run, folderId: string | null) {
    const projectId = run.project_id ?? ''
    setFilterProjectId(projectId)
    setComposerSeed(current => ({
      nonce: current.nonce + 1,
      projectId,
      folderId: folderId ?? '',
      prompt: `The previous run in this workspace failed${run.error_message ? `: ${run.error_message}` : '.'}\n\nInvestigate and fix it.`,
    }))
    setSearchParams({}, { replace: true })
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-4 pb-4 border-b border-border">
        <div
          className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
          style={{
            background: 'color-mix(in oklch, var(--primary) 12%, transparent)',
            border: '1px solid color-mix(in oklch, var(--primary) 35%, transparent)',
          }}
        >
          <Server className="size-5 text-accent-foreground" />
        </div>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Command Center</h1>
          <p className="text-sm text-muted-foreground">Dispatch a task to a registered host and review its work.</p>
          <p className="text-xs text-muted-foreground">Viewing: {browsingSpaceName ?? browsingSpaceId ?? 'No operational space selected'}</p>
        </div>
      </div>

      <DispatchComposer
        key={composerSeed.nonce}
        initialProjectId={composerSeed.projectId}
        initialFolderId={composerSeed.folderId}
        initialPrompt={composerSeed.prompt}
        onDispatched={() => {
          toast.success('Dispatched')
          setSearchParams({}, { replace: true })
          setRefreshNonce(n => n + 1)
        }}
      />

      <Tabs
        value={tab}
        onValueChange={next => setSearchParams(next === 'hosts' ? { tab: 'hosts' } : {}, { replace: true })}
      >
        <TabsList>
          <TabsTrigger value="work-stream">Work Stream</TabsTrigger>
          <TabsTrigger value="hosts">Hosts</TabsTrigger>
        </TabsList>
        <TabsContent value="work-stream" className="space-y-3">
          <div className="max-w-xs">
            <ProjectSelector value={filterProjectId} onChange={setFilterProjectId} label="Filter by Project" />
          </div>
          <WorkStreamList key={refreshNonce} projectId={filterProjectId || null} onDiagnose={diagnose} />
        </TabsContent>
        <TabsContent value="hosts">
          <HostsPanel />
        </TabsContent>
      </Tabs>
    </div>
  )
}
