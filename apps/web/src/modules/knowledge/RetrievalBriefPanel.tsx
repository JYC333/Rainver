import { useState } from 'react'
import { Loader2, Save, Search } from 'lucide-react'
import { toast } from 'sonner'
import { knowledgeApi, memoryApi, projectsApi } from '../../api/client'
import { SpaceLink as Link } from '../../core/spaceNav'
import { errMsg } from '../../lib/utils'
import type {
  RetrievalBriefResponse,
  RetrievalObjectType,
  RetrievalSearchMode,
  RetrievalSearchResult,
} from '../../types/api'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Card, CardTitle } from '../../components/ui/card'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { Select } from '../../components/ui/select'

type BriefDomain = 'knowledge' | 'memory' | 'project_public_summary'

const DOMAIN_OPTIONS: Array<{ value: BriefDomain; label: string; objectTypes: RetrievalObjectType[] }> = [
  { value: 'knowledge', label: 'Knowledge', objectTypes: ['knowledge_item', 'note', 'source'] },
  { value: 'memory', label: 'Memory', objectTypes: ['memory_entry'] },
  { value: 'project_public_summary', label: 'Project public summaries', objectTypes: ['project_public_summary'] },
]

const MODE_OPTIONS: Array<{ value: RetrievalSearchMode; label: string }> = [
  { value: 'hybrid', label: 'hybrid' },
  { value: 'hybrid_rerank', label: 'hybrid_rerank' },
  { value: 'lexical', label: 'lexical' },
  { value: 'exact', label: 'exact' },
]

export default function RetrievalBriefPanel({ hasOperationalSpace }: { hasOperationalSpace: boolean }) {
  const [domain, setDomain] = useState<BriefDomain>('knowledge')
  const [query, setQuery] = useState('')
  const [maxResults, setMaxResults] = useState('8')
  const [mode, setMode] = useState<RetrievalSearchMode>('hybrid')
  const [persistArtifact, setPersistArtifact] = useState(true)
  const [loading, setLoading] = useState(false)
  const [response, setResponse] = useState<RetrievalBriefResponse | null>(null)

  async function runBrief(event: React.FormEvent) {
    event.preventDefault()
    const trimmed = query.trim()
    if (!hasOperationalSpace) {
      toast.error('Select an operational space first')
      return
    }
    if (!trimmed) {
      toast.error('Enter a query')
      return
    }
    setLoading(true)
    try {
      const selected = DOMAIN_OPTIONS.find(option => option.value === domain) ?? DOMAIN_OPTIONS[0]
      const limit = Number(maxResults)
      const body = {
        query: trimmed,
        object_types: selected.objectTypes,
        max_results: Number.isFinite(limit) && limit > 0 ? limit : 8,
        mode,
        persist_artifact: persistArtifact,
      }
      const next =
        domain === 'memory'
          ? await memoryApi.retrievalBrief(body)
          : domain === 'project_public_summary'
            ? await projectsApi.publicSummaryBrief(body)
            : await knowledgeApi.brief(body)
      setResponse(next)
      if (next.artifact_id) toast.success('Context Brief saved')
      else toast.success('Context Brief generated')
      if (next.artifact_error) toast.error(next.artifact_error)
    } catch (error) {
      toast.error(errMsg(error))
      setResponse(null)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card className="space-y-4">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle>Context Brief</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Query governed retrieval, synthesize a cited brief, and optionally save it as a private artifact.
          </p>
        </div>
        {response?.artifact_id && (
          <Button size="sm" variant="outline" asChild>
            <Link to={`/artifacts/${response.artifact_id}`}>Open artifact</Link>
          </Button>
        )}
      </div>

      <form className="space-y-3" onSubmit={runBrief}>
        <div className="grid gap-3 lg:grid-cols-[1fr_190px_150px_120px]">
          <div className="space-y-1.5">
            <Label>Query</Label>
            <Input value={query} onChange={event => setQuery(event.target.value)} placeholder="What do we know about..." />
          </div>
          <div className="space-y-1.5">
            <Label>Domain</Label>
            <Select
              value={domain}
              onChange={value => setDomain(value as BriefDomain)}
              options={DOMAIN_OPTIONS.map(option => ({ value: option.value, label: option.label }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Mode</Label>
            <Select
              value={mode}
              onChange={value => setMode(value as RetrievalSearchMode)}
              options={MODE_OPTIONS}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Max</Label>
            <Input value={maxResults} onChange={event => setMaxResults(event.target.value)} inputMode="numeric" />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={persistArtifact}
              onChange={event => setPersistArtifact(event.target.checked)}
            />
            Save private artifact
          </label>
          <Button size="sm" disabled={loading || !hasOperationalSpace}>
            {loading ? <Loader2 className="size-3.5 animate-spin" /> : persistArtifact ? <Save className="size-3.5" /> : <Search className="size-3.5" />}
            Run brief
          </Button>
        </div>
      </form>

      {response && <BriefResult response={response} />}
    </Card>
  )
}

function BriefResult({ response }: { response: RetrievalBriefResponse }) {
  const gap = response.brief.gap_analysis
  const gapCount =
    gap.stale.length +
    gap.thin.length +
    gap.uncited_claims.length +
    gap.contradictions.length +
    gap.missing_topics.length +
    (gap.low_coverage ? 1 : 0)

  return (
    <div className="space-y-4 border-t border-border pt-4">
      <div className="flex flex-wrap gap-1.5">
        <Badge variant={response.brief.synthesized ? 'success' : 'muted'}>
          {response.brief.synthesized ? 'synthesized' : 'deterministic'}
        </Badge>
        <Badge variant="secondary">{response.items.length} sources</Badge>
        {gapCount > 0 && <Badge variant="warning">{gapCount} gap signals</Badge>}
      </div>
      <div className="rounded-md border border-border p-3">
        <div className="text-[11px] font-medium uppercase text-muted-foreground mb-1">Answer</div>
        {response.brief.answer ? (
          <p className="text-sm whitespace-pre-wrap">{response.brief.answer}</p>
        ) : (
          <p className="text-sm text-muted-foreground">No synthesized answer. The brief still returned visible sources and deterministic gap signals.</p>
        )}
      </div>
      {response.brief.citations.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[11px] font-medium uppercase text-muted-foreground">Citations</div>
          {response.brief.citations.map((citation, index) => (
            <div key={`${citation.object_id}-${index}`} className="rounded-md border border-border px-3 py-2 text-sm">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="outline">[{index + 1}]</Badge>
                <Badge variant="muted">{citation.object_type}</Badge>
                {citation.object_profile_label && <Badge variant="secondary">{citation.object_profile_label}</Badge>}
                <span>{citation.title}</span>
              </div>
            </div>
          ))}
        </div>
      )}
      <SourceList items={response.items} />
      {gapCount > 0 && (
        <div className="rounded-md border border-border p-3 text-xs text-muted-foreground">
          Gap signals: {[
            gap.low_coverage ? 'low coverage' : null,
            gap.stale.length ? `${gap.stale.length} stale` : null,
            gap.thin.length ? `${gap.thin.length} thin` : null,
            gap.uncited_claims.length ? `${gap.uncited_claims.length} uncited claims` : null,
            gap.contradictions.length ? `${gap.contradictions.length} contradictions` : null,
            gap.missing_topics.length ? `${gap.missing_topics.length} missing topics` : null,
          ].filter(Boolean).join(', ')}
        </div>
      )}
    </div>
  )
}

function SourceList({ items }: { items: RetrievalSearchResult[] }) {
  if (items.length === 0) return null
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] font-medium uppercase text-muted-foreground">Sources</div>
      <div className="space-y-1.5">
        {items.map(item => (
          <div key={`${item.object_type}:${item.object_id}`} className="rounded-md border border-border px-3 py-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="muted">{item.object_type}</Badge>
              {item.object_profile_label && <Badge variant="secondary">{item.object_profile_label}</Badge>}
              <span className="text-sm font-medium">{item.title}</span>
              <span className="text-xs font-mono text-muted-foreground">{item.score.toFixed(3)}</span>
            </div>
            {item.snippet && <p className="mt-1 text-xs text-muted-foreground line-clamp-2">{item.snippet}</p>}
          </div>
        ))}
      </div>
    </div>
  )
}
