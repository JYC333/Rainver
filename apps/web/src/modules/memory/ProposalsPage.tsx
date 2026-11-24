import { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { SpaceLink as Link } from '../../core/spaceNav'
import { FileCheck, FolderKanban, X } from 'lucide-react'
import { toast } from 'sonner'
import { proposalsApi } from '../../api/client'
import { notifyReviewAttentionChanged } from '../../core/reviewAttention'
import { useSpace } from '../../contexts/SpaceContext'
import { cn, errMsg } from '../../lib/utils'
import type { Proposal, ProposalAcceptOut } from '../../types/api'
import { Card } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { Badge } from '../../components/ui/badge'
import { Label } from '../../components/ui/label'
import { Select } from '../../components/ui/select'
import { PreviewBadge, UrgencyBadge } from '../../components/PreviewBadge'
import { ScopeBadge } from '../../components/ScopeBadge'
import { EgressReviewNotice, isGrantDerivedProposal } from './EgressReviewNotice'
import { codePatchAcceptOptions } from './codePatchConfirm'
import { acceptRefusalKey, decisionOpenOutsideConversation } from './acceptOutcome'
import {
  TYPE_FILTERS,
  apiTypesForFilter,
  proposalMatchesTypeFilter,
  type ProposalTypeFilter,
} from './proposalFilters'
import { useAppTranslation } from '../../i18n'
import { proposalTitle } from './proposalTitle'

function fmt(dt: string | null | undefined) { return dt ? new Date(dt).toLocaleString() : '—' }
const PAGE_SIZE = 80

const RISK_VARIANT: Record<string, 'default' | 'secondary' | 'muted' | 'destructive'> = {
  low:      'muted',
  medium:   'secondary',
  high:     'default',
  critical: 'destructive',
}

function SourceActionReviewDetails({ proposal }: { proposal: Proposal }) {
  if (!['source_recipe_activation','source_backfill_start','project_source_bind','source_connection_create'].includes(proposal.proposal_type)) return null
  let payload: Record<string, unknown> = {}
  try { const parsed=JSON.parse(proposal.proposed_content);if(parsed&&typeof parsed==='object')payload=parsed as Record<string,unknown> } catch { /* older proposals may use prose */ }
  const strategy=(payload.strategy_json ?? payload.strategy) as Record<string,unknown>|undefined
  const quota=(payload.quota_policy_json ?? payload.quota_policy) as Record<string,unknown>|undefined
  const fields: Array<[string,unknown]> = proposal.proposal_type==='source_backfill_start'
    ? [['Scope',payload.source_connection_id],['Window',strategy?.window_unit],['From',strategy?.from],['To',strategy?.to],['Maximum items',strategy?.max_items],['Quota',quota ? `${quota.limit_count ?? '?'} / ${quota.window ?? 'window'}` : null]]
    : proposal.proposal_type==='project_source_bind'
      ? [['Project',payload.project_id],['Source',payload.source_connection_id],['Delivery',payload.delivery_scope],['Backfill existing',payload.backfill_history]]
      : [['Source',payload.source_connection_id ?? payload.name],['Endpoint',payload.endpoint_url],['Schedule',payload.fetch_frequency],['Capture policy',payload.capture_policy]]
  const shown=fields.filter(([,value])=>value!==undefined&&value!==null&&value!=='')
  if(!shown.length)return null
  return <div className="mb-3 grid gap-2 rounded-md border bg-muted/30 p-3 sm:grid-cols-2">{shown.map(([label,value])=><div key={label}><p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p><p className="text-xs break-all">{String(value)}</p></div>)}</div>
}

export default function ProposalsPage() {
  const { t } = useAppTranslation()
  const { activeSpaceId, activeSpaceName, userId } = useSpace()
  const [searchParams, setSearchParams] = useSearchParams()
  const projectFilter = searchParams.get('project_id') ?? ''

  const [filterStatus, setFilterStatus]       = useState('pending')
  const [filterUrgency, setFilterUrgency]     = useState('')
  const [filterExpired, setFilterExpired]     = useState<string>('')
  const [approvingId, setApprovingId] = useState<string | null>(null)
  const [position, setPosition] = useState({ filterKey: '', offset: 0 })
  const [revision, refresh] = useState(0)
  const [result, setResult] = useState<{ key: string; items: Proposal[]; total: number; failed?: boolean }>()

  // Proposal type grouping is local to this page; the Review sidebar only switches
  // between real review surfaces (Proposals and Memory).
  const rawUrlType = searchParams.get('type') ?? ''
  const urlType = rawUrlType === 'task_create' ? 'follow_up_task' : rawUrlType
  const filterKey = JSON.stringify([activeSpaceId, userId, filterStatus, urlType, filterUrgency, filterExpired, projectFilter])
  const offset = position.filterKey === filterKey ? position.offset : 0
  const requestKey = JSON.stringify([filterKey, offset, revision])
  const current = result?.key === requestKey ? result : undefined
  const proposals = current?.items ?? []
  const reload = () => refresh(value => value + 1)

  function setTypeFilter(type: ProposalTypeFilter) {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (type) next.set('type', type)
      else next.delete('type')
      return next
    })
  }

  useEffect(() => {
    if (!activeSpaceId) return
    const controller = new AbortController()
    const types = apiTypesForFilter(urlType)
    void proposalsApi.list({
      status: filterStatus || 'all',
      ...(types.length > 1 ? { types } : { type: types[0] }),
      urgency: filterUrgency || undefined,
      expired: filterExpired === '' ? undefined : filterExpired === 'true',
      project_id: projectFilter || undefined,
      limit: PAGE_SIZE,
      offset,
    }, { spaceId: activeSpaceId, signal: controller.signal }).then(page => {
      if (controller.signal.aborted) return
      if (offset > 0 && offset >= page.total) {
        setPosition({ filterKey, offset: Math.max(0, Math.floor((page.total - 1) / PAGE_SIZE) * PAGE_SIZE) })
        return
      }
      setResult({ key: requestKey, items: page.items, total: page.total })
    }).catch(error => {
      if (controller.signal.aborted) return
      setResult({ key: requestKey, items: [], total: 0, failed: true })
      toast.error(errMsg(error))
    })
    return () => controller.abort()
  }, [activeSpaceId, filterExpired, filterKey, filterStatus, filterUrgency, offset, projectFilter, requestKey, urlType])

  async function decide(id: string, action: 'accept' | 'reject') {
    try {
      if (action === 'accept') {
        const proposal = proposals.find(p => p.id === id) ?? await proposalsApi.get(id, { spaceId: activeSpaceId ?? undefined })
        const options = codePatchAcceptOptions(proposal)
        if (options === null || proposal.chosen_on_card) return
        const out: ProposalAcceptOut = await proposalsApi.accept(id, { ...options, spaceId: activeSpaceId ?? undefined })
        const refusal = acceptRefusalKey(out)
        if (refusal) toast.error(t(refusal))
        else if(out.result_type==='code_patch_pending'){toast.info(t(`mixed_surfaces.code_patch_${out.result.status === 'pending' ? 'queued' : out.result.status}`));}
        else if (out.result_type === 'memory_entry') {
          toast.success('Accepted — memory entry created.')
        } else if (out.result_type === 'code_patch_apply') {
          const n = out.result.updated_paths.length
          toast.success(`Accepted — ${n} file${n === 1 ? '' : 's'} updated.`)
        } else if (out.result_type === 'knowledge_item') {
          toast.success('Accepted — knowledge item created.')
        } else if (out.result_type === 'retrieval_maintenance_packet') {
          const count = out.result.generated_child_proposal_count ?? out.result.generated_child_proposal_ids?.length ?? 0
          toast.success(`Accepted — ${count} child proposal${count === 1 ? '' : 's'} created.`)
        } else if (out.result_type === 'claim_candidate_packet') {
          const count = out.result.generated_child_proposal_count ?? out.result.generated_child_proposal_ids?.length ?? 0
          const skipped = out.result.skipped_child_proposal_count ?? 0
          toast.success(`Accepted — ${count} child proposal${count === 1 ? '' : 's'} created${skipped ? `, ${skipped} skipped` : ''}.`)
        } else if (out.result_type === 'agent_version') {
          toast.success('Accepted — agent version updated.')
        } else {
          toast.success('Proposal accepted.')
        }
      } else {
        await proposalsApi.reject(id, { spaceId: activeSpaceId ?? undefined })
        toast.success('Proposal rejected.')
      }
      notifyReviewAttentionChanged()
      reload()
    } catch (e) {
      const message = errMsg(e)
      if (message.includes('GrantingUserApprovalRequired') || message.includes('egress_granting_user')) {
        toast.error('Granting-user approval is required before this can be applied.')
      } else if (
        message.includes('not_implemented') ||
        message.includes('not implemented') ||
        message.includes('unsupported') ||
        message.includes('422')
      ) {
        toast.error('This proposal type cannot be applied yet. Reject it to dismiss, or leave it pending.')
      } else {
        toast.error(message)
      }
      // A refused decision (e.g. 404 after expiry) shows the live list rather than stale buttons.
      reload()
    }
  }

  async function approveEgress(p: Proposal) {
    setApprovingId(p.id)
    try {
      await proposalsApi.approveEgressGrantingUserProposal(p.id, { grant_id: p.grant_id ?? undefined }, { spaceId: activeSpaceId ?? undefined })
      toast.success('Egress review approval recorded')
      notifyReviewAttentionChanged()
      reload()
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setApprovingId(null)
    }
  }

  const canDecide = (p: Proposal) => decisionOpenOutsideConversation(p)
  // A maintenance update the person has not revised yet is accepted only
  // after the revision, which is made on its own page.
  const awaitingRevision = (p: Proposal) => Boolean(p.operator_revision && !p.operator_revision.edited_by_user_id)

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-col gap-4 pb-4 border-b border-border lg:flex-row lg:items-start lg:justify-between">
        <div className="flex items-center gap-4">
          <div
            className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
            style={{
              background: 'color-mix(in oklch, var(--primary) 12%, transparent)',
              border: '1px solid color-mix(in oklch, var(--primary) 35%, transparent)',
            }}
          >
            <FileCheck className="size-5 text-accent-foreground" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Proposals</h1>
            <p className="text-sm text-muted-foreground">
              Canonical list from <code className="text-xs bg-muted px-1 rounded">GET /api/v1/proposals</code>
              {' '}— accept/reject use <code className="text-xs bg-muted px-1 rounded">POST /api/v1/proposals/…</code>.
            </p>
            <p className="text-xs text-muted-foreground">Viewing: {activeSpaceName ?? activeSpaceId ?? 'No operational space selected'}</p>
            {projectFilter && (
              <span className="inline-flex items-center gap-1 mt-0.5 px-2 py-0.5 rounded-full bg-accent/40 text-xs text-accent-foreground">
                <FolderKanban className="size-3" />
                Filtered by project
                <button onClick={() => setSearchParams(p => { p.delete('project_id'); return p })} className="ml-0.5 hover:text-foreground" aria-label="Clear project filter">
                  <X className="size-3" />
                </button>
              </span>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-2 items-end">
          <div className="min-w-[120px]">
            <Label className="text-xs">status</Label>
            <Select
              value={filterStatus}
              options={[
                { value: 'pending', label: 'pending' },
                { value: 'accepted', label: 'accepted' },
                { value: 'rejected', label: 'rejected' },
                { value: '', label: 'all statuses' },
              ]}
              onChange={setFilterStatus}
            />
          </div>
          <div className="min-w-[120px]">
            <Label className="text-xs">urgency</Label>
            <Select
              value={filterUrgency}
              options={[
                { value: '', label: 'any' },
                { value: 'low', label: 'low' },
                { value: 'normal', label: 'normal' },
                { value: 'high', label: 'high' },
                { value: 'critical', label: 'critical' },
              ]}
              onChange={setFilterUrgency}
            />
          </div>
          <div className="min-w-[100px]">
            <Label className="text-xs">expired</Label>
            <Select
              value={filterExpired}
              options={[
                { value: '', label: 'any' },
                { value: 'true', label: 'true' },
                { value: 'false', label: 'false' },
              ]}
              onChange={setFilterExpired}
            />
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-1 rounded-md border border-border bg-card p-1 w-fit max-w-full">
        {TYPE_FILTERS.map(filter => {
          const active = urlType === filter.value || (
            filter.value === 'memory' && urlType.startsWith('memory_')
          ) || (
            filter.value === 'knowledge' && proposalMatchesTypeFilter({ proposal_type: urlType }, 'knowledge')
          )
          return (
            <button
              key={filter.label}
              type="button"
              aria-pressed={active}
              onClick={() => setTypeFilter(filter.value)}
              className={cn(
                'h-8 rounded px-3 text-xs font-medium transition-colors',
                active
                  ? 'bg-primary/10 text-accent-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              {filter.label}
            </button>
          )
        })}
      </div>

      {current?.failed ? (
        <Button size="sm" variant="outline" onClick={reload}>{t('pagination.retry')}</Button>
      ) : activeSpaceId && !current ? (
        <p role="status" className="text-sm text-muted-foreground">{t('pagination.loading')}</p>
      ) : proposals.length === 0
        ? <Card><p className="text-muted-foreground text-center py-10 text-sm">
            {activeSpaceId ? 'No proposals for these filters.' : 'Select an operational space to browse proposals.'}
          </p></Card>
        : proposals.map(p => (
          <Card key={p.id}>
            <div className="flex items-start justify-between gap-4 mb-3 flex-wrap">
              <Link to={`/proposals/${p.id}`} className="font-medium text-sm text-accent-foreground hover:underline">
                {proposalTitle(p.proposed_title, p.title_parts)}
              </Link>
              {canDecide(p) && (
                <div className="flex gap-1.5 shrink-0">
                  {awaitingRevision(p)
                    ? <Button size="sm" variant="outline" asChild><Link to={`/proposals/${p.id}`}>{t('knowledge_ui.memory_revision.revise_link')}</Link></Button>
                    // Its Agent and model are chosen on the card (ADR 0036): accepted where the choice is shown.
                    : p.chosen_on_card
                      ? <Button size="sm" variant="outline" asChild><Link to={`/proposals/${p.id}`}>{t('gmail_ui.execution.choose_link')}</Link></Button>
                      : <Button size="sm" variant="success" onClick={() => decide(p.id, 'accept')}>Accept</Button>}
                  <Button size="sm" variant="destructive" onClick={() => decide(p.id, 'reject')}>Reject</Button>
                </div>
              )}
            </div>
            <div className="flex gap-1.5 mb-3 flex-wrap items-center">
              <Badge variant="secondary">{p.proposal_type}</Badge>
              <Badge variant="outline">{p.status}</Badge>
              <Badge variant={RISK_VARIANT[p.risk_level] ?? 'muted'}>{p.risk_level} risk</Badge>
              {isGrantDerivedProposal(p) && (
                <Badge variant={p.egress_approval_status === 'approved' ? 'success' : 'warning'}>
                  {p.egress_approval_status === 'approved' ? 'egress approved' : 'egress gated'}
                </Badge>
              )}
              <UrgencyBadge urgency={p.urgency} />
              <ScopeBadge visibility={p.visibility} omitShared />
              {p.preview && <PreviewBadge />}
              {p.expired && <Badge variant="destructive">EXPIRED</Badge>}
              {p.created_by_run_id && (
                <Link to={`/runs/${p.created_by_run_id}`} className="text-xs text-accent-foreground hover:underline">
                  from run
                </Link>
              )}
            </div>
            <p className="text-xs text-muted-foreground mb-2">
              review_deadline {fmt(p.review_deadline)} · expires_at {fmt(p.expires_at)}
            </p>
            <EgressReviewNotice
              proposal={p}
              currentUserId={userId}
              targetSpaceName={activeSpaceName ?? activeSpaceId ?? 'this space'}
              approving={approvingId === p.id}
              compact
              onApprove={() => approveEgress(p)}
            />
            <SourceActionReviewDetails proposal={p} />
            <p className="text-sm mb-2">{p.proposed_content}</p>
            <p className="text-xs text-muted-foreground italic">Rationale: {p.rationale}</p>
            <p className="text-xs text-muted-foreground mt-2">
              {fmt(p.created_at)}
              {p.decided_at && ` · decided ${fmt(p.decided_at)}`}
            </p>
          </Card>
        ))}
      {current && (offset > 0 || offset + PAGE_SIZE < current.total) && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={offset === 0} onClick={() => setPosition({ filterKey, offset: offset - PAGE_SIZE })}>{t('pagination.previous')}</Button>
          <Button size="sm" variant="outline" disabled={offset + PAGE_SIZE >= current.total} onClick={() => setPosition({ filterKey, offset: offset + PAGE_SIZE })}>{t('pagination.next')}</Button>
        </div>
      )}
    </div>
  )
}
