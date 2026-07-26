import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { agentsApi, plansApi } from '../../api/client'
import type { AgentOut, AgentRuntimeProfileOut, PlanExecuteBody } from '../../types/api'
import { Button } from '../../components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { Label } from '../../components/ui/label'
import { Select } from '../../components/ui/select'
import { Textarea } from '../../components/ui/textarea'
import { errMsg } from '../../lib/utils'

interface PlanExecuteDialogProps {
  open: boolean
  planId: string
  onOpenChange: (open: boolean) => void
  onExecuted: () => Promise<void>
}

export default function PlanExecuteDialog({ open, planId, onOpenChange, onExecuted }: PlanExecuteDialogProps) {
  const [agents, setAgents] = useState<AgentOut[]>([])
  const [agentId, setAgentId] = useState('')
  const [runtimeProfiles, setRuntimeProfiles] = useState<AgentRuntimeProfileOut[]>([])
  const [runtimeProfileId, setRuntimeProfileId] = useState('')
  const [prompt, setPrompt] = useState('')
  const [instruction, setInstruction] = useState('')
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    setRuntimeProfileId('')
    if (!agentId) {
      setRuntimeProfiles([])
      return
    }
    agentsApi.listRuntimeProfiles(agentId)
      .then(rows => setRuntimeProfiles(rows.filter(row => row.enabled)))
      .catch(error => {
        setRuntimeProfiles([])
        toast.error(errMsg(error))
      })
  }, [agentId])

  async function loadAgents() {
    if (loaded) return
    try {
      setAgents(await agentsApi.list({ limit: '100' }))
      setLoaded(true)
    } catch (error) {
      toast.error(errMsg(error))
    }
  }

  async function submit() {
    if (!agentId) {
      toast.error('Choose an agent')
      return
    }
    setBusy(true)
    try {
      const body: PlanExecuteBody = {
        agent_id: agentId,
        runtime_profile_id: runtimeProfileId || undefined,
        prompt: prompt.trim() || undefined,
        instruction: instruction.trim() || undefined,
      }
      await plansApi.execute(planId, body)
      toast.success('Plan execution queued')
      onOpenChange(false)
      await onExecuted()
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={value => { onOpenChange(value); if (value) void loadAgents() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Execute plan</DialogTitle>
          <DialogDescription>Execution creates the server-owned coordinator and ready child runs.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5"><Label>Agent</Label><Select value={agentId} onChange={setAgentId} options={[{ value: '', label: 'Select agent…' }, ...agents.map(agent => ({ value: agent.id, label: agent.name }))]} /></div>
          <div className="space-y-1.5"><Label>Runtime profile (optional)</Label><Select value={runtimeProfileId} onChange={setRuntimeProfileId} disabled={!agentId} options={[{ value: '', label: agentId ? 'Use the Agent default' : 'Select an Agent first' }, ...runtimeProfiles.map(profile => ({ value: profile.id, label: `${profile.name}${profile.is_default ? ' · default' : ''}` }))]} /></div>
          <div className="space-y-1.5"><Label>Prompt (optional)</Label><Textarea value={prompt} onChange={event => setPrompt(event.target.value)} /></div>
          <div className="space-y-1.5"><Label>Instruction (optional)</Label><Textarea value={instruction} onChange={event => setInstruction(event.target.value)} /></div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={busy}>{busy && <Loader2 className="size-3.5 animate-spin" />} Execute</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
