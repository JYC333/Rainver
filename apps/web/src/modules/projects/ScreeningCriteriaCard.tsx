import { useEffect, useState } from 'react'
import { SlidersHorizontal } from 'lucide-react'
import { toast } from 'sonner'
import { projectResearchApi } from '../../api/client'
import type { ProjectResearchScreeningCriteria } from '../../types/api'
import { errMsg } from '../../lib/utils'
import { Button } from '../../components/ui/button'
import { Card } from '../../components/ui/card'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'

function csv(values: string[]): string {
  return values.join(', ')
}

function values(text: string): string[] {
  return [...new Set(text.split(',').map(value => value.trim()).filter(Boolean))]
}

function empty(projectId: string): ProjectResearchScreeningCriteria {
  return {
    id: null,
    project_id: projectId,
    include_keywords: [],
    exclude_keywords: [],
    domain_criteria: {},
    available_domain_criteria: [],
    date_range_start: null,
    date_range_end: null,
    source_restrictions: [],
    required_evidence_fields: [],
    created_at: null,
    updated_at: null,
  }
}

export function ScreeningCriteriaCard({ projectId }: { projectId: string }) {
  const [criteria, setCriteria] = useState<ProjectResearchScreeningCriteria>(() => empty(projectId))
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let current = true
    setLoading(true)
    projectResearchApi.screeningCriteria(projectId)
      .then(result => { if (current) setCriteria(result) })
      .catch(error => { if (current) toast.error(errMsg(error)) })
      .finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [projectId])

  function setList(field: 'include_keywords' | 'exclude_keywords' | 'source_restrictions' | 'required_evidence_fields', text: string) {
    setCriteria(current => ({ ...current, [field]: values(text) }))
  }

  function setDomain(key: string, text: string) {
    setCriteria(current => ({
      ...current,
      domain_criteria: { ...current.domain_criteria, [key]: values(text) },
    }))
  }

  async function save() {
    setSaving(true)
    try {
      const saved = await projectResearchApi.upsertScreeningCriteria(projectId, {
        include_keywords: criteria.include_keywords,
        exclude_keywords: criteria.exclude_keywords,
        domain_criteria: Object.fromEntries(
          criteria.available_domain_criteria.map(key => [key, criteria.domain_criteria[key] ?? []]),
        ),
        date_range_start: criteria.date_range_start,
        date_range_end: criteria.date_range_end,
        source_restrictions: criteria.source_restrictions,
        required_evidence_fields: criteria.required_evidence_fields,
      })
      setCriteria(saved)
      toast.success('Screening criteria saved')
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card className="p-4">
      <details>
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
          <span className="flex items-center gap-2 text-sm font-medium">
            <SlidersHorizontal className="size-4 text-muted-foreground" />
            Screening criteria
          </span>
          <span className="text-xs text-muted-foreground">{loading ? 'Loading…' : 'Applied to automated screening'}</span>
        </summary>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="screening-include">Include keywords or concepts</Label>
            <Input
              id="screening-include"
              value={csv(criteria.include_keywords)}
              onChange={event => setList('include_keywords', event.target.value)}
              placeholder="agent memory, retrieval evaluation"
              disabled={loading}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="screening-exclude">Exclude keywords or concepts</Label>
            <Input
              id="screening-exclude"
              value={csv(criteria.exclude_keywords)}
              onChange={event => setList('exclude_keywords', event.target.value)}
              placeholder="survey, editorial"
              disabled={loading}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="screening-sources">Allowed journals, outlets, or sites</Label>
            <Input
              id="screening-sources"
              value={csv(criteria.source_restrictions)}
              onChange={event => setList('source_restrictions', event.target.value)}
              placeholder="arxiv.org, Nature"
              disabled={loading}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="screening-evidence">Required evidence fields</Label>
            <Input
              id="screening-evidence"
              value={csv(criteria.required_evidence_fields)}
              onChange={event => setList('required_evidence_fields', event.target.value)}
              placeholder="sample size, limitations"
              disabled={loading}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="screening-start">Published from</Label>
            <Input
              id="screening-start"
              type="date"
              value={criteria.date_range_start?.slice(0, 10) ?? ''}
              onChange={event => setCriteria(current => ({ ...current, date_range_start: event.target.value || null }))}
              disabled={loading}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="screening-end">Published through</Label>
            <Input
              id="screening-end"
              type="date"
              value={criteria.date_range_end?.slice(0, 10) ?? ''}
              onChange={event => setCriteria(current => ({ ...current, date_range_end: event.target.value || null }))}
              disabled={loading}
            />
          </div>
          {criteria.available_domain_criteria.map(key => (
            <div key={key} className="space-y-1.5 md:col-span-2">
              <Label htmlFor={`screening-domain-${key}`}>{key === 'methods' ? 'Methods' : key.replace(/_/g, ' ')}</Label>
              <Input
                id={`screening-domain-${key}`}
                value={csv(criteria.domain_criteria[key] ?? [])}
                onChange={event => setDomain(key, event.target.value)}
                placeholder={key === 'methods' ? 'randomized, observational' : 'Comma-separated values'}
                disabled={loading}
              />
            </div>
          ))}
        </div>
        <div className="mt-4 flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            Domain-specific fields appear only when an active source profile declares them.
          </p>
          <Button size="sm" onClick={() => void save()} disabled={loading || saving}>
            {saving ? 'Saving…' : 'Save criteria'}
          </Button>
        </div>
      </details>
    </Card>
  )
}
