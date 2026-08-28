import { useState, useEffect, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { SpaceLink as Link } from '../../core/spaceNav'
import { Activity, ChevronRight, FileText, FolderKanban, Loader2, PackageCheck, Search, Wrench, X } from 'lucide-react'
import { toast } from 'sonner'
import { knowledgeApi, memoryApi, spacesApi } from '../../api/client'
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

const TYPES:  MemoryType[]  = ['preference', 'semantic', 'episodic', 'procedural', 'project']
function fmt(dt: string | null | undefined) { return dt ? new Date(dt).toLocaleString() : '—' }

interface MemoryForm {
  title: string
  content: string
  type: MemoryType
  namespace: string
}

const EMPTY_FORM: MemoryForm = {
  title: '', content: '', type: 'semantic', namespace: 'user.default',
}

export default function MemoriesPage() {
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
  // "Since I last looked" (ADR 0003 §3). A stamped instant rather than a
  // rolling window, so the list does not shift under the person while they
  // are reading it.
  const sinceFilter = searchParams.get('since') ?? ''
  const statusFilter = searchParams.get('status') ?? 'active'

  const [memories, setMemories] = useState<Memory[]>([])
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

  const load = useCallback(async () => {
    if (!activeSpaceId) {
      setMemories([])
      return
    }
    try {
      setMemories((await memoryApi.list({
        status: statusFilter,
        project_id: projectFilter || undefined,
        created_by: writtenByFilter === 'all' ? undefined : writtenByFilter,
        since: sinceFilter || undefined,
        session: sessionFilter || undefined,
        run: runFilter || undefined,
      })).items)
    }
    catch (e) { toast.error(errMsg(e)) }
  }, [projectFilter, activeSpaceId, statusFilter, writtenByFilter, sessionFilter, runFilter, sinceFilter])

  useEffect(() => { load() }, [load])

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
      toast.error('Select an operational space before searching memory')
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
      toast.error('Select an operational space before proposing memory')
      return
    }
    if (!form.title.trim() || !form.content.trim()) {
      toast.error('Title and content required'); return
    }
    try {
      await memoryApi.create({
        ...form,
        project_id: projectFilter || null,
      })
      setForm(EMPTY_FORM)
      toast.success('Memory proposal submitted')
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
      toast(isMemory(result) ? 'Archived' : 'Archive proposal submitted')
      await load()
    } catch (e) { toast.error(errMsg(e)) }
  }

  async function restoreMemory(id: string) {
    try {
      await memoryApi.restore(id)
      toast('Restored')
      await load()
    } catch (e) { toast.error(errMsg(e)) }
  }

  async function runMaintenanceScan(cursorOverride?: string | null) {
    if (!activeSpaceId) {
      toast.error('Select an operational space before scanning memory')
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
      toast.success(report.proposal_id ? 'Memory maintenance report and packet created' : 'Memory maintenance report created')
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setMaintenanceRunning(false)
    }
  }

  async function createClaimCandidatePacket() {
    if (!maintenanceReport?.artifact_id) {
      toast.error('Create a persisted maintenance report first')
      return
    }
    setClaimPacketCreating(true)
    try {
      const result = await knowledgeApi.claimCandidatePacket({
        source_artifact_ids: [maintenanceReport.artifact_id],
        review_scope: maintenanceReportReviewScope,
      })
      setClaimPacketResult(result)
      toast.success(result.proposal_id ? 'Claim candidate packet created' : 'Claim candidate packet artifact created')
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
          <h1 className="text-xl font-semibold tracking-tight">Memories</h1>
          <p className="text-sm text-muted-foreground">Review-gated personal and project memories.</p>
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

      <Card>
        <CardTitle>Propose memory</CardTitle>
        <div className="grid grid-cols-2 gap-3 mb-3">
          <div>
            <Label>Title</Label>
            <Input value={form.title} onChange={e => setField('title', e.target.value)} placeholder="Short title…" />
          </div>
          <div>
            <Label>Type</Label>
            <Select
              value={form.type}
              options={TYPES.map(t => ({ value: t, label: t }))}
              onChange={v => setField('type', v as MemoryType)}
            />
          </div>
          <div>
            <Label>Namespace</Label>
            <Input value={form.namespace} onChange={e => setField('namespace', e.target.value)} />
          </div>
        </div>
        <div className="mb-3">
          <Label>Content</Label>
          <Textarea value={form.content} onChange={e => setField('content', e.target.value)} placeholder="Memory content…" />
        </div>
        <Button onClick={addMemory} disabled={!activeSpaceId}>Submit proposal</Button>
      </Card>

      <Card>
        <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 rounded-md border border-border bg-muted/30 p-2">
              <Wrench className="size-4 text-accent-foreground" />
            </div>
            <div>
              <CardTitle>Memory Maintenance</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                Scan visible memories for duplicate, stale, thin, lifecycle, project/source-policy, archived-state, and deterministic contradiction findings.
                Recent scans sample the newest window; full scans continue by cursor.
              </p>
              {projectFilter && <p className="mt-1 text-xs text-muted-foreground">Project filter active: {projectFilter}</p>}
              {!spaceOpsReviewAllowed && (
                <p className="mt-1 text-xs text-muted-foreground">space_ops review is disabled by retrieval settings; scans will create private reports.</p>
              )}
            </div>
          </div>
          <div className="grid gap-2 md:grid-cols-[90px_90px_90px_90px_120px_minmax(180px,1fr)_130px_auto]">
            <NumberField label="limit" value={maintenanceLimit} onChange={setMaintenanceLimit} />
            <NumberField label="stale days" value={staleAfterDays} onChange={setStaleAfterDays} />
            <NumberField label="thin chars" value={thinContentChars} onChange={setThinContentChars} />
            <NumberField label="max findings" value={maxFindings} onChange={setMaxFindings} />
            <div className="space-y-1">
              <Label className="text-xs">scan</Label>
              <Select
                value={maintenanceScanMode}
                options={[
                  { value: 'recent', label: 'recent' },
                  { value: 'full', label: 'full' },
                ]}
                onChange={value => {
                  setMaintenanceScanMode(value as 'recent' | 'full')
                  resetMaintenanceCursor()
                }}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">cursor</Label>
              <Input
                value={maintenanceCursor}
                onChange={event => setMaintenanceCursor(event.target.value)}
                disabled={maintenanceScanMode !== 'full'}
                className="font-mono text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">review</Label>
              <Select
                value={maintenanceReviewScope}
                options={[
                  { value: 'private', label: 'private' },
                  ...(spaceOpsReviewAllowed ? [{ value: 'space_ops', label: 'space_ops' }] : []),
                ]}
                onChange={value => {
                  if (value === 'space_ops' && !spaceOpsReviewAllowed) {
                    toast.error('space_ops review is disabled in retrieval settings')
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
                create packet
              </label>
              <Button size="sm" onClick={() => void runMaintenanceScan()} disabled={maintenanceRunning || !activeSpaceId}>
                {maintenanceRunning ? <Loader2 className="size-3.5 animate-spin" /> : <FileText className="size-3.5" />}
                Scan
              </Button>
            </div>
          </div>
        </div>
        {maintenanceReport && (
          <div className="mt-4 space-y-3">
            <div className="flex flex-wrap gap-3 text-sm">
              <Badge variant="secondary">{maintenanceReport.scanned} scanned</Badge>
              <Badge variant={maintenanceReport.truncated ? 'warning' : 'success'}>
                {maintenanceReport.truncated ? 'truncated' : 'complete'}
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
                  Continue full scan
                </Button>
              )}
              {maintenanceReport.artifact_id && (
                <Link to={`/artifacts/${maintenanceReport.artifact_id}`} className="text-accent-foreground hover:underline">
                  Open maintenance report
                </Link>
              )}
              {maintenanceReport.proposal_id && (
                <Link to={`/proposals/${maintenanceReport.proposal_id}`} className="text-accent-foreground hover:underline">
                  Open maintenance packet
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
                  Claim packet
                </Button>
              )}
              {claimPacketResult && (
                <>
                  <Link to={`/artifacts/${claimPacketResult.artifact_id}`} className="text-accent-foreground hover:underline">
                    Open claim packet artifact
                  </Link>
                  <Link to={`/proposals/${claimPacketResult.proposal_id}`} className="text-accent-foreground hover:underline">
                    Open claim packet proposal
                  </Link>
                </>
              )}
            </div>
            {maintenanceReport.findings.length > 0 && (
              <div className="space-y-2">
                {maintenanceReport.findings.length > 8 && (
                  <p className="text-xs text-muted-foreground">
                    Showing first 8 of {maintenanceReport.findings.length} findings. Open the report artifact for the full list.
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
                ? 'Search Results'
                : statusFilter === 'archived' ? 'Archived Memories' : 'Active Memories'}
              {' '}({showingSearch ? searchResults.length : memories.length})
            </CardTitle>
            {!showingSearch && (
              <div className="flex flex-wrap items-center gap-2 text-xs">
                {([
                  ['all', 'Everyone'],
                  ['agent', 'Written by an Agent'],
                  ['user', 'Written by a person'],
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
                  variant={sinceFilter ? 'secondary' : 'ghost'}
                  onClick={() => setFilter(
                    'since',
                    sinceFilter ? null : new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString(),
                  )}
                >
                  Last 7 days
                </Button>
                <Button
                  size="sm"
                  variant={statusFilter === 'archived' ? 'secondary' : 'ghost'}
                  onClick={() => setFilter('status', statusFilter === 'archived' ? null : 'archived')}
                >
                  Archived
                </Button>
                {([['session', sessionFilter], ['run', runFilter]] as const)
                  .filter(([, value]) => value)
                  .map(([key, value]) => (
                    <Badge key={key} variant="warning" className="gap-1">
                      {key === 'session' ? 'Session' : 'Turn'} {value.slice(0, 8)}
                      <button
                        type="button"
                        onClick={() => setFilter(key, null)}
                        aria-label={`Clear ${key} filter`}
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
              placeholder="Search memory…"
              className="min-w-0 lg:w-72"
            />
            <Button type="submit" variant="outline" disabled={!activeSpaceId || searching}>
              <Search className="size-4" /> Search
            </Button>
            {showingSearch && (
              <Button type="button" variant="ghost" onClick={clearSearch}>
                <X className="size-4" /> Clear
              </Button>
            )}
          </form>
        </div>
        {(showingSearch ? searchResults.length : memories.length) === 0
          ? <p className="text-muted-foreground text-center py-10 text-sm">
              {activeSpaceId
                ? showingSearch ? 'No memories matched this search.' : 'No active memories.'
                : 'Select an operational space to browse memories.'}
            </p>
          : showingSearch ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead><TableHead>Evidence</TableHead>
                  <TableHead>Score</TableHead><TableHead>Matched</TableHead>
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
                        {result.title || 'Untitled memory'}
                      </Link>
                      {result.object_profile_label && (
                        <div className="mt-1">
                          <Badge variant="secondary">{result.object_profile_label}</Badge>
                        </div>
                      )}
                      {result.snippet && <p className="text-xs text-muted-foreground truncate mt-0.5">{result.snippet}</p>}
                    </TableCell>
                    <TableCell><Badge variant="secondary">{result.evidence.kind}</Badge></TableCell>
                    <TableCell className="text-muted-foreground">{result.score.toFixed(4)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{result.matched_fields.join(', ') || '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead><TableHead>Type</TableHead>
                  <TableHead>Scope</TableHead><TableHead>Visibility</TableHead><TableHead>Namespace</TableHead>
                  <TableHead>Imp.</TableHead><TableHead>Created</TableHead>
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
                        {m.title || 'Untitled memory'}
                      </Link>
                      {m.created_by?.startsWith('agent:') && (
                        <Badge variant="outline" className="ml-2">Agent</Badge>
                      )}
                      {m.content && <p className="text-xs text-muted-foreground truncate mt-0.5">{m.content}</p>}
                    </TableCell>
                    <TableCell><Badge variant="secondary">{m.type}</Badge></TableCell>
                    <TableCell className="text-muted-foreground">{m.scope}</TableCell>
                    <TableCell><ScopeBadge visibility={m.visibility} /></TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{m.namespace ?? '—'}</TableCell>
                    <TableCell className="text-muted-foreground">{m.importance.toFixed(1)}</TableCell>
                    <TableCell className="text-muted-foreground text-xs">{fmt(m.created_at)}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      {m.status === 'archived'
                        // Only the owner's own: restore has no proposal
                        // fallback the way archive does, so offering it on
                        // someone else's entry is a button that only 404s.
                        ? (m.owner_user_id === currentUser?.id
                          ? <Button variant="outline" size="sm" onClick={() => restoreMemory(m.id)}>Restore</Button>
                          : null)
                        : <Button variant="destructive" size="sm" onClick={() => deleteMemory(m.id)}>×</Button>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
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
