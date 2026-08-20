import { useCallback, useMemo, useState } from 'react'
import {
  AlertTriangle,
  FileText,
  Loader2,
  PackageCheck,
  Send,
  Sparkles,
} from 'lucide-react'
import { toast } from 'sonner'
import { SpaceLink as Link } from '../../core/spaceNav'
import { askSpaceApi, knowledgeApi } from '../../api/client'
import { useSpace } from '../../contexts/SpaceContext'
import { errMsg } from '../../lib/utils'
import type {
  AskSpaceDomain,
  AskSpaceDomainSection,
  AskSpaceFollowUp,
  AskSpaceResponse,
} from '../../types/api'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Card, CardTitle } from '../../components/ui/card'
import { Textarea } from '../../components/ui/textarea'

const DOMAIN_LABELS: Record<AskSpaceDomain, string> = {
  knowledge: 'Knowledge',
  memory: 'Memory',
  project: 'Project summaries',
  source: 'Source',
  inquiry: 'Inquiry',
}

const ALL_DOMAINS: AskSpaceDomain[] = ['knowledge', 'memory', 'project', 'source', 'inquiry']

function GapBadges({ summary }: { summary: AskSpaceResponse['gap_summary'] }) {
  const entries: Array<[string, number]> = [
    ['stale', summary.stale_count],
    ['thin', summary.thin_count],
    ['uncited claims', summary.uncited_claim_count],
    ['contradictions', summary.contradiction_count],
    ['missing topics', summary.missing_topic_count],
  ]
  const active = entries.filter(([, value]) => value > 0)
  if (active.length === 0 && summary.low_coverage_domains.length === 0) {
    return <Badge variant="secondary">No gaps flagged</Badge>
  }
  return (
    <div className="flex flex-wrap gap-2">
      {active.map(([label, value]) => (
        <Badge key={label} variant="outline" className="text-amber-700 dark:text-amber-300">{label}: {value}</Badge>
      ))}
      {summary.low_coverage_domains.map(domain => (
        <Badge key={domain} variant="outline">low coverage: {DOMAIN_LABELS[domain]}</Badge>
      ))}
    </div>
  )
}

function ReviewableGaps({ gap }: { gap: NonNullable<AskSpaceDomainSection['brief']>['gap_analysis'] }) {
  const sourceGaps = [
    ...gap.stale.map(item => ({ ...item, kind: 'stale' })),
    ...gap.thin.map(item => ({ ...item, kind: 'thin' })),
  ]
  const textGaps: Array<[string, string[]]> = [
    ['uncited claims', gap.uncited_claims],
    ['contradictions', gap.contradictions],
    ['missing topics', gap.missing_topics],
  ]
  const hasText = textGaps.some(([, list]) => list.length > 0)
  if (sourceGaps.length === 0 && !hasText && !gap.low_coverage) return null
  return (
    <div className="mt-3 border-t border-border pt-3">
      <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">Reviewable gaps</div>
      {gap.low_coverage && <p className="mb-1 text-xs text-amber-700 dark:text-amber-300">Low coverage — few sources matched this question.</p>}
      {sourceGaps.length > 0 && (
        <ul className="space-y-1 text-xs">
          {sourceGaps.map(item => (
            <li key={`${item.kind}:${item.object_type}:${item.object_id}`} className="flex items-start gap-2">
              <Badge variant="outline" className="text-[10px] text-amber-700 dark:text-amber-300">{item.kind}</Badge>
              <span className="min-w-0"><span className="truncate font-medium">{item.title}</span> — <span className="text-muted-foreground">{item.reason}</span></span>
            </li>
          ))}
        </ul>
      )}
      {hasText && (
        <div className="mt-2 space-y-1">
          {textGaps.filter(([, list]) => list.length > 0).map(([label, list]) => (
            <div key={label} className="text-xs">
              <span className="text-muted-foreground">{label}:</span>
              <ul className="ml-4 list-disc">
                {list.slice(0, 6).map((entry, i) => (<li key={i}>{entry}</li>))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function DomainSection({ section }: { section: AskSpaceDomainSection }) {
  const brief = section.brief
  return (
    <Card className="p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <CardTitle className="text-sm">{DOMAIN_LABELS[section.domain]}</CardTitle>
        <div className="flex items-center gap-1.5">
          <Badge variant="outline">{section.total} source(s)</Badge>
          {brief?.synthesized
            ? <Badge variant="secondary">synthesized</Badge>
            : <Badge variant="outline">deterministic</Badge>}
          {section.artifact_id && (
            <Link to={`/artifacts/${section.artifact_id}`}>
              <Button variant="outline" size="sm"><FileText className="size-3.5" /> Brief</Button>
            </Link>
          )}
        </div>
      </div>
      {section.error_code ? (
        <p className="text-sm text-destructive">This domain could not be answered ({section.error_code}).</p>
      ) : brief?.answer ? (
        <p className="whitespace-pre-wrap text-sm text-foreground">{brief.answer}</p>
      ) : (
        <p className="text-sm text-muted-foreground">
          No synthesized answer (no synthesis provider configured or it degraded). The cited sources below are still ranked and revalidated.
        </p>
      )}
      {brief && brief.citations.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">Citations</div>
          <ol className="space-y-1 text-xs">
            {brief.citations.map((citation, index) => (
              <li key={`${citation.object_type}:${citation.object_id}`} className="flex items-center gap-2">
                <span className="text-muted-foreground">[{index + 1}]</span>
                <span className="truncate">{citation.title}</span>
                <Badge variant="outline" className="text-[10px]">{citation.object_type}</Badge>
              </li>
            ))}
          </ol>
        </div>
      )}
      {brief && <ReviewableGaps gap={brief.gap_analysis} />}
      {section.artifact_error && (
        <p className="mt-2 text-[11px] text-amber-700 dark:text-amber-300">Brief was not saved ({section.artifact_error}).</p>
      )}
    </Card>
  )
}

export default function AskSpacePage() {
  const { activeSpaceId } = useSpace()
  const [query, setQuery] = useState('')
  const [domains, setDomains] = useState<AskSpaceDomain[]>(['knowledge'])
  const [persist, setPersist] = useState(true)
  const [combine, setCombine] = useState(false)
  const [combineIncludeMemory, setCombineIncludeMemory] = useState(false)
  const [includeTrajectory, setIncludeTrajectory] = useState(false)
  const [busy, setBusy] = useState(false)
  const [followUpBusy, setFollowUpBusy] = useState<string | null>(null)
  const [result, setResult] = useState<AskSpaceResponse | null>(null)

  const toggleDomain = useCallback((domain: AskSpaceDomain) => {
    setDomains(prev => (prev.includes(domain) ? prev.filter(d => d !== domain) : [...prev, domain]))
  }, [])

  const ask = useCallback(async () => {
    const trimmed = query.trim()
    if (!trimmed) {
      toast.error('Enter a question to ask the space.')
      return
    }
    if (domains.length === 0) {
      toast.error('Select at least one domain.')
      return
    }
    setBusy(true)
    try {
      // Keep the request domains in canonical order regardless of toggle order.
      const ordered = ALL_DOMAINS.filter(domain => domains.includes(domain))
      setResult(await askSpaceApi.think({
        query: trimmed,
        domains: ordered,
        persist,
        combine,
        combine_include_memory: combine && combineIncludeMemory,
        include_claim_trajectory: includeTrajectory,
      }))
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setBusy(false)
    }
  }, [query, domains, persist, combine, combineIncludeMemory, includeTrajectory])

  const runFollowUp = useCallback(async (followUp: AskSpaceFollowUp) => {
    setFollowUpBusy(followUp.kind)
    try {
      if (followUp.kind === 'claim_candidate_packet') {
        const res = await knowledgeApi.claimCandidatePacket({
          source_artifact_ids: followUp.source_artifact_ids.slice(0, 12),
          review_scope: 'private',
          promote_private_sources_to_space_ops: false,
        })
        toast.success(res.proposal_id ? 'Claim Candidate Packet created.' : 'Claim packet artifact created.')
      } else if (followUp.kind === 'maintenance_scan') {
        const res = await knowledgeApi.maintenanceScan({ persist_report: true, create_packet: true })
        toast.success(res.proposal_id ? 'Maintenance scan complete — review packet created.' : 'Maintenance scan complete.')
      }
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setFollowUpBusy(null)
    }
  }, [])

  const provenanceByDomain = useMemo(() => {
    const grouped = new Map<AskSpaceDomain, AskSpaceResponse['provenance']>()
    for (const item of result?.provenance ?? []) {
      const list = grouped.get(item.domain) ?? []
      list.push(item)
      grouped.set(item.domain, list)
    }
    return grouped
  }, [result])

  return (
    <div className="space-y-5 p-6">
      <div className="flex items-center gap-3 border-b border-border pb-4">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-md border border-border bg-muted">
          <Sparkles className="size-5 text-foreground" />
        </div>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Ask Space</h1>
          <p className="text-xs text-muted-foreground">
            Ask one question; gather a cited, gap-aware answer across your visible Knowledge, Memory, and Project summaries.
          </p>
        </div>
      </div>

      {!activeSpaceId ? (
        <Card className="p-4 text-sm text-muted-foreground">Select a space to ask the space.</Card>
      ) : (
        <>
          <Card className="p-4">
            <Textarea
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="What do you want to know? e.g. What did we decide about credential channel isolation?"
              rows={3}
              onKeyDown={event => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                  event.preventDefault()
                  ask()
                }
              }}
            />
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                {ALL_DOMAINS.map(domain => (
                  <button
                    key={domain}
                    type="button"
                    onClick={() => toggleDomain(domain)}
                    className={`rounded-md border px-2.5 py-1 text-xs ${
                      domains.includes(domain)
                        ? 'border-primary bg-primary/10 text-foreground'
                        : 'border-border text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {DOMAIN_LABELS[domain]}
                  </button>
                ))}
                <label className="ml-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={persist}
                    onChange={event => setPersist(event.target.checked)}
                    className="size-3.5 accent-primary"
                  />
                  Save (enables follow-up packets)
                </label>
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={combine}
                    onChange={event => setCombine(event.target.checked)}
                    className="size-3.5 accent-primary"
                  />
                  Combined answer
                </label>
                <label className={`flex items-center gap-1.5 text-xs ${combine && domains.includes('memory') ? 'text-muted-foreground' : 'text-muted-foreground/60'}`}>
                  <input
                    type="checkbox"
                    checked={combineIncludeMemory}
                    onChange={event => setCombineIncludeMemory(event.target.checked)}
                    disabled={!combine || !domains.includes('memory')}
                    className="size-3.5 accent-primary"
                  />
                  Include Memory in combined answer
                </label>
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={includeTrajectory}
                    onChange={event => setIncludeTrajectory(event.target.checked)}
                    className="size-3.5 accent-primary"
                  />
                  Claim trajectory
                </label>
              </div>
              <Button onClick={ask} disabled={busy || !query.trim()}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                Ask
              </Button>
            </div>
          </Card>

          {result && (
            <div className="space-y-4">
              <Card className="p-4">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Sparkles className="size-4 text-muted-foreground" />
                    <CardTitle className="text-sm">Gaps</CardTitle>
                  </div>
                  {result.session_artifact_id && (
                    <Link to={`/artifacts/${result.session_artifact_id}`}>
                      <Button variant="outline" size="sm"><FileText className="size-3.5" /> Session</Button>
                    </Link>
                  )}
                </div>
                <GapBadges summary={result.gap_summary} />
                {result.session_artifact_error && (
                  <p className="mt-2 text-[11px] text-amber-700 dark:text-amber-300">Session not saved ({result.session_artifact_error}).</p>
                )}
                <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
                  {result.follow_ups.map(followUp => (
                    <Button
                      key={followUp.kind}
                      variant="outline"
                      size="sm"
                      title={followUp.reason}
                      onClick={() => runFollowUp(followUp)}
                      disabled={followUpBusy !== null}
                    >
                      {followUpBusy === followUp.kind
                        ? <Loader2 className="size-3.5 animate-spin" />
                        : followUp.kind === 'claim_candidate_packet'
                        ? <PackageCheck className="size-3.5" />
                        : <AlertTriangle className="size-3.5" />}
                      {followUp.label}
                    </Button>
                  ))}
                  {/* Standing navigation affordance — always available, independent of scan-gated follow-ups. */}
                  <Link to="/proposals"><Button variant="outline" size="sm">Review proposals</Button></Link>
                </div>
              </Card>

              {result.combined_answer && (
                <Card className="p-4">
                  <div className="mb-2 flex items-center gap-2">
                    <Sparkles className="size-4 text-muted-foreground" />
                    <CardTitle className="text-sm">Combined answer</CardTitle>
                  </div>
                  <p className="whitespace-pre-wrap text-sm text-foreground">{result.combined_answer}</p>
                </Card>
              )}

              {result.domains.map(section => (
                <DomainSection key={section.domain} section={section} />
              ))}

              {result.claim_trajectories.length > 0 && (
                <Card className="p-4">
                  <CardTitle className="mb-3 text-sm">Claim trajectory</CardTitle>
                  <div className="space-y-3">
                    {result.claim_trajectories.map(trajectory => (
                      <div key={trajectory.claim_id} className="rounded-md border border-border p-3">
                        <div className="mb-1.5 text-xs text-muted-foreground">
                          {trajectory.subject_text ?? trajectory.subject_object_id ?? trajectory.claim_id}
                        </div>
                        <div className="space-y-1.5">
                          {trajectory.signals.map((signal, index) => (
                            <div key={`${signal.kind}-${index}`} className="flex flex-wrap items-center gap-1.5 text-sm">
                              <Badge variant={signal.confidence_tier === 'high' ? 'warning' : 'outline'}>{signal.kind}</Badge>
                              <span className="text-muted-foreground">{signal.summary}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </Card>
              )}

              {result.provenance.length > 0 && (
                <Card className="p-4">
                  <CardTitle className="mb-3 text-sm">Provenance</CardTitle>
                  <div className="space-y-3">
                    {ALL_DOMAINS.filter(domain => provenanceByDomain.has(domain)).map(domain => (
                      <div key={domain}>
                        <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">{DOMAIN_LABELS[domain]}</div>
                        <div className="flex flex-wrap gap-1.5">
                          {(provenanceByDomain.get(domain) ?? []).map(item => (
                            <Badge key={`${item.object_type}:${item.object_id}`} variant="secondary" className="max-w-[18rem] truncate">
                              {item.title}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </Card>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
