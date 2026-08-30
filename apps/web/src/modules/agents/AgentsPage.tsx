import { useEffect, useState } from 'react'
import { SpaceLink as Link } from '../../core/spaceNav'
import { Bot, Loader2, Plus, LayoutTemplate } from 'lucide-react'
import { toast } from 'sonner'
import { agentsApi, hostsApi } from '../../api/client'
import type { AgentOut, Host } from '../../types/api'
import { useSpace } from '../../contexts/SpaceContext'
import { Button } from '../../components/ui/button'
import { Card, CardTitle } from '../../components/ui/card'
import { Badge, StatusBadge } from '../../components/ui/badge'
import { errMsg } from '../../lib/utils'

export default function AgentsPage() {
  const { activeSpaceId, activeSpaceName } = useSpace()
  const [agents, setAgents] = useState<AgentOut[]>([])
  const [loading, setLoading] = useState(true)
  const [hostBindings, setHostBindings] = useState<Record<string, { name: string; mode: 'location' | 'managed' }>>({})

  useEffect(() => {
    if (!activeSpaceId) {
      setAgents([])
      setLoading(false)
      return
    }
    setLoading(true)
    agentsApi.list({ status: 'active,disabled,inactive' })
      // The retired hardcoded Assistant is not a selectable Room participant.
      .then(async list => {
        const visible = list.filter(a => a.agent_kind !== 'system_assistant')
        setAgents(visible)
        const [hostResponse, profiles] = await Promise.all([
          typeof hostsApi?.list === 'function'
            ? hostsApi.list().catch(() => ({ items: [] as Host[] }))
            : Promise.resolve({ items: [] as Host[] }),
          Promise.all(visible.map(agent => agentsApi.listRuntimeProfiles(agent.id).catch(() => []))),
        ])
        const byId: Record<string, { name: string; mode: 'location' | 'managed' }> = {}
        visible.forEach((agent, index) => {
          const profile = profiles[index]?.find(item => item.is_default && item.execution_host_id)
            ?? profiles[index]?.find(item => item.execution_host_id)
          if (!profile?.execution_host_id) return
          byId[agent.id] = {
            name: hostResponse.items.find(host => host.id === profile.execution_host_id)?.name ?? profile.execution_host_id,
            mode: profile.workspace_mode === 'managed' ? 'managed' : 'location',
          }
        })
        setHostBindings(byId)
      })
      .catch(err => toast.error(errMsg(err)))
      .finally(() => setLoading(false))
  }, [activeSpaceId])

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      <div className="flex items-center justify-between gap-4 pb-4 border-b border-border">
        <div className="flex items-center gap-4">
          <div className="w-11 h-11 rounded-xl flex items-center justify-center" style={{ background: 'color-mix(in oklch, var(--primary) 12%, transparent)' }}>
            <Bot className="size-5" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">Agents</h1>
            <p className="text-sm text-muted-foreground">Viewing: {activeSpaceName ?? 'No space'}</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button asChild size="sm" variant="outline" disabled={!activeSpaceId}>
            <Link to="/agents/templates"><LayoutTemplate className="size-3.5 mr-1" />Templates</Link>
          </Button>
          <Button asChild size="sm" disabled={!activeSpaceId}>
            <Link to="/agents/new"><Plus className="size-3.5 mr-1" />New agent</Link>
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading…</div>
      ) : agents.length === 0 ? (
        <Card><p className="text-sm text-muted-foreground p-4">No agents yet. Create one to configure model and runtime defaults.</p></Card>
      ) : (
        <div className="space-y-3">
          {agents.map(a => (
            <Link key={a.id} to={`/agents/${a.id}`} className="block">
              <Card className={`hover:bg-accent/40 transition-colors ${a.status !== 'active' ? 'opacity-70' : ''}`}>
                <CardTitle className="flex items-center gap-2">
                  {a.name}
                  {a.status !== 'active' && <StatusBadge status={a.status} />}
                  {hostBindings[a.id] && <Badge variant="secondary">on {hostBindings[a.id].name} · {hostBindings[a.id].mode}</Badge>}
                </CardTitle>
                <p className="text-sm text-muted-foreground mt-1">{a.description ?? 'No description'}</p>
                {a.model?.provider_name ? (
                  <p className="text-xs font-mono mt-2">{a.model.provider_name} · {a.model.model ?? 'default model'}</p>
                ) : (
                  <p className="text-xs text-muted-foreground mt-2">Uses system default model</p>
                )}
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
