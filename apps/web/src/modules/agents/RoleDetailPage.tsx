import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { SpaceLink as Link } from '../../core/spaceNav'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { agentRolesApi } from '../../api/client'
import type { AgentRoleOut, AgentRoleVersionOut } from '../../types/api'
import { Button } from '../../components/ui/button'
import { Card, CardTitle } from '../../components/ui/card'
import { Badge } from '../../components/ui/badge'
import { errMsg } from '../../lib/utils'
import { InputsView, OutputsView, ScheduleView, SafetyView } from './ConfigCards'
import { outputTypeLabel } from './policyMap'

export default function RoleDetailPage() {
  const { roleId } = useParams()
  const [role, setRole] = useState<AgentRoleOut | null>(null)
  const [versions, setVersions] = useState<AgentRoleVersionOut[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!roleId) return
    setLoading(true)
    Promise.all([agentRolesApi.get(roleId), agentRolesApi.listVersions(roleId)])
      .then(([t, vs]) => { setRole(t); setVersions(vs) })
      .catch(err => toast.error(errMsg(err)))
      .finally(() => setLoading(false))
  }, [roleId])

  if (loading) return <div className="p-6 flex items-center gap-2 text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading…</div>
  if (!role) return <div className="p-6 text-muted-foreground">Role not found.</div>

  const current = versions.find(v => v.id === role.current_version_id) ?? versions[0]

  const out = (current?.output_policy_json ?? {}) as Record<string, unknown>
  const classification = out.classification_mode === 'model_selects'
  const multiRun = out.allow_multiple_outputs_per_run === true
  const required = Array.isArray(out.required_run_outputs) ? (out.required_run_outputs as string[]) : []

  const CALLOUT: Record<string, string> = {
    activity_reflector: 'Processes raw captures / activity records into typed proposals and a reflection summary. The model classifies each activity into a primary output type.',
  }

  return (
    <div className="p-6 max-w-3xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">{role.name}</h1>
          <p className="text-sm text-muted-foreground">{role.description ?? 'No description'}</p>
          <div className="flex flex-wrap gap-1.5 mt-2">
            {role.category && <Badge variant="secondary">{role.category}</Badge>}
            <Badge variant="outline">{role.scope}</Badge>
            <Badge variant="muted">{role.visibility}</Badge>
            <Badge variant={role.status === 'published' ? 'success' : 'muted'}>{role.status}</Badge>
            {current && <Badge variant="outline">{current.version}</Badge>}
          </div>
        </div>
        <Button asChild size="sm"><Link to={`/agents/roles/${role.id}/use`}>Create agent</Link></Button>
      </div>

      {CALLOUT[role.key] && (
        <Card><p className="text-sm">{CALLOUT[role.key]}</p></Card>
      )}

      {!current ? (
        <Card><p className="text-sm text-muted-foreground p-4">This role has no published version yet.</p></Card>
      ) : (
        <>
          <Card className="space-y-4">
            <CardTitle className="mb-1">Purpose</CardTitle>
            <p className="text-sm text-muted-foreground">{role.description ?? 'No description'}</p>
          </Card>
          <Card className="space-y-4"><InputsView version={current} /></Card>
          <Card className="space-y-2">
            <OutputsView version={current} />
            <div className="border-t border-border pt-3 text-xs text-muted-foreground space-y-1">
              <p><span className="text-foreground font-medium">Output selection:</span> {classification ? 'the model selects which output type(s) to emit inside the allowed set' : 'fixed outputs'}{multiRun ? '; a run may produce multiple outputs' : ''}.</p>
              {required.length > 0 && (
                <p><span className="text-foreground font-medium">Required per run:</span> {required.map(r => outputTypeLabel(r)).join(', ')}.</p>
              )}
            </div>
          </Card>
          <Card><ScheduleView version={current} /></Card>
          <Card>
            <CardTitle className="mb-2">Runtime Profile</CardTitle>
            <p className="text-sm text-muted-foreground">New Agents use the Space&apos;s explicit provisioning default, or Server Runtime OpenCode with its native account when no override is configured.</p>
          </Card>
          <Card><SafetyView version={current} /></Card>
        </>
      )}
    </div>
  )
}
