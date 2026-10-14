import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, Inbox, Loader2, RefreshCw, RotateCcw, X } from 'lucide-react'
import { toast } from 'sonner'
import { evolutionApi, proposalsApi } from '../../api/client'
import { useSpace } from '../../contexts/SpaceContext'
import { errMsg } from '../../lib/utils'
import type { EvolvableAsset, EvolvableAssetEvaluationRun, EvolutionBundle, EvolutionProposal, EvolutionSignal } from '../../types/api'
import { Badge, StatusBadge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Card, CardTitle } from '../../components/ui/card'
import { EmptyState } from '../../components/ui/empty-state'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { Skeleton } from '../../components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs'
import { notifyReviewAttentionChanged } from '../../core/reviewAttention'
import { useAppTranslation } from '../../i18n'
import { formatDateTime } from '../../i18n/format'

type InboxTab = 'signals' | 'bundles' | 'evidence' | 'approval'


export default function EvolutionInboxPage() {
  const { t } = useAppTranslation()
  const { activeSpaceId, preferredSpaceId, userId } = useSpace()
  const spaceId = activeSpaceId ?? preferredSpaceId
  const [signals, setSignals] = useState<EvolutionSignal[]>([])
  const [bundles, setBundles] = useState<EvolutionBundle[]>([])
  const [proposals, setProposals] = useState<EvolutionProposal[]>([])
  const [evaluations, setEvaluations] = useState<Array<{ asset: EvolvableAsset; runs: EvolvableAssetEvaluationRun[] }>>([])
  const [selectedProposalIds, setSelectedProposalIds] = useState<string[]>([])
  const [selectedBundle, setSelectedBundle] = useState<EvolutionBundle | null>(null)
  const [bundleTitle, setBundleTitle] = useState('')
  const [tab, setTab] = useState<InboxTab>('signals')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)

  const pendingProposals = useMemo(() => proposals.filter(proposal => proposal.status === 'pending'), [proposals])

  const load = useCallback(async () => {
    if (!spaceId) { setSignals([]); setBundles([]); setProposals([]); setEvaluations([]); setLoading(false); return }
    setLoading(true)
    try {
      const [nextSignals, nextBundles, nextProposals, nextAssets] = await Promise.all([
        evolutionApi.signals({ limit: 100 }), evolutionApi.bundles({ limit: 100 }), evolutionApi.proposals({ limit: 100 }), evolutionApi.assets(),
      ])
      setSignals(nextSignals); setBundles(nextBundles); setProposals(nextProposals)
      // A proposal bundled elsewhere since it was ticked cannot be unticked
      // (its box is disabled), so it leaves the selection here.
      setSelectedProposalIds(current => current.filter(id => nextProposals.some(proposal => proposal.id === id && proposal.status === 'pending' && !proposal.bundle_id)))
      const nextEvaluations = await Promise.all(nextAssets.slice(0, 20).map(async asset => ({ asset, runs: await evolutionApi.assetEvaluationRuns(asset.id).catch(() => []) })))
      setEvaluations(nextEvaluations.filter(item => item.runs.length > 0))
    } catch (error) {
      toast.error(errMsg(error)); setSignals([]); setBundles([]); setProposals([]); setEvaluations([])
    } finally { setLoading(false) }
  }, [spaceId])

  const loadBundle = useCallback(async (id: string) => {
    setBusy(`bundle:${id}`)
    try { setSelectedBundle(await evolutionApi.bundle(id)) } catch (error) { toast.error(errMsg(error)) } finally { setBusy(null) }
  }, [])

  useEffect(() => { void load() }, [load])

  async function triage(signal: EvolutionSignal, status: 'acknowledged' | 'dismissed') {
    setBusy(`signal:${signal.id}`)
    try {
      const updated = status === 'dismissed' ? await evolutionApi.dismissSignal(signal.id) : await evolutionApi.updateSignal(signal.id, { triage_status: status })
      setSignals(current => current.map(item => item.id === updated.id ? updated : item))
    } catch (error) { toast.error(errMsg(error)) } finally { setBusy(null) }
  }

  async function createBundle() {
    const eligibleProposalIds = selectedProposalIds.filter(id => {
      const proposal = pendingProposals.find(item => item.id === id)
      return proposal !== undefined && !proposal.bundle_id && !requiresSpecialProposalAction(proposal)
    })
    if (eligibleProposalIds.length === 0 || !bundleTitle.trim()) return
    setBusy('create-bundle')
    try {
      const created = await evolutionApi.createBundle({ title: bundleTitle.trim(), proposal_ids: eligibleProposalIds })
      setBundles(current => [created, ...current]); setSelectedProposalIds([]); setBundleTitle(''); setSelectedBundle(created); setTab('bundles')
      toast.success(t('evolution.inbox_page.bundle_created'))
    } catch (error) { toast.error(errMsg(error)) } finally { setBusy(null) }
  }

  async function decideMember(proposalId: string, decision: 'approve' | 'reject') {
    if (!selectedBundle) return
    setBusy(`decision:${proposalId}`)
    try {
      const updated = await evolutionApi.decideBundle(selectedBundle.id, [{ proposal_id: proposalId, decision }])
      setSelectedBundle(updated); setBundles(current => current.map(bundle => bundle.id === updated.id ? updated : bundle)); notifyReviewAttentionChanged(); await load()
    } catch (error) { toast.error(errMsg(error)) } finally { setBusy(null) }
  }

  async function decideProposal(proposalId: string, decision: 'approve' | 'reject') {
    const proposal = pendingProposals.find(item => item.id === proposalId)
    if (!proposal) return
    setBusy(`proposal:${proposalId}`)
    try {
      if (decision === 'approve') {
        if (isEgressProposal(proposal)) {
          if (proposal.required_approver_user_id !== userId) throw new Error(t('evolution.inbox_page.granting_user_required'))
          await proposalsApi.approveEgressGrantingUserProposal(proposalId, { grant_id: proposal.grant_id ?? undefined })
        } else if (proposal?.proposal_type === 'code_patch' && proposal.incomplete_patch) {
          const skipped = proposal.skipped_count ?? 0
          const message = skipped > 0
            ? t('evolution.inbox_page.incomplete_patch_skipped', { count: skipped })
            : t('evolution.inbox_page.incomplete_patch_unknown')
          if (!window.confirm(message)) return
          await proposalsApi.accept(proposalId, { confirmIncompletePatch: true })
        } else {
          await proposalsApi.accept(proposalId)
        }
      } else await proposalsApi.reject(proposalId)
      notifyReviewAttentionChanged()
      await load()
      toast.success(decision === 'approve' && isEgressProposal(proposal) ? t('evolution.inbox_page.egress_recorded') : decision === 'approve' ? t('evolution.inbox_page.proposal_approved') : t('evolution.inbox_page.proposal_rejected'))
    } catch (error) { toast.error(errMsg(error)) } finally { setBusy(null) }
  }

  async function rollback() {
    if (!selectedBundle) return
    setBusy('rollback')
    try { const updated = await evolutionApi.rollbackBundle(selectedBundle.id); setSelectedBundle(updated); setBundles(current => current.map(bundle => bundle.id === updated.id ? updated : bundle)); await load() } catch (error) { toast.error(errMsg(error)) } finally { setBusy(null) }
  }

  return (
    <div className="max-w-7xl space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-4"><div className="flex items-center gap-3"><div className="flex size-11 items-center justify-center rounded-xl border border-primary/35 bg-primary/10"><Inbox className="size-5 text-accent-foreground" /></div><div><h1 className="text-xl font-semibold">{t('evolution.inbox')}</h1><p className="text-sm text-muted-foreground">{t('evolution.inbox_page.flow')}</p><p className="text-xs text-muted-foreground">{t('evolution.inbox_page.boundary')}</p></div></div><Button size="sm" variant="outline" onClick={() => void load()} disabled={loading || !spaceId}><RefreshCw className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} /> {t('evolution.inbox_page.refresh')}</Button></div>
      {loading ? <div className="space-y-3"><Skeleton className="h-12 w-full" /><Skeleton className="h-48 w-full" /></div> : (
        <Tabs value={tab} onValueChange={value => setTab(value as InboxTab)}>
          <TabsList className="flex h-auto flex-wrap justify-start"><TabsTrigger value="signals">{t('evolution.inbox_page.tab_signals', { count: signals.filter(signal => signal.triage_status !== 'dismissed').length })}</TabsTrigger><TabsTrigger value="bundles">{t('evolution.inbox_page.tab_bundles', { count: bundles.length })}</TabsTrigger><TabsTrigger value="evidence">{t('evolution.inbox_page.tab_evidence', { count: proposals.length })}</TabsTrigger><TabsTrigger value="approval">{t('evolution.inbox_page.tab_approval')}</TabsTrigger></TabsList>
          <TabsContent value="signals" className="mt-4"><div className="space-y-2">{signals.length === 0 ? <EmptyState title={t('evolution.inbox_page.no_signals')} description={t('evolution.inbox_page.no_signals_description')} /> : signals.map(signal => <Card key={signal.id} className="mb-0 p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex flex-wrap gap-1.5"><Badge variant="outline">{signal.signal_type}</Badge><Badge variant={signal.severity === 'critical' ? 'destructive' : signal.severity === 'high' ? 'default' : 'secondary'}>{signal.severity}</Badge><StatusBadge status={signal.triage_status ?? 'new'} /></div><p className="mt-2 text-sm">{signal.summary ?? t('evolution.inbox_page.no_summary')}</p><p className="mt-1 text-xs text-muted-foreground">{signal.source_type} · {formatDateTime(signal.created_at)}</p></div><div className="flex gap-1.5">{signal.triage_status !== 'acknowledged' && <Button size="sm" variant="outline" disabled={busy === `signal:${signal.id}`} onClick={() => void triage(signal, 'acknowledged')}><Check className="size-3.5" /> {t('evolution.inbox_page.acknowledge')}</Button>}{signal.triage_status !== 'dismissed' && <Button size="sm" variant="outline" disabled={busy === `signal:${signal.id}`} onClick={() => void triage(signal, 'dismissed')}><X className="size-3.5" /> {t('evolution.inbox_page.dismiss')}</Button>}</div></div></Card>)}</div></TabsContent>
          <TabsContent value="bundles" className="mt-4 grid gap-4 xl:grid-cols-[360px_minmax(0,1fr)]"><div className="space-y-2">{bundles.length === 0 ? <EmptyState title={t('evolution.inbox_page.no_bundles')} description={t('evolution.inbox_page.no_bundles_description')} /> : bundles.map(bundle => <button type="button" key={bundle.id} onClick={() => void loadBundle(bundle.id)} className={`w-full rounded-md border p-3 text-left ${selectedBundle?.id === bundle.id ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/40'}`}><div className="flex items-center justify-between gap-2"><span className="truncate text-sm font-medium">{bundle.title}</span><StatusBadge status={bundle.status} /></div><div className="mt-2 flex gap-1.5"><Badge variant="outline">{t('evolution.inbox_page.members', { count: bundle.member_count })}</Badge><Badge variant="muted">{bundle.risk_level}</Badge></div></button>)}</div><BundleDetail bundle={selectedBundle} busy={busy} onApprove={id => void decideMember(id, 'approve')} onReject={id => void decideMember(id, 'reject')} onRollback={() => void rollback()} /></TabsContent>
          <TabsContent value="evidence" className="mt-4 space-y-4"><Card className="mb-0 p-4"><CardTitle>{t('evolution.inbox_page.pending_evidence')}</CardTitle><div className="mt-3 space-y-2">{pendingProposals.length === 0 ? <EmptyState title={t('evolution.no_pending_proposals')} description={t('evolution.inbox_page.no_pending_description')} /> : pendingProposals.map(proposal => <div key={proposal.id} className="flex items-start gap-3 rounded-md border border-border p-3"><input type="checkbox" disabled={Boolean(proposal.bundle_id) || requiresSpecialProposalAction(proposal)} checked={selectedProposalIds.includes(proposal.id)} onChange={event => setSelectedProposalIds(current => event.target.checked ? [...current, proposal.id] : current.filter(id => id !== proposal.id))} /><div className="min-w-0 flex-1"><div className="flex flex-wrap items-start justify-between gap-3"><span className="min-w-0 flex-1"><span className="flex flex-wrap gap-1.5"><Badge variant="outline">{proposal.proposal_type}</Badge><Badge variant="muted">{proposal.target_type ?? t('evolution.inbox_page.target')}</Badge>{proposal.bundle_id && <Badge variant="muted">{proposal.bundle_member_status === 'released' ? t('evolution.inbox_page.previously_bundled') : t('evolution.inbox_page.already_bundled')}</Badge>}</span><span className="mt-1 block text-sm">{proposal.summary ?? proposal.id}</span><span className="mt-1 block font-mono text-xs text-muted-foreground">{proposal.id}</span></span>{!proposal.bundle_id && <ProposalActions proposal={proposal} currentUserId={userId} busy={busy} onApprove={() => void decideProposal(proposal.id, 'approve')} onReject={() => void decideProposal(proposal.id, 'reject')} />}</div></div></div>)}</div><div className="mt-4 flex flex-wrap items-end gap-2"><div className="min-w-64 flex-1 space-y-1.5"><Label>{t('evolution.inbox_page.bundle_title')}</Label><Input value={bundleTitle} onChange={event => setBundleTitle(event.target.value)} placeholder={t('evolution.inbox_page.bundle_title_placeholder')} /></div><Button onClick={() => void createBundle()} disabled={busy === 'create-bundle' || selectedProposalIds.length === 0 || !bundleTitle.trim()}>{busy === 'create-bundle' && <Loader2 className="size-3.5 animate-spin" />} {t('evolution.inbox_page.create_bundle')}</Button></div></Card><Card className="mb-0 p-4"><CardTitle>{t('evolution.inbox_page.evaluation_evidence')}</CardTitle><div className="mt-3 space-y-2">{evaluations.length === 0 ? <EmptyState title={t('evolution.no_evaluation_runs')} description={t('evolution.inbox_page.no_evaluations_description')} /> : evaluations.map(item => <div key={item.asset.id} className="rounded-md border border-border p-3"><div className="flex items-center justify-between gap-2"><span className="font-medium">{item.asset.display_name}</span><Badge variant="outline">{t('evolution.inbox_page.evaluation_runs', { count: item.runs.length })}</Badge></div><div className="mt-2 flex flex-wrap gap-1.5">{item.runs.slice(0, 5).map(run => <Badge key={run.id} variant={run.status === 'passed' ? 'secondary' : run.status === 'failed' ? 'destructive' : 'muted'}>{run.status} · {run.evaluator_version}</Badge>)}</div></div>)}</div></Card></TabsContent>
          <TabsContent value="approval" className="mt-4"><Card className="mb-0 p-4"><CardTitle>{t('evolution.inbox_page.selected_bundle_approval')}</CardTitle><p className="mt-2 text-sm text-muted-foreground">{t('evolution.inbox_page.approval_hint')}</p>{selectedBundle ? <div className="mt-4"><BundleDetail bundle={selectedBundle} busy={busy} onApprove={id => void decideMember(id, 'approve')} onReject={id => void decideMember(id, 'reject')} onRollback={() => void rollback()} /></div> : <EmptyState className="mt-4" title={t('evolution.inbox_page.no_bundle_selected')} description={t('evolution.inbox_page.open_bundle_hint')} />}</Card></TabsContent>
        </Tabs>
      )}
    </div>
  )
}

function isEgressProposal(proposal: EvolutionProposal | undefined): boolean {
  return Boolean(proposal && (
    proposal.proposal_type === 'egress_review' ||
    proposal.requires_approval_type === 'egress_granting_user' ||
    proposal.grant_id
  ))
}

function requiresSpecialProposalAction(proposal: EvolutionProposal): boolean {
  return isEgressProposal(proposal) || (proposal.proposal_type === 'code_patch' && proposal.incomplete_patch === true)
}

function ProposalActions({ proposal, currentUserId, busy, onApprove, onReject }: {
  proposal: EvolutionProposal
  currentUserId: string | null | undefined
  busy: string | null
  onApprove: () => void
  onReject: () => void
}) {
  const { t } = useAppTranslation()
  const actionBusy = busy === `proposal:${proposal.id}`
  const egress = isEgressProposal(proposal)
  const incompletePatch = proposal.proposal_type === 'code_patch' && proposal.incomplete_patch === true
  return <span className="flex gap-1.5">{egress
    ? proposal.egress_approval_status === 'approved'
      ? <span className="self-center text-xs text-muted-foreground">{t('evolution.inbox_page.egress_recorded')}</span>
      : proposal.required_approver_user_id === currentUserId
        ? <Button size="sm" variant="outline" disabled={actionBusy} onClick={onApprove}><Check className="size-3.5" /> {t('evolution.inbox_page.approve_egress')}</Button>
        : <span className="self-center text-xs text-muted-foreground">{t('evolution.inbox_page.waiting_granting_user')}</span>
    : <Button size="sm" variant="outline" disabled={actionBusy} onClick={onApprove}><Check className="size-3.5" />{incompletePatch ? t('evolution.inbox_page.confirm_partial_patch') : t('evolution.inbox_page.approve')}</Button>}<Button size="sm" variant="destructive" disabled={actionBusy} onClick={onReject}><X className="size-3.5" /> {t('evolution.inbox_page.reject')}</Button></span>
}

function BundleDetail({ bundle, busy, onApprove, onReject, onRollback }: { bundle: EvolutionBundle | null; busy: string | null; onApprove: (id: string) => void; onReject: (id: string) => void; onRollback: () => void }) {
  const { t } = useAppTranslation()
  if (!bundle) return <EmptyState title={t('evolution.inbox_page.no_bundle_selected')} description={t('evolution.inbox_page.select_bundle_hint')} />
  return <Card className="mb-0 p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><CardTitle>{bundle.title}</CardTitle><p className="mt-1 text-sm text-muted-foreground">{bundle.description ?? t('evolution.no_description')}</p></div><div className="flex gap-1.5"><Badge variant="outline">{bundle.risk_level}</Badge><StatusBadge status={bundle.status} /></div></div><div className="mt-4 space-y-2">{(bundle.members ?? []).map(member => <div key={member.id} className="rounded-md border border-border p-3"><div className="flex flex-wrap items-center justify-between gap-2"><div><div className="text-sm font-medium">{member.proposal.title}</div><div className="mt-1 flex flex-wrap gap-1.5"><Badge variant="outline">{member.proposal.proposal_type}</Badge><StatusBadge status={member.status} /></div></div>{member.status === 'pending' && <div className="flex gap-1.5"><Button size="sm" variant="outline" disabled={busy === `decision:${member.proposal_id}`} onClick={() => onApprove(member.proposal_id)}><Check className="size-3.5" /> {t('evolution.inbox_page.approve')}</Button><Button size="sm" variant="outline" disabled={busy === `decision:${member.proposal_id}`} onClick={() => onReject(member.proposal_id)}><X className="size-3.5" /> {t('evolution.inbox_page.reject')}</Button></div>}</div><p className="mt-2 text-xs text-muted-foreground">{t('evolution.inbox_page.member_snapshot', { state: member.before_snapshot_available ? t('evolution.inbox_page.snapshot_recorded') : t('evolution.inbox_page.snapshot_not_applicable'), date: formatDateTime(member.decided_at) })}{member.before_snapshot_available && member.rollback_supported === false ? ` · ${t('evolution.inbox_page.rollback_unsupported_member')}` : ''}</p>{member.rollback_blocker && <p className="mt-1 text-xs text-destructive">{member.rollback_blocker}</p>}</div>)}</div>{bundle.rollbackable && bundle.status !== 'rolled_back' && <Button className="mt-4" size="sm" variant="outline" disabled={busy === 'rollback'} onClick={onRollback}><RotateCcw className="size-3.5" /> {t('evolution.inbox_page.rollback_members')}</Button>}{(bundle.rollback_blockers?.length ?? 0) > 0 && bundle.status !== 'rolled_back' && <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-700">{t('evolution.inbox_page.rollback_unavailable', { reasons: bundle.rollback_blockers?.join(' ') ?? '' })}</div>}{bundle.rollback_error && <p className="mt-3 text-sm text-destructive">{t('evolution.inbox_page.rollback_failed', { error: bundle.rollback_error })}</p>}</Card>
}
