import { FormEvent, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { sourcesApi } from '../../api/client'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { Input } from '../../components/ui/input'
import { Select } from '../../components/ui/select'
import { errMsg } from '../../lib/utils'
import { ArxivCategoryPicker } from './ArxivCategoryPicker'
import { ScheduleRuleFields } from './ScheduleRuleFields'
import {
  CAPTURE_POLICIES,
  FREQUENCIES,
  scheduleRuleFromForm,
  type ScheduleFormValue,
} from './sourcePageModel'
import type { SourceCapturePolicy, SourceChannel, SourceProvider, SourceProviderCategoryGroup, SourceQueryPreview } from '../../types/api'

type ArxivSourceMode = 'search' | 'category' | 'all'

const ARXIV_SOURCE_MODE_OPTIONS = [
  { value: 'search', label: 'Topic search' },
  { value: 'category', label: 'Category stream' },
  { value: 'all', label: 'All arXiv papers' },
]

const DEFAULT_SCHEDULE: ScheduleFormValue = { minute: '0', hour: '9', weekday: '1' }

function supportsSearch(provider: SourceProvider | undefined) {
  return provider?.capabilities.search === true
}

function defaultMonitorName(providerKey: string, mode: ArxivSourceMode, query: string, categories: string[]) {
  if (providerKey === 'arxiv') {
    if (mode === 'all') return 'All arXiv papers'
    if (mode === 'category') return categories.length ? categories.join(', ') : 'Category stream'
  }
  return query.trim() || 'New monitor'
}

interface SourceMonitorDialogProps {
  open: boolean
  mode: 'source' | 'monitor'
  providers: SourceProvider[]
  categoryGroups: readonly SourceProviderCategoryGroup[]
  sourceName?: string
  providerKey?: string
  /** The Source a new monitor is added to; without it the server picks one by provider. */
  sourceConnectionId?: string
  monitor?: SourceChannel | null
  onOpenChange: (open: boolean) => void
  onCreated?: (channel: SourceChannel) => Promise<void> | void
  onSaved: () => Promise<void>
}

/**
 * Query and scheduling belong to a Monitor. The source mode only adds the
 * origin metadata needed to create the first monitor atomically.
 */
function SourceMonitorDialogContent({
  open,
  mode,
  providers,
  categoryGroups,
  sourceName: initialSourceName,
  providerKey: initialProviderKey,
  sourceConnectionId,
  monitor,
  onOpenChange,
  onCreated,
  onSaved,
}: SourceMonitorDialogProps) {
  const [providerKey, setProviderKey] = useState(initialProviderKey ?? '')
  const [sourceName, setSourceName] = useState(initialSourceName ?? '')
  const [monitorName, setMonitorName] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [categories, setCategories] = useState<string[]>([])
  const [arxivMode, setArxivMode] = useState<ArxivSourceMode>('search')
  const [endpointUrl, setEndpointUrl] = useState('')
  const [frequency, setFrequency] = useState<'manual' | 'hourly' | 'daily' | 'weekly'>('daily')
  const [schedule, setSchedule] = useState<ScheduleFormValue>(DEFAULT_SCHEDULE)
  const [capturePolicy, setCapturePolicy] = useState<SourceCapturePolicy>('extract_text')
  const [saving, setSaving] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [preview, setPreview] = useState<SourceQueryPreview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)

  const provider = providers.find(item => item.provider_key === providerKey)
  const searchMode = supportsSearch(provider)
  const isArxiv = provider?.provider_key === 'arxiv'
  const editing = Boolean(monitor)
  // A search monitor's compiled query is versioned on the server and cannot be
  // edited in place; editing changes only its name and schedule.
  const queryLocked = editing && searchMode

  useEffect(() => {
    if (!open) return
    const nextProviderKey = monitor?.provider.key ?? initialProviderKey ?? providers[0]?.provider_key ?? ''
    const nextProvider = providers.find(item => item.provider_key === nextProviderKey)
    const nextCategories = monitor && Array.isArray(monitor.query.categories)
      ? monitor.query.categories.map(String)
      : []
    const nextMode: ArxivSourceMode = monitor?.query.mode === 'all'
      ? 'all'
      : monitor?.query.mode === 'recent_by_category'
        ? 'category'
        : 'search'
    setProviderKey(nextProviderKey)
    setSourceName(monitor?.source_name ?? initialSourceName ?? nextProvider?.display_name ?? '')
    setMonitorName(monitor?.name ?? '')
    setSearchQuery(String(monitor?.query.search_query ?? ''))
    setCategories(nextCategories)
    setArxivMode(nextMode)
    setEndpointUrl(monitor?.endpoint_url ?? '')
    setFrequency(monitor?.fetch_frequency ?? 'daily')
    setSchedule(scheduleFormValueFromRule(monitor?.schedule_rule))
    setCapturePolicy(monitor?.capture_policy ?? 'extract_text')
    setPreview(null)
    setPreviewError(null)
  }, [initialProviderKey, initialSourceName, monitor, open, providers])

  useEffect(() => {
    if (!provider) return
    if (!sourceName.trim()) setSourceName(provider.display_name)
  }, [provider, sourceName])

  function currentQuery(): Record<string, unknown> {
    if (!searchMode) return {}
    if (!isArxiv) return { mode: 'search', search_query: searchQuery.trim() }
    if (arxivMode === 'all') return { mode: 'all' }
    if (arxivMode === 'category') return { mode: 'recent_by_category', categories }
    return { mode: 'search', search_query: searchQuery.trim() }
  }

  async function testQuery() {
    if (!provider || !isArxiv) return
    if (arxivMode === 'search' && !searchQuery.trim()) {
      setPreview(null)
      setPreviewError('Enter a search query before testing it.')
      return
    }
    if (arxivMode === 'category' && categories.length === 0) {
      setPreview(null)
      setPreviewError('Select at least one arXiv category before testing it.')
      return
    }
    setPreviewing(true)
    setPreview(null)
    setPreviewError(null)
    try {
      setPreview(await sourcesApi.previewQuery({ provider_key: provider.provider_key, query: currentQuery(), ...(monitor ? { source_channel_id: monitor.id } : {}) }))
    } catch (error) {
      setPreviewError(errMsg(error))
    } finally {
      setPreviewing(false)
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!providerKey || !provider) return
    if (mode === 'source' && !sourceName.trim()) {
      toast.error('Enter a source name')
      return
    }
    if (queryLocked) {
      // The versioned query is not resubmitted.
    } else if (searchMode) {
      if (isArxiv && arxivMode === 'search' && !searchQuery.trim()) {
        toast.error('Enter a search query')
        return
      }
      if (isArxiv && arxivMode === 'category' && categories.length === 0) {
        toast.error('Select at least one arXiv category')
        return
      }
      if (!isArxiv && !searchQuery.trim()) {
        toast.error('Enter a search query')
        return
      }
    } else if (!endpointUrl.trim()) {
      toast.error('Enter a source URL')
      return
    }

    const query = currentQuery()
    const resolvedMonitorName = monitorName.trim() || defaultMonitorName(providerKey, arxivMode, searchQuery, categories)
    const scheduleRule = scheduleRuleFromForm(frequency, schedule)
    if (scheduleRule === undefined) {
      toast.error('Choose a valid update time')
      return
    }

    setSaving(true)
    try {
      if (editing && monitor) {
        await sourcesApi.updateChannel(monitor.id, {
          name: resolvedMonitorName,
          ...(searchMode ? {} : { query, endpoint_url: endpointUrl.trim() }),
          fetch_frequency: frequency,
          schedule_rule: scheduleRule,
          ...(mode === 'source' ? { source_name: sourceName.trim() } : {}),
        })
      } else {
        const created = await sourcesApi.createChannel({
          provider_key: providerKey,
          source_name: sourceName.trim() || provider.display_name,
          name: resolvedMonitorName,
          query,
          ...(searchMode ? {} : { endpoint_url: endpointUrl.trim() }),
          fetch_frequency: frequency,
          ...(scheduleRule ? { schedule_rule: scheduleRule } : {}),
          ...(mode === 'source' ? { capture_policy: capturePolicy } : {}),
          ...(mode === 'monitor' && sourceConnectionId ? { source_connection_id: sourceConnectionId } : {}),
        })
        await onCreated?.(created)
      }
      onOpenChange(false)
      toast.success(editing ? 'Monitor updated' : mode === 'source' ? 'Source created' : 'Monitor created')
      await onSaved()
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{editing ? 'Edit monitor' : mode === 'source' ? 'Add source' : 'Add monitor'}</DialogTitle>
        <DialogDescription>
          {mode === 'source'
            ? onCreated
              ? 'Add a reusable source origin and its first monitor. It will also be linked to the current project.'
              : 'Add a reusable source origin and its first monitor. Project linking is a separate action.'
            : `Define how ${sourceName || 'this source'} should be monitored.`}
        </DialogDescription>
      </DialogHeader>
      <form onSubmit={submit} className="space-y-5">
          {mode === 'source' ? (
            <section className="space-y-3 rounded-lg border border-border p-4">
              <div>
                <h2 className="text-sm font-semibold">Source</h2>
                <p className="mt-1 text-xs text-muted-foreground">The external origin. Query and schedule are configured below as a monitor.</p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1 text-sm">
                  <span>Source platform</span>
                  <Select options={providers.map(item => ({ value: item.provider_key, label: item.display_name }))} value={providerKey} onChange={setProviderKey} ariaLabel="Source platform" />
                </label>
                <label className="space-y-1 text-sm">
                  <span>Source name</span>
                  <Input value={sourceName} onChange={event => setSourceName(event.target.value)} placeholder={provider?.display_name ?? 'Academic sources'} />
                </label>
                <label className="space-y-1 text-sm">
                  <span>Capture policy</span>
                  <Select options={CAPTURE_POLICIES} value={capturePolicy} onChange={value => setCapturePolicy(value as SourceCapturePolicy)} ariaLabel="Capture policy" />
                </label>
              </div>
            </section>
          ) : (
            <div className="flex items-center justify-between rounded-lg border border-border bg-muted/30 px-4 py-3">
              <div>
                <p className="text-xs text-muted-foreground">Source</p>
                <p className="text-sm font-medium">{sourceName}</p>
              </div>
              <Badge variant="outline">{provider?.display_name ?? providerKey}</Badge>
            </div>
          )}

          <section className="space-y-3 rounded-lg border border-border p-4">
            <div>
              <h2 className="text-sm font-semibold">Monitor</h2>
              <p className="mt-1 text-xs text-muted-foreground">A monitor is a saved search or feed rule with its own schedule.</p>
            </div>
            <label className="block space-y-1 text-sm">
              <span>Monitor name</span>
              <Input value={monitorName} onChange={event => setMonitorName(event.target.value)} placeholder={isArxiv ? 'Agent memory' : 'Research updates'} />
            </label>

            {queryLocked ? (
              <div className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
                This monitor's query is fixed. Create a new monitor to search for something else.
              </div>
            ) : searchMode ? (
              <>
                {isArxiv && (
                  <label className="block space-y-1 text-sm">
                    <span>Search scope</span>
                    <Select options={ARXIV_SOURCE_MODE_OPTIONS} value={arxivMode} onChange={value => setArxivMode(value as ArxivSourceMode)} ariaLabel="Search scope" />
                  </label>
                )}
                {(!isArxiv || arxivMode === 'search') && (
                  <label className="block space-y-1 text-sm">
                    <span>Search query <span className="text-muted-foreground">(Topic search only)</span></span>
                    <Input value={searchQuery} onChange={event => { setSearchQuery(event.target.value); setPreview(null); setPreviewError(null) }} placeholder={'e.g. all:"agent memory"'} autoFocus />
                    <span className="text-xs text-muted-foreground">
                      {isArxiv
                        ? 'Plain keywords are automatically searched across all fields. Use field prefixes (ti:, abs:, cat:, ...) for a more precise query.'
                        : `Use the query syntax supported by ${provider?.display_name ?? 'this provider'}.`}
                    </span>
                  </label>
                )}
                {isArxiv && arxivMode === 'category' && (
                  <div className="block space-y-1 text-sm">
                    <span>Categories</span>
                    <ArxivCategoryPicker groups={categoryGroups} value={categories} onChange={setCategories} />
                    <span className="text-xs text-muted-foreground">The monitor follows new papers in the selected categories.</span>
                  </div>
                )}
                {isArxiv && arxivMode === 'all' && (
                  <div className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">This monitor follows the complete arXiv stream. Use a topic or category monitor for a focused research direction.</div>
                )}
                {isArxiv && (
                  <div className="rounded-md border border-border bg-muted/20 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="text-sm font-medium">Test this query</p>
                        <p className="text-xs text-muted-foreground">Runs one bounded preview without saving the monitor.</p>
                      </div>
                      <Button type="button" size="sm" variant="outline" disabled={previewing} onClick={() => void testQuery()}>{previewing ? 'Testing…' : 'Test query'}</Button>
                    </div>
                    {previewError && <p role="alert" className="mt-2 text-xs text-destructive">{previewError}</p>}
                    {preview && (
                      <div className="mt-3 text-xs">
                        <p className="font-medium">Approximately {preview.approximate_hit_count.toLocaleString()} matches</p>
                        {preview.approximate_hit_count === 0 ? (
                          <p className="mt-1 text-muted-foreground">Try broader keywords, verify field prefixes such as ti:/abs:/cat:, and check any date range before saving.</p>
                        ) : (
                          <ul className="mt-2 space-y-1 text-muted-foreground">{preview.samples.slice(0, 3).map((sample, index) => <li key={`${sample.source_uri ?? index}:${sample.title}`}>• {sample.title}</li>)}</ul>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </>
            ) : (
              <label className="block space-y-1 text-sm">
                <span>Source URL</span>
                <Input type="url" value={endpointUrl} onChange={event => setEndpointUrl(event.target.value)} placeholder="https://example.com/feed.xml" autoFocus />
                <span className="text-xs text-muted-foreground">This monitor checks the URL for new content on the schedule below.</span>
              </label>
            )}

            <label className="block space-y-1 text-sm">
              <span>Update frequency</span>
              <Select options={FREQUENCIES} value={frequency} onChange={value => setFrequency(value as typeof frequency)} ariaLabel="Update frequency" />
            </label>
            <ScheduleRuleFields fetchFrequency={frequency} value={schedule} onChange={setSchedule} />
          </section>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={saving || !provider}>{saving ? 'Saving…' : editing ? 'Save monitor' : mode === 'source' ? 'Create source' : 'Create monitor'}</Button>
          </DialogFooter>
      </form>
    </>
  )
}

function scheduleFormValueFromRule(rule: SourceChannel['schedule_rule'] | undefined): ScheduleFormValue {
  if (!rule || typeof rule !== 'object') return { ...DEFAULT_SCHEDULE }
  const minute = validSchedulePart(rule.minute, 0, 59) ? String(rule.minute) : DEFAULT_SCHEDULE.minute
  if (rule.frequency === 'hourly') return { ...DEFAULT_SCHEDULE, minute }

  if (
    (rule.frequency === 'daily' || rule.frequency === 'weekly')
      && validSchedulePart(rule.hour, 0, 23)
      && (rule.frequency !== 'weekly' || validSchedulePart(rule.weekday, 1, 7))
  ) {
    const nextUtcOccurrence = new Date()
    nextUtcOccurrence.setUTCSeconds(0, 0)
    nextUtcOccurrence.setUTCHours(rule.hour, Number(minute), 0, 0)
    if (rule.frequency === 'weekly') {
      const currentWeekday = nextUtcOccurrence.getUTCDay() || 7
      nextUtcOccurrence.setUTCDate(nextUtcOccurrence.getUTCDate() + ((Number(rule.weekday) - currentWeekday + 7) % 7))
    }
    return {
      minute: String(nextUtcOccurrence.getMinutes()),
      hour: String(nextUtcOccurrence.getHours()),
      weekday: rule.frequency === 'weekly' ? String(nextUtcOccurrence.getDay() || 7) : DEFAULT_SCHEDULE.weekday,
    }
  }
  return { ...DEFAULT_SCHEDULE, minute }
}

function validSchedulePart(value: unknown, min: number, max: number): value is number {
  return Number.isInteger(value) && Number(value) >= min && Number(value) <= max
}

export function SourceMonitorDialog(props: SourceMonitorDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-w-2xl overflow-visible">
        <SourceMonitorDialogContent {...props} />
      </DialogContent>
    </Dialog>
  )
}
