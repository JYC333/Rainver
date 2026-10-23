import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Bot, RefreshCw } from 'lucide-react'
import type { AgentAttentionReadState, AgentAttentionQueryInput, AgentWorkItem } from '@rainver/protocol'
import { AgentAttentionGroupSchema } from '@rainver/protocol'
import { useSpace } from '../../contexts/SpaceContext'
import { useAppTranslation } from '../../i18n'
import { formatDateTime } from '../../i18n/format'
import { cn } from '../../lib/utils'
import { Button } from '../../components/ui/button'
import { DatePicker } from '../../components/ui/date-picker'
import { EmptyState } from '../../components/ui/empty-state'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { Select } from '../../components/ui/select'
import { Skeleton } from '../../components/ui/skeleton'
import { WorkDetail } from './WorkDetail'
import { WorkList } from './WorkList'
import { AttentionControls } from './AttentionIndicators'
import { useAttentionState } from './AgentAttentionProvider'
import { useAgentWorkList } from './useAgentWorkList'

export default function AgentWorkPage() {
  const { userId } = useSpace()
  return <AgentWorkPageContent key={userId} />
}

/** One labelled filter in the shared filter-bar layout used by Tasks and Runs. */
function Filter({ label, children }: { label: string; children: ReactNode }) {
  return <div className="flex min-w-[150px] flex-col gap-1"><Label className="mb-0">{label}</Label>{children}</div>
}

function AgentWorkPageContent() {
  const { t } = useAppTranslation()
  const { spaces } = useSpace()
  const [query, setQuery] = useState<AgentAttentionQueryInput>({ scope: 'mine', view: 'current' })
  const list = useAgentWorkList(query)
  const [projectDraft, setProjectDraft] = useState('')
  const [sinceDraft, setSinceDraft] = useState('')
  const [selected, setSelected] = useState<{ source: AgentWorkItem; open: number } | null>(null)
  const [detailRevision, setDetailRevision] = useState(0)
  const attention = useAttentionState()
  const lastVersion = useRef(attention.version)
  useEffect(() => {
    if (lastVersion.current && attention.version !== lastVersion.current && selected) setDetailRevision(value => value + 1)
    lastVersion.current = attention.version
  }, [attention.version, selected])
  const opens = useRef(0)
  const root = useRef<HTMLDivElement>(null)
  const listRoot = useRef<HTMLDivElement>(null)
  const detailRoot = useRef<HTMLElement>(null)
  const previousRow = useRef<HTMLButtonElement | null>(null)
  const returning = useRef(false)
  useEffect(() => {
    // Access recovery must not implicitly reopen a fresh reading lifetime.
    if (list.error === 'denied') setSelected(null)
  }, [list.error])
  useEffect(() => {
    if (!selected && returning.current) {
      returning.current = false
      previousRow.current?.focus({ preventScroll: true })
    }
  }, [selected])
  const filter = (next: AgentAttentionQueryInput) => {
    const value = { ...query, ...next }
    if (JSON.stringify(value) === JSON.stringify(query)) return
    setSelected(null)
    setQuery(value)
  }
  const readStateChanged = useCallback((state: AgentAttentionReadState) => {
    if (selected) list.update(selected.source.work_key, state)
  }, [selected, list.update])
  const close = useCallback(() => {
    returning.current = true
    setSelected(null)
  }, [])
  const changed = useCallback(() => { void list.refresh(); setDetailRevision(value => value + 1) }, [list.refresh])
  const unread = useCallback(() => {
    close()
    setSinceDraft('')
    setQuery(current => ({ ...current, view: 'current', since: undefined, until: undefined }))
    void list.refresh()
  }, [close, list.refresh])
  const keyboard = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement
    if (event.defaultPrevented || !root.current?.contains(target)) return
    if (target.closest('[role="dialog"],[role="menu"],[role="listbox"],[role="option"],[role="menuitem"]')) return
    if (target.closest('input,textarea,select,[contenteditable="true"],[role="textbox"],[aria-haspopup]') || event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const rows = [...(listRoot.current?.querySelectorAll<HTMLButtonElement>('[data-work-row]') ?? [])]
      if (!rows.length || detailRoot.current?.contains(target)) return
      const current = rows.indexOf(target as HTMLButtonElement)
      const next = Math.max(0, Math.min(rows.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)))
      event.preventDefault()
      rows[next].focus()
    } else if (event.key === 'r' && selected) {
      const editor = detailRoot.current?.querySelector<HTMLElement>('textarea,[contenteditable="true"]')
      if (editor) { event.preventDefault(); editor.focus() }
    } else if (event.key === 'u' && selected) {
      const button = detailRoot.current?.querySelector<HTMLButtonElement>('[data-work-unread]')
      if (button) { event.preventDefault(); button.click() }
    } else if (event.key === 'Escape' && selected) close()
  }
  const groupOptions = [{ value: '', label: t('agent_work.all_groups') }, ...AgentAttentionGroupSchema.options.map(group => ({ value: group, label: t(`agent_work.groups.${group}`) }))]
  return <div ref={root} className="flex h-full min-h-0 flex-col gap-4 p-6" onKeyDown={keyboard}>
    <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border pb-4">
      <div className="flex items-center gap-4">
        <div
          className="flex size-11 shrink-0 items-center justify-center rounded-xl"
          style={{
            background: 'color-mix(in oklch, var(--primary) 12%, transparent)',
            border: '1px solid color-mix(in oklch, var(--primary) 35%, transparent)',
          }}
        >
          <Bot className="size-5 text-accent-foreground" />
        </div>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t('agent_work.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('agent_work.subtitle')}</p>
          {list.page && <p className="text-xs text-muted-foreground">{t('agent_work.as_of', { time: formatDateTime(list.page.as_of) })}</p>}
        </div>
      </div>
      <Button size="sm" variant="outline" className="gap-1.5" disabled={list.loading} onClick={changed}>
        <RefreshCw className="size-3.5" />{t('agent_work.refresh')}
      </Button>
    </header>
    <AttentionControls />
    <div className="flex flex-wrap items-end gap-3">
      <Filter label={t('agent_work.scope')}>
        <Select ariaLabel={t('agent_work.scope')} value={query.scope ?? 'mine'} onChange={value => filter({ scope: value as 'mine' | 'all_visible' })}
          options={[{ value: 'mine', label: t('agent_work.mine') }, { value: 'all_visible', label: t('agent_work.all_visible') }]} />
      </Filter>
      <Filter label={t('agent_work.space')}>
        <Select ariaLabel={t('agent_work.space')} value={query.space_id ?? ''} onChange={value => { setProjectDraft(''); filter({ space_id: value || undefined, project_id: undefined }) }}
          options={[{ value: '', label: t('agent_work.all_spaces') }, ...spaces.map(space => ({ value: space.id, label: space.name }))]} />
      </Filter>
      <Filter label={t('agent_work.project_filter')}>
        <Input className="w-44" aria-label={t('agent_work.project_filter')} placeholder={t('agent_work.project_id')} value={projectDraft} onChange={event => setProjectDraft(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter') filter({ project_id: event.currentTarget.value.trim() || undefined }) }} onBlur={event => filter({ project_id: event.currentTarget.value.trim() || undefined })} />
      </Filter>
      <Filter label={t('agent_work.group')}>
        <Select ariaLabel={t('agent_work.group')} value={query.group ?? ''} onChange={value => filter({ group: value as AgentAttentionQueryInput['group'] || undefined })} options={groupOptions} />
      </Filter>
      <Filter label={t('agent_work.view')}>
        <Select ariaLabel={t('agent_work.view')} value={query.view ?? 'current'} onChange={value => { setSinceDraft(''); filter({ view: value as 'current' | 'history', since: undefined, until: undefined }) }}
          options={[{ value: 'current', label: t('agent_work.current') }, { value: 'history', label: t('agent_work.history') }]} />
      </Filter>
      {query.view === 'history' && <Filter label={t('agent_work.since')}>
        <DatePicker ariaLabel={t('agent_work.since')} value={sinceDraft} onChange={value => { setSinceDraft(value); filter({ since: value ? new Date(`${value}T00:00:00`).toISOString() : undefined }) }} />
      </Filter>}
    </div>
    {list.error && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{t(`agent_work.${list.error}`)}</p>}
    <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 md:grid-cols-[minmax(280px,36%)_minmax(0,1fr)]">
      <div ref={listRoot} role="region" aria-label={t('agent_work.list')} className={cn('min-h-0 overflow-auto rounded-lg border border-border bg-card', selected && 'hidden md:block')}>
        {!list.page && list.loading && <div role="status" aria-label={t('agent_work.loading')} className="space-y-3 p-3">
          <Skeleton className="h-20 w-full" /><Skeleton className="h-20 w-full" /><Skeleton className="h-20 w-full" />
        </div>}
        {list.page && <>
          {list.page.items.length === 0 && <EmptyState title={t('agent_work.empty')} />}
          <WorkList page={list.page} selectedKey={selected?.source.work_key} onOpen={source => {
            previousRow.current = document.activeElement instanceof HTMLButtonElement ? document.activeElement : null
            setSelected({ source, open: ++opens.current })
          }} />
          {list.page.next_cursor && <div className="p-3"><Button size="sm" variant="outline" disabled={list.loading} onClick={() => void list.refresh(list.page!.next_cursor!)}>{t('agent_work.load_more')}</Button></div>}
        </>}
      </div>
      <aside ref={detailRoot} className={cn('min-h-0 overflow-auto rounded-lg border border-border bg-card', !selected && 'hidden md:block')} aria-label={t('agent_work.detail')}>
        {selected && list.error !== 'denied'
          ? <WorkDetail key={selected.open} source={selected.source} revision={detailRevision} onClose={close} onUnread={unread} onChanged={changed} onReadState={readStateChanged} />
          : <EmptyState className="h-full" title={t(selected ? `agent_work.${list.error}` : 'agent_work.choose')} />}
      </aside>
    </div>
  </div>
}
