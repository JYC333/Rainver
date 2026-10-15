import { useState, useEffect, useCallback, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { SpaceLink as Link } from '../../core/spaceNav'
import { Activity, ChevronRight, FileText, FolderKanban, Loader2, PackageCheck, Search, Wrench, X } from 'lucide-react'
import { toast } from 'sonner'
import { agentsApi, knowledgeApi, memoryApi, spacesApi } from '../../api/client'
import { useSpace } from '../../contexts/SpaceContext'
import { useAuth } from '../../contexts/AuthContext'
import { errMsg } from '../../lib/utils'
import type {
  Memory,
  Proposal,
  MemoryMaintenanceReport,
  MemoryType,
  ClaimCandidatePacketCreateResponse,
  RetrievalSearchResult,
  SpaceRetrievalSettings,
  AgentOut,
} from '../../types/api'
import { Card, CardTitle } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { Textarea } from '../../components/ui/textarea'
import { Select } from '../../components/ui/select'
import { Badge } from '../../components/ui/badge'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '../../components/ui/table'
import { ScopeBadge } from '../../components/ScopeBadge'
import { Pagination } from '../../components/ui/pagination'
import { formatDateTime, formatNumber } from '../../i18n/format'
import { useAppTranslation } from '../../i18n'

const TYPES:  MemoryType[]  = ['preference', 'semantic', 'episodic', 'procedural', 'project']
function fmt(dt: string | null | undefined) { return formatDateTime(dt) }

interface MemoryForm {
  title: string
  content: string
  type: MemoryType
  namespace: string
}

const EMPTY_FORM: MemoryForm = {
  title: '', content: '', type: 'semantic', namespace: 'user.default',
}

const MEMORY_PAGE_SIZE = 50

export default function MemoriesPage() {
  const { t } = useAppTranslation()
  const { activeSpaceId, activeSpaceName } = useSpace()
  const { currentUser } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()
  const projectFilter = searchParams.get('project_id') ?? ''
  // What the Agents have written on their own is the thing this page exists
  // to make reviewable after the fact (ADR 0003 §2), and a paused session
  // links straight into it from the attention list.
  const sessionFilter = searchParams.get('session') ?? ''
  // A conversation outside a Room has no session; its paused turn links by Run.
  const runFilter = searchParams.get('run') ?? ''
  const writtenByFilter = (searchParams.get('created_by') ?? 'all') as 'all' | 'agent' | 'user'
  // Whose memory, as opposed to who wrote it. `agent` is what the Agents know
  // about themselves and about a Room (ADR 0003 §4) — the owner's to read,
  // archive and restore, and kept apart from what is remembered about a person.
  const scopeFilter = searchParams.get('scope') ?? ''
  const agentFilter = searchParams.get('agent_id') ?? ''
  // "Since I last looked" (ADR 0003 §3). A stamped instant rather than a
  // rolling window, so the list does not shift under the person while they
  // are reading it.
  const sinceFilter = searchParams.get('since') ?? ''
  const statusFilter = searchParams.get('status') ?? 'active'

  const [memories, setMemories] = useState<Memory[]>([])
  const [memoryTotal, setMemoryTotal] = useState(0)
  const [memoryOffset, setMemoryOffset] = useState(0)
  const [agents, setAgents] = useState<AgentOut[]>([])
  const [form, setForm]         = useState<MemoryForm>(EMPTY_FORM)
  const [query, setQuery]       = useState('')
  const [searchResults, setSearchResults] = useState<RetrievalSearchResult[] | null>(null)
  const [appliedSearchQuery, setAppliedSearchQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [maintenanceLimit, setMaintenanceLimit] = useState('500')
  const [staleAfterDays, setStaleAfterDays] = useState('180')
  const [thinContentChars, setThinContentChars] = useState('80')
  const [maxFindings, setMaxFindings] = useState('100')
  const [maintenanceScanMode, setMaintenanceScanMode] = useState<'recent' | 'full'>('recent')
  const [maintenanceCursor, setMaintenanceCursor] = useState('')
  const [maintenanceReviewScope, setMaintenanceReviewScope] = useState<'private' | 'space_ops'>('private')
  const [createMaintenancePacket, setCreateMaintenancePacket] = useState(false)
  const [maintenanceRunning, setMaintenanceRunning] = useState(false)
  const [maintenanceReport, setMaintenanceReport] = useState<MemoryMaintenanceReport | null>(null)
  const [maintenanceNextCursor, setMaintenanceNextCursor] = useState<string | null>(null)
  const [maintenanceReportReviewScope, setMaintenanceReportReviewScope] = useState<'private' | 'space_ops'>('private')
  const [claimPacketCreating, setClaimPacketCreating] = useState(false)
  const [claimPacketResult, setClaimPacketResult] = useState<ClaimCandidatePacketCreateResponse | null>(null)
  const [retrievalSettings, setRetrievalSettings] = useState<SpaceRetrievalSettings | null>(null)

  // Filters change faster than the list answers; only the latest request's
  // page is shown, so the rows always match the filter in the URL.
  const listRequest = useRef(0)
  // Any filter change starts from the first page; a page number from another
  // filter would skip or repeat rows.
  const filterKey = [activeSpaceId ?? '', projectFilter, agentFilter, statusFilter, scopeFilter, writtenByFilter, sessionFilter, runFilter, sinceFilter].join('\u0000')
  useEffect(() => { setMemoryOffset(0) }, [filterKey])
  const load = useCallback(async () => {
    const request = ++listRequest.current
    if (!activeSpaceId) {
      setMemories([])
      setMemoryTotal(0)
      return
    }
    try {
      const page = await memoryApi.list({
        limit: MEMORY_PAGE_SIZE,
        offset: memoryOffset,
        status: statusFilter,
        scope: scopeFilter || undefined,
        project_id: projectFilter || undefined,
        agent_id: agentFilter || undefined,
        created_by: writtenByFilter === 'all' ? undefined : writtenByFilter,
        since: sinceFilter || undefined,
        session: sessionFilter || undefined,
        run: runFilter || undefined,
      })
      if (request !== listRequest.current) return
      setMemories(page.items)
      setMemoryTotal(page.total)
    }
    catch (e) { if (request === listRequest.current) toast.error(errMsg(e)) }
  }, [projectFilter, agentFilter, activeSpaceId, statusFilter, scopeFilter, writtenByFilter, sessionFilter, runFilter, sinceFilter, memoryOffset])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (!activeSpaceId) { setAgents([]); return }
    void agentsApi.list({ limit: '200', status: 'active,disabled,inactive' })
      .then(setAgents)
      .catch(() => setAgents([]))
  }, [activeSpaceId])

  useEffect(() => {
    if (!activeSpaceId) {
      setRetrievalSettings(null)
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const settings = await spacesApi.getRetrievalSettings(activeSpaceId)
        if (!cancelled) setRetrievalSettings(settings)
      } catch {
        if (!cancelled) setRetrievalSettings(null)
      }
    })()
    return () => { cancelled = true }
  }, [activeSpaceId])

  const spaceOpsReviewAllowed = retrievalSettings
    ? retrievalSettings.context_ops_review_mode !== 'private_only'
    : true

  useEffect(() => {
    if (!spaceOpsReviewAllowed && maintenanceReviewScope === 'space_ops') {
      setMaintenanceReviewScope('private')
    }
  }, [maintenanceReviewScope, spaceOpsReviewAllowed])


  const showingSearch = searchResults !== null

  function setField<K extends keyof MemoryForm>(k: K, v: MemoryForm[K]) {
    setForm(f => ({ ...f, [k]: v }))
  }

  async function runSearch() {
    const q = query.trim()
    if (!activeSpaceId) {
      toast.error(t('workspace_ui.memories.no_space_search'))
      return
    }
    if (!q) {
      setSearchResults(null)
      setAppliedSearchQuery('')
      return
    }
    setSearching(true)
    try {
      const response = await memoryApi.retrievalSearch({
        query: q,
        object_types: ['memory_entry'],
      })
      setSearchResults(response.items)
      setAppliedSearchQuery(q)
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setSearching(false)
    }
  }

  function clearSearch() {
    setQuery('')
    setSearchResults(null)
    setAppliedSearchQuery('')
  }

  function recordSearchOpen(result: RetrievalSearchResult) {
    if (!showingSearch || !appliedSearchQuery) return
    void memoryApi.feedback({
      query: appliedSearchQuery,
      object_type: 'memory_entry',
      object_id: result.object_id,
      signal_type: 'opened',
      metadata: { source: 'result_open' },
    }).catch(() => undefined)
  }

  async function addMemory() {
    if (!activeSpaceId) {
      toast.error(t('workspace_ui.memories.no_space_propose'))
      return
    }
    if (!form.title.trim() || !form.content.trim()) {
      toast.error(t('workspace_ui.memories.title_content_required')); return
    }
    try {
      await memoryApi.create({
        ...form,
        project_id: projectFilter || null,
      })
      setForm(EMPTY_FORM)
      toast.success(t('workspace_ui.memories.proposal_submitted'))
      await load()
    } catch (e) { toast.error(errMsg(e)) }
  }

  // Your own memory archives on the spot; someone else's still goes through
  // a proposal (ADR 0003 §3). The server decides which, and says so by
  // returning the entry rather than a proposal.
  function setFilter(key: string, value: string | null) {
    setSearchParams(previous => {
      if (value === null) previous.delete(key)
      else previous.set(key, value)
      return previous
    })
  }

  async function deleteMemory(id: string) {
    try {
      const result = await memoryApi.delete(id)
      toast(isMemory(result) ? t('workspace_ui.memories.archived_toast') : t('workspace_ui.memories.archive_proposal_submitted'))
      await load()
    } catch (e) { toast.error(errMsg(e)) }
  }

  async function revertMemory(id: string) {
    try {
      await memoryApi.revert(id)
      toast(t('workspace_ui.memories.reverted'))
      await load()
    } catch (e) { toast.error(errMsg(e)) }
  }

  async function restoreMemory(id: string) {
    try {
      await memoryApi.restore(id)
      toast(t('workspace_ui.memories.restored'))
      await load()
    } catch (e) { toast.error(errMsg(e)) }
  }

  async function runMaintenanceScan(cursorOverride?: string | null) {
    if (!activeSpaceId) {
      toast.error(t('workspace_ui.memories.no_space_scan'))
      return
    }
    const cursor = cursorOverride ?? (maintenanceScanMode === 'full' ? maintenanceCursor.trim() : '')
    setMaintenanceRunning(true)
    try {
      const report = await memoryApi.maintenanceScan({
        persist_report: true,
        create_packet: createMaintenancePacket,
        limit: positiveInt(maintenanceLimit, 500),
        stale_after_days: positiveInt(staleAfterDays, 180),
        thin_content_chars: positiveInt(thinContentChars, 80),
        max_findings: positiveInt(maxFindings, 100),
        review_scope: maintenanceReviewScope,
        project_id: projectFilter || null,
        scan_mode: maintenanceScanMode,
        cursor: cursor || undefined,
      })
      setMaintenanceReport(report)
      setMaintenanceCursor(cursor)
      setMaintenanceNextCursor(report.next_cursor ?? null)
      setMaintenanceReportReviewScope(maintenanceReviewScope)
      setClaimPacketResult(null)
      toast.success(report.proposal_id ? t('workspace_ui.memories.report_and_packet_created') : t('workspace_ui.memories.report_created'))
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setMaintenanceRunning(false)
    }
  }

  async function createClaimCandidatePacket() {
    if (!maintenanceReport?.artifact_id) {
      toast.error(t('workspace_ui.memories.report_first'))
      return
    }
    setClaimPacketCreating(true)
    try {
      const result = await knowledgeApi.claimCandidatePacket({
        source_artifact_ids: [maintenanceReport.artifact_id],
        review_scope: maintenanceReportReviewScope,
      })
      setClaimPacketResult(result)
      toast.success(result.proposal_id ? t('workspace_ui.memories.claim_packet_created') : t('workspace_ui.memories.claim_artifact_created'))
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setClaimPacketCreating(false)
    }
  }

  function resetMaintenanceCursor() {
    setMaintenanceCursor('')
    setMaintenanceNextCursor(null)
  }


  return (
    <div className="p-6 space-y-6">
      {/* Page header */}
      <div className="flex items-center gap-4 pb-4 border-b border-border">
        <div
          className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
          style={{
            background: 'color-mix(in oklch, var(--primary) 12%, transparent)',
            border: '1px solid color-mix(in oklch, var(--primary) 35%, transparent)',
          }}
        >
          <Activity className="size-5 text-accent-foreground" />
        </div>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t('workspace_ui.memories.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('workspace_ui.memories.subtitle')}</p>
          <p className="text-xs text-muted-foreground">{t('workspace_ui.memories.viewing', { space: activeSpaceName ?? activeSpaceId ?? t('workspace_ui.memories.no_space') })}</p>
          {projectFilter && (
            <span className="inline-flex items-center gap-1 mt-0.5 px-2 py-0.5 rounded-full bg-accent/40 text-xs text-accent-foreground">
              <FolderKanban className="size-3" />
              {t('workspace_ui.memories.filtered_by_project')}
              <button onClick={() => setSearchParams(p => { p.delete('project_id'); return p })} className="ml-0.5 hover:text-foreground" aria-label={t('workspace_ui.memories.clear_project_filter')}>
                <X className="size-3" />
              </button>
            </span>
          )}
        </div>
      </div>

      <Card>
        <CardTitle>{t('workspace_ui.memories.propose_title')}</CardTitle>
        <div className="grid grid-cols-2 gap-3 mb-3">
          <div>
            <Label>{t('workspace_ui.memories.field_title')}</Label>
            <Input value={form.title} onChange={e => setField('title', e.target.value)} placeholder={t('workspace_ui.memories.title_placeholder')} />
          </div>
          <div>
            <Label>{t('workspace_ui.memories.field_type')}</Label>
            <Select
              value={form.type}
              options={TYPES.map(type => ({ value: type, label: type }))}
              onChange={v => setField('type', v as MemoryType)}
            />
          </div>
          <div>
            <Label>{t('workspace_ui.memories.field_namespace')}</Label>
            <Input value={form.namespace} onChange={e => setField('namespace', e.target.value)} />
          </div>
        </div>
        <div className="mb-3">
          <Label>{t('workspace_ui.memories.field_content')}</Label>
          <Textarea value={form.content} onChange={e => setField('content', e.target.value)} placeholder={t('workspace_ui.memories.content_placeholder')} />
        </div>
        <Button onClick={addMemory} disabled={!activeSpaceId}>{t('workspace_ui.memories.submit_proposal')}</Button>
      </Card>

      <Card>
        <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 rounded-md border border-border bg-muted/30 p-2">
              <Wrench className="size-4 text-accent-foreground" />
            </div>
            <div>
              <CardTitle>{t('workspace_ui.memories.maintenance_title')}</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                {t('workspace_ui.memories.maintenance_description')}
              </p>
              {projectFilter && <p className="mt-1 text-xs text-muted-foreground">{t('workspace_ui.memories.project_filter_active', { project: projectFilter })}</p>}
              {!spaceOpsReviewAllowed && (
                <p className="mt-1 text-xs text-muted-foreground">{t('workspace_ui.memories.space_ops_disabled')}</p>
              )}
            </div>
          </div>
          <div className="grid gap-2 md:grid-cols-[90px_90px_90px_90px_120px_minmax(180px,1fr)_130px_auto]">
            <NumberField label={t('workspace_ui.memories.field_limit')} value={maintenanceLimit} onChange={setMaintenanceLimit} />
            <NumberField label={t('workspace_ui.memories.field_stale_days')} value={staleAfterDays} onChange={setStaleAfterDays} />
            <NumberField label={t('workspace_ui.memories.field_thin_chars')} value={thinContentChars} onChange={setThinContentChars} />
            <NumberField label={t('workspace_ui.memories.field_max_findings')} value={maxFindings} onChange={setMaxFindings} />
            <div className="space-y-1">
              <Label className="text-xs">{t('workspace_ui.memories.field_scan')}</Label>
              <Select
                value={maintenanceScanMode}
                options={[
                  { value: 'recent', label: t('workspace_ui.memories.scan_recent') },
                  { value: 'full', label: t('workspace_ui.memories.scan_full') },
                ]}
                onChange={value => {
                  setMaintenanceScanMode(value as 'recent' | 'full')
                  resetMaintenanceCursor()
                }}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('workspace_ui.memories.field_cursor')}</Label>
              <Input
                value={maintenanceCursor}
                onChange={event => setMaintenanceCursor(event.target.value)}
                disabled={maintenanceScanMode !== 'full'}
                className="font-mono text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('workspace_ui.memories.field_review')}</Label>
              <Select
                value={maintenanceReviewScope}
                options={[
                  { value: 'private', label: t('workspace_ui.memories.review_private') },
                  ...(spaceOpsReviewAllowed ? [{ value: 'space_ops', label: t('workspace_ui.memories.review_space_ops') }] : []),
                ]}
                onChange={value => {
                  if (value === 'space_ops' && !spaceOpsReviewAllowed) {
                    toast.error(t('workspace_ui.memories.space_ops_disabled_toast'))
                    setMaintenanceReviewScope('private')
                    return
                  }
                  setMaintenanceReviewScope(value as 'private' | 'space_ops')
                }}
              />
            </div>
            <div className="space-y-2 self-end">
              <label className="flex h-9 items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={createMaintenancePacket}
                  onChange={event => setCreateMaintenancePacket(event.target.checked)}
                  className="accent-primary"
                />
                {t('workspace_ui.memories.create_packet')}
              </label>
              <Button size="sm" onClick={() => void runMaintenanceScan()} disabled={maintenanceRunning || !activeSpaceId}>
                {maintenanceRunning ? <Loader2 className="size-3.5 animate-spin" /> : <FileText className="size-3.5" />}
                {t('workspace_ui.memories.scan')}
              </Button>
            </div>
          </div>
        </div>
        {maintenanceReport && (
          <div className="mt-4 space-y-3">
            <div className="flex flex-wrap gap-3 text-sm">
              <Badge variant="secondary">{t('workspace_ui.memories.scanned', { count: maintenanceReport.scanned })}</Badge>
              <Badge variant={maintenanceReport.truncated ? 'warning' : 'success'}>
                {maintenanceReport.truncated ? t('workspace_ui.memories.truncated') : t('workspace_ui.memories.complete')}
              </Badge>
              {maintenanceReport.scan_mode && <Badge variant="outline">{maintenanceReport.scan_mode}</Badge>}
              {Object.entries(maintenanceReport.counts).map(([kind, count]) => (
                <Badge key={kind} variant={count > 0 ? 'warning' : 'muted'}>{kind}: {count}</Badge>
              ))}
            </div>
            <div className="flex flex-wrap gap-3 text-xs">
              {maintenanceNextCursor && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void runMaintenanceScan(maintenanceNextCursor)}
                  disabled={maintenanceRunning || maintenanceScanMode !== 'full'}
                >
                  <ChevronRight className="size-3.5" />
                  {t('workspace_ui.memories.continue_scan')}
                </Button>
              )}
              {maintenanceReport.artifact_id && (
                <Link to={`/artifacts/${maintenanceReport.artifact_id}`} className="text-accent-foreground hover:underline">
                  {t('workspace_ui.memories.open_report')}
                </Link>
              )}
              {maintenanceReport.proposal_id && (
                <Link to={`/proposals/${maintenanceReport.proposal_id}`} className="text-accent-foreground hover:underline">
                  {t('workspace_ui.memories.open_packet')}
                </Link>
              )}
              {maintenanceReport.artifact_id && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={createClaimCandidatePacket}
                  disabled={claimPacketCreating}
                >
                  {claimPacketCreating ? <Loader2 className="size-3.5 animate-spin" /> : <PackageCheck className="size-3.5" />}
                  {t('workspace_ui.memories.claim_packet')}
                </Button>
              )}
              {claimPacketResult && (
                <>
                  <Link to={`/artifacts/${claimPacketResult.artifact_id}`} className="text-accent-foreground hover:underline">
                    {t('workspace_ui.memories.open_claim_artifact')}
                  </Link>
                  <Link to={`/proposals/${claimPacketResult.proposal_id}`} className="text-accent-foreground hover:underline">
                    {t('workspace_ui.memories.open_claim_proposal')}
                  </Link>
                </>
              )}
            </div>
            {maintenanceReport.findings.length > 0 && (
              <div className="space-y-2">
                {maintenanceReport.findings.length > 8 && (
                  <p className="text-xs text-muted-foreground">
                    {t('workspace_ui.memories.showing_findings', { count: maintenanceReport.findings.length })}
                  </p>
                )}
                <div className="divide-y divide-border rounded-md border border-border">
                  {maintenanceReport.findings.slice(0, 8).map((finding, index) => (
                    <div key={`${finding.kind}:${index}`} className="p-3 text-sm">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="secondary">{finding.kind}</Badge>
                        {finding.confidence_tier && <Badge variant="outline">{finding.confidence_tier}</Badge>}
                        {finding.proposed_action && (
                          <Badge variant="muted">{String(finding.proposed_action.proposal_type ?? 'review')}</Badge>
                        )}
                        <span className="text-muted-foreground">{finding.reason}</span>
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {finding.objects.map(object => object.title ?? object.object_id).join(', ')}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </Card>

      <Card>
        <div className="flex flex-col gap-3 mb-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="space-y-2">
            <CardTitle>
              {showingSearch
                ? t('workspace_ui.memories.search_results')
                : statusFilter === 'archived' ? t('workspace_ui.memories.archived_memories') : t('workspace_ui.memories.active_memories')}
              {' '}({showingSearch ? searchResults.length : memoryTotal})
            </CardTitle>
            {!showingSearch && (
              <div className="flex flex-wrap items-center gap-2 text-xs">
                {([
                  ['all', t('workspace_ui.memories.written_by_all')],
                  ['agent', t('workspace_ui.memories.written_by_agent')],
                  ['user', t('workspace_ui.memories.written_by_person')],
                ] as const).map(([value, label]) => (
                  <Button
                    key={value}
                    size="sm"
                    variant={writtenByFilter === value ? 'secondary' : 'ghost'}
                    onClick={() => setFilter('created_by', value === 'all' ? null : value)}
                  >
                    {label}
                  </Button>
                ))}
                <Button
                  size="sm"
                  variant={scopeFilter === 'agent' ? 'secondary' : 'ghost'}
                  onClick={() => setSearchParams(previous => {
                    if (scopeFilter === 'agent') {
                      previous.delete('scope')
                      previous.delete('agent_id')
                    } else {
                      previous.set('scope', 'agent')
                    }
                    return previous
                  })}
                  title={t('workspace_ui.memories.agent_memory_hint')}
                >
                  {t('workspace_ui.memories.agent_memory')}
                </Button>
                <div className="min-w-[180px]">
                  <Select
                    value={agentFilter}
                    options={[
                      { value: '', label: t('workspace_ui.memories.all_agents') },
                      ...agents.map(agent => ({ value: agent.id, label: agent.name })),
                    ]}
                    onChange={value => setSearchParams(previous => {
                      if (value) {
                        previous.set('agent_id', value)
                        previous.set('scope', 'agent')
                      } else {
                        previous.delete('agent_id')
                      }
                      return previous
                    })}
                    ariaLabel={t('workspace_ui.memories.filter_by_agent')}
                  />
                </div>
                <Button
                  size="sm"
                  variant={sinceFilter ? 'secondary' : 'ghost'}
                  onClick={() => setFilter(
                    'since',
                    sinceFilter ? null : new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString(),
                  )}
                >
                  {t('workspace_ui.memories.last_7_days')}
                </Button>
                <Button
                  size="sm"
                  variant={statusFilter === 'archived' ? 'secondary' : 'ghost'}
                  onClick={() => setFilter('status', statusFilter === 'archived' ? null : 'archived')}
                >
                  {t('workspace_ui.memories.archived_filter')}
                </Button>
                {([['session', sessionFilter], ['run', runFilter]] as const)
                  .filter(([, value]) => value)
                  .map(([key, value]) => (
                    <Badge key={key} variant="warning" className="gap-1">
                      {key === 'session' ? t('workspace_ui.memories.session_chip', { id: value.slice(0, 8) }) : t('workspace_ui.memories.turn_chip', { id: value.slice(0, 8) })}
                      <button
                        type="button"
                        onClick={() => setFilter(key, null)}
                        aria-label={key === 'session' ? t('workspace_ui.memories.clear_session_filter') : t('workspace_ui.memories.clear_run_filter')}
                      >
                        <X className="size-3" />
                      </button>
                    </Badge>
                  ))}
              </div>
            )}
          </div>
          <form
            className="flex gap-2 w-full lg:w-auto"
            onSubmit={e => {
              e.preventDefault()
              void runSearch()
            }}
          >
            <Input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={t('workspace_ui.memories.search_placeholder')}
              className="min-w-0 lg:w-72"
            />
            <Button type="submit" variant="outline" disabled={!activeSpaceId || searching}>
              <Search className="size-4" /> {t('workspace_ui.memories.search')}
            </Button>
            {showingSearch && (
              <Button type="button" variant="ghost" onClick={clearSearch}>
                <X className="size-4" /> {t('workspace_ui.memories.clear')}
              </Button>
            )}
          </form>
        </div>
        {(showingSearch ? searchResults.length : memories.length) === 0
          ? <p className="text-muted-foreground text-center py-10 text-sm">
              {activeSpaceId
                ? showingSearch ? t('workspace_ui.memories.no_search_results') : statusFilter === 'archived' ? t('workspace_ui.memories.no_archived') : t('workspace_ui.memories.no_active')
                : t('workspace_ui.memories.no_space_browse')}
            </p>
          : showingSearch ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('workspace_ui.memories.col_title')}</TableHead><TableHead>{t('workspace_ui.memories.col_evidence')}</TableHead>
                  <TableHead>{t('workspace_ui.memories.col_score')}</TableHead><TableHead>{t('workspace_ui.memories.col_matched')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {searchResults.map(result => (
                  <TableRow key={`${result.object_type}:${result.object_id}`}>
                    <TableCell className="max-w-[420px]">
                      <Link
                        to={`/memory/${result.object_id}`}
                        onClick={() => recordSearchOpen(result)}
                        className="font-medium text-accent-foreground hover:underline"
                      >
                        {result.title || t('workspace_ui.memories.untitled')}
                      </Link>
                      {result.object_profile_label && (
                        <div className="mt-1">
                          <Badge variant="secondary">{result.object_profile_label}</Badge>
                        </div>
                      )}
                      {result.snippet && <p className="text-xs text-muted-foreground truncate mt-0.5">{result.snippet}</p>}
                    </TableCell>
                    <TableCell><Badge variant="secondary">{result.evidence.kind}</Badge></TableCell>
                    <TableCell className="text-muted-foreground">{formatNumber(result.score, { minimumFractionDigits: 4, maximumFractionDigits: 4 })}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{result.matched_fields.join(', ') || '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('workspace_ui.memories.col_title')}</TableHead><TableHead>{t('workspace_ui.memories.col_type')}</TableHead>
                  <TableHead>{t('workspace_ui.memories.col_scope')}</TableHead><TableHead>{t('workspace_ui.memories.col_visibility')}</TableHead><TableHead>{t('workspace_ui.memories.col_namespace')}</TableHead>
                  <TableHead>{t('workspace_ui.memories.col_importance')}</TableHead><TableHead>{t('workspace_ui.memories.col_created')}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {memories.map(m => (
                  <TableRow key={m.id}>
                    <TableCell className="max-w-[220px]">
                      <Link
                        to={`/memory/${m.id}`}
                        className="font-medium text-accent-foreground hover:underline"
                      >
                        {m.title || t('workspace_ui.memories.untitled')}
                      </Link>
                      {m.created_by?.startsWith('agent:') && (
                        <Badge variant="outline" className="ml-2">
                          {agents.find(agent => agent.id === m.agent_id)?.name ?? t('workspace_ui.memories.agent_fallback')}
                        </Badge>
                      )}
                      {m.content && <p className="text-xs text-muted-foreground truncate mt-0.5">{m.content}</p>}
                    </TableCell>
                    <TableCell><Badge variant="secondary">{m.type}</Badge></TableCell>
                    <TableCell className="text-muted-foreground">
                      {m.scope}
                      {m.scope === 'agent' && (
                        // Where it may go back to. A persona has no origin
                        // Room and reaches every conversation this Agent is
                        // in; a note reaches only an audience its Room already
                        // contained (ADR 0003 §4).
                        <span className="block text-xs">
                          {m.type === 'persona'
                            ? t('workspace_ui.memories.reach_everywhere')
                            : m.origin_room_id
                              ? t('workspace_ui.memories.reach_one_room')
                              : t('workspace_ui.memories.reach_direct_only')}
                        </span>
                      )}
                    </TableCell>
                    <TableCell><ScopeBadge visibility={m.visibility} /></TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{m.namespace ?? '—'}</TableCell>
                    <TableCell className="text-muted-foreground">{formatNumber(m.importance, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</TableCell>
                    <TableCell className="text-muted-foreground text-xs">{fmt(m.created_at)}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      {m.status === 'archived'
                        // Only the owner's own: restore has no proposal
                        // fallback the way archive does, so offering it on
                        // someone else's entry is a button that only 404s.
                        ? (m.owner_user_id === currentUser?.id
                          ? <Button variant="outline" size="sm" onClick={() => restoreMemory(m.id)}>{t('workspace_ui.memories.restore')}</Button>
                          : null)
                        : m.type === 'persona' && m.supersedes_memory_id && m.owner_user_id === currentUser?.id
                          // An Agent must have some persona, so the reversal
                          // is one action: retire this version, bring back the
                          // one it replaced.
                          ? <Button variant="outline" size="sm" onClick={() => revertMemory(m.id)}>{t('workspace_ui.memories.undo_change')}</Button>
                          : <Button variant="destructive" size="sm" onClick={() => deleteMemory(m.id)} aria-label={t('workspace_ui.memories.archive_aria', { title: m.title || t('workspace_ui.memories.untitled') })} title={t('workspace_ui.memories.archive')}>×</Button>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        {!showingSearch && (
          <Pagination className="mt-3" total={memoryTotal} limit={MEMORY_PAGE_SIZE} offset={memoryOffset} onChange={setMemoryOffset} />
        )}
      </Card>
    </div>
  )
}

/** A 200 from DELETE carries the archived entry; a 202 carries a proposal. */
function isMemory(result: Memory | Proposal): result is Memory {
  return 'content' in result && 'namespace' in result
}

function positiveInt(value: string, fallback: number): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function NumberField(props: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{props.label}</Label>
      <Input
        value={props.value}
        onChange={event => props.onChange(event.target.value)}
        inputMode="numeric"
      />
    </div>
  )
}
