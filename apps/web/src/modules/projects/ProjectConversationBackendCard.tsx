import { useCallback, useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { agentsApi } from '../../api/client'
import type { AgentOut, AgentRuntimeProfileOut } from '../../types/api'
import { Button } from '../../components/ui/button'
import { Label } from '../../components/ui/label'
import { errMsg } from '../../lib/utils'
import HostExecutionTargetPicker, { type HostExecutionSelection } from '../command_center/HostExecutionTargetPicker'
import { ConversationBackendSetupCard } from '../agent_groups/conversation/ConversationBackendSetupCard'

/**
 * Reusable runtime suggestions for the Project's own Assistant instance (the
 * Space `/home` Assistant is a separate row). The default is preselected by a
 * new Conversation when its Host/Workspace target is available; confirmation
 * still owns the immutable Conversation pin.
 */
export default function ProjectConversationBackendCard({ projectId }: { projectId: string }) {
  const [assistant, setAssistant] = useState<AgentOut | null>(null)
  const [profiles, setProfiles] = useState<AgentRuntimeProfileOut[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [hostSelection, setHostSelection] = useState<HostExecutionSelection | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const { assistant: found } = await agentsApi.getSystemAssistant(projectId)
      setAssistant(found)
      setProfiles(found ? await agentsApi.listRuntimeProfiles(found.id) : [])
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => { void reload() }, [reload])

  async function setDefault(profileId: string) {
    if (!assistant) return
    setBusy(true)
    try {
      await agentsApi.updateRuntimeProfile(assistant.id, profileId, { is_default: true })
      await reload()
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  async function addHostBackend() {
    if (!assistant || !hostSelection) return
    setBusy(true)
    try {
      await agentsApi.resolveHostRuntimeProfile(assistant.id, {
        adapter_type: hostSelection.adapter_type,
        execution_host_id: hostSelection.host_id,
        workspace_location_id: hostSelection.workspace_location_id,
        workspace_mode: hostSelection.workspace_mode,
        runtime_installation: hostSelection.installation,
      })
      toast.success('Host backend added')
      setAddOpen(false)
      setHostSelection(null)
      await reload()
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <p className="text-xs text-muted-foreground flex items-center gap-1.5"><Loader2 className="size-3 animate-spin" /> Loading conversation backend…</p>
  if (!assistant) {
    return (
      <div className="space-y-2">
        <div>
          <Label>Runtime &amp; workspace</Label>
          <p className="mt-1 text-xs text-muted-foreground">
            Configure the available runtime suggestions here; each
            Conversation confirms its Host, CLI, and workspace explicitly
            before the first message.
          </p>
        </div>
        <ConversationBackendSetupCard
          mode="prepare"
          setupTargets={['model_providers', 'cli_credentials']}
        />
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div>
        <Label>Runtime &amp; workspace</Label>
        <p className="mt-1 text-xs text-muted-foreground">These profiles are suggestions for new Conversations; initialized Conversations keep their own pins.</p>
      </div>
      <div className="space-y-1">
        {profiles.map(profile => (
          <label key={profile.id} className="flex items-center gap-2 rounded border border-border p-2 text-xs">
            <input
              type="radio"
              name="conversation-backend-default"
              checked={profile.is_default}
              disabled={busy}
              onChange={() => void setDefault(profile.id)}
            />
            <span className="truncate">
              {profile.name}
              <span className="ml-1 text-muted-foreground">
                {profile.execution_host_id
                  ? profile.workspace_mode === 'location'
                    ? `· ${profile.adapter_type} · Project Location${profile.workspace_location_id ? ` ${profile.workspace_location_id}` : ''} · owner-only (others fall back)`
                    : `· ${profile.adapter_type} · isolated managed workspace · owner-only (others fall back)`
                  : `· ${profile.adapter_type}`}
              </span>
            </span>
          </label>
        ))}
        {profiles.length === 0 && <p className="text-xs text-muted-foreground">No runtime profiles yet.</p>}
      </div>
      {!addOpen ? (
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setAddOpen(true)}>
          Add or change Host workspace…
        </Button>
      ) : (
        <div className="space-y-2">
          <HostExecutionTargetPicker projectId={projectId} value={hostSelection} onChange={setHostSelection} disabled={busy} />
          <div className="flex gap-2">
            <Button type="button" size="sm" disabled={busy || !hostSelection} onClick={() => void addHostBackend()}>Add backend</Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => { setAddOpen(false); setHostSelection(null) }}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  )
}
