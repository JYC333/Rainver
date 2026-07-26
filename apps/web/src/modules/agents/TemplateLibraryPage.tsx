import { useEffect, useState } from 'react'
import { SpaceLink as Link } from '../../core/spaceNav'
import { LayoutTemplate, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { agentTemplatesApi } from '../../api/client'
import type { AgentTemplateOut, AgentTemplateVersionOut } from '../../types/api'
import { useSpace } from '../../contexts/SpaceContext'
import { Button } from '../../components/ui/button'
import { Card, CardTitle } from '../../components/ui/card'
import { Badge } from '../../components/ui/badge'
import { EmptyState } from '../../components/ui/empty-state'
import { errMsg } from '../../lib/utils'
import { inputCards, outputCards, safetySummary } from './policyMap'

const SCOPE_LABEL: Record<string, string> = { system: 'System', space: 'Space', user: 'Mine' }

function summarize(version: AgentTemplateVersionOut | undefined) {
  if (!version) return null
  const inputs = inputCards(version).filter(c => c.enabled).map(c => c.label)
  const outputs = outputCards(version).map(c => c.label)
  const safety = safetySummary(version)
  return { inputs, outputs, safety }
}

export default function TemplateLibraryPage() {
  const { activeSpaceId, activeSpaceName } = useSpace()
  const [templates, setTemplates] = useState<AgentTemplateOut[]>([])
  const [versions, setVersions] = useState<Record<string, AgentTemplateVersionOut>>({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!activeSpaceId) { setTemplates([]); setLoading(false); return }
    setLoading(true)
    agentTemplatesApi.list({ status: 'published' })
      .then(async list => {
        setTemplates(list)
        // Fetch current version config per template for the card summaries (bounded N).
        const pairs = await Promise.all(
          list.filter(t => t.current_version_id).map(async t => {
            try {
              const v = await agentTemplatesApi.getVersion(t.id, t.current_version_id as string)
              return [t.id, v] as const
            } catch { return null }
          }),
        )
        setVersions(Object.fromEntries(pairs.filter(Boolean) as (readonly [string, AgentTemplateVersionOut])[]))
      })
      .catch(err => toast.error(errMsg(err)))
      .finally(() => setLoading(false))
  }, [activeSpaceId])

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <div className="flex items-center justify-between gap-4 pb-4 border-b border-border">
        <div className="flex items-center gap-4">
          <div className="w-11 h-11 rounded-xl flex items-center justify-center" style={{ background: 'color-mix(in oklch, var(--primary) 12%, transparent)' }}>
            <LayoutTemplate className="size-5" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">Agent templates</h1>
            <p className="text-sm text-muted-foreground">Reusable factories · {activeSpaceName ?? 'No space'}</p>
          </div>
        </div>
        <Button asChild size="sm" variant="outline"><Link to="/agents">View agents</Link></Button>
      </div>

      <p className="text-sm text-muted-foreground rounded-lg border border-border bg-muted/30 px-4 py-3">
        Add agents to a Project Room to converse or dispatch work.
        Templates are factories for specialized agents (reflection, knowledge, review, …).
      </p>

      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading…</div>
      ) : templates.length === 0 ? (
        <Card><EmptyState title="No templates available" description="System templates seed on startup. Check back once the backend has seeded them." /></Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {templates.map(t => {
            const s = summarize(versions[t.id])
            return (
              <Card key={t.id} className="flex flex-col">
                <div className="flex items-start justify-between gap-3">
                  <CardTitle>{t.name}</CardTitle>
                </div>
                <p className="text-sm text-muted-foreground mt-1 min-h-[2.5rem]">{t.description ?? 'No description'}</p>
                <div className="flex flex-wrap gap-1.5 mt-3">
                  {t.category && <Badge variant="secondary">{t.category}</Badge>}
                  <Badge variant="outline">{SCOPE_LABEL[t.scope] ?? t.scope}</Badge>
                  <Badge variant="muted">{t.visibility}</Badge>
                  <Badge variant={t.status === 'published' ? 'success' : 'muted'}>{t.status}</Badge>
                  {versions[t.id] && <Badge variant="outline">{versions[t.id].version}</Badge>}
                </div>
                {s && (
                  <div className="mt-3 space-y-1.5 text-xs text-muted-foreground">
                    <p><span className="text-foreground font-medium">Inputs:</span> {s.inputs.length ? s.inputs.join(', ') : 'None'}</p>
                    <p><span className="text-foreground font-medium">Can create:</span> {s.outputs.length ? s.outputs.join(', ') : 'None'}</p>
                    <p><span className="text-foreground font-medium">Review &amp; safety:</span> {s.safety.posture} · {s.safety.cannot.length} restrictions</p>
                  </div>
                )}
                <div className="flex gap-2 mt-4 pt-3 border-t border-border">
                  <Button asChild size="sm"><Link to={`/agents/templates/${t.id}/use`}>Use template</Link></Button>
                  <Button asChild size="sm" variant="outline"><Link to={`/agents/templates/${t.id}`}>View details</Link></Button>
                </div>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
