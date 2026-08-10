import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { notesApi, projectResearchApi, projectsApi, providersApi } from '../../../api/client'
import type { ResearchReadingList } from '../../../types/api'
import { Badge, StatusBadge } from '../../../components/ui/badge'
import { Button } from '../../../components/ui/button'
import { Card } from '../../../components/ui/card'
import { EmptyState } from '../../../components/ui/empty-state'
import { Input } from '../../../components/ui/input'
import { Select } from '../../../components/ui/select'
import { Textarea } from '../../../components/ui/textarea'
import { errMsg } from '../../../lib/utils'
import { SpaceLink as Link } from '../../../core/spaceNav'
import { defaultModelProvider } from '../../providers/defaultProvider'

type EvidenceCardDraft = { why_md: string; how_md: string; what_md: string }

export function ReadingListView({
  projectId,
  value,
  reload,
}: {
  projectId: string
  value: ResearchReadingList | null
  reload: () => Promise<void>
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [card, setCard] = useState<EvidenceCardDraft>({ why_md: '', how_md: '', what_md: '' })
  const [selected, setSelected] = useState<string[]>([])
  const [compareProvider, setCompareProvider] = useState('')
  const [comparing, setComparing] = useState(false)
  const [query, setQuery] = useState('')
  const [triage, setTriage] = useState('all')
  const [stance, setStance] = useState('all')
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [jotting, setJotting] = useState<string | null>(null)
  const [jotText, setJotText] = useState('')
  const [jotBusy, setJotBusy] = useState(false)
  // Object id → the note jotted against it, so a second jot appends to the
  // first rather than creating a second note about the same material.
  const [noteForObject, setNoteForObject] = useState<Record<string, string>>({})

  useEffect(() => {
    void providersApi.list()
      .then((rows) => setCompareProvider(defaultModelProvider(rows)?.id ?? ''))
      .catch(() => undefined)
  }, [])

  // Which materials already have a note, resolved from the recorded links rather
  // than from this session's state — otherwise reloading the page would offer
  // "Jot a note" again and produce a second note about the same material.
  useEffect(() => {
    const objectIds = (value?.items ?? []).map((row) => row.object_id).filter((id): id is string => Boolean(id))
    if (objectIds.length === 0) {
      setNoteForObject({})
      return
    }
    let cancelled = false
    void Promise.all(objectIds.map(async (objectId) => {
      const links = await notesApi.linkingTo(objectId).catch(() => [])
      return [objectId, links[0]?.source_id] as const
    })).then((pairs) => {
      if (cancelled) return
      setNoteForObject(Object.fromEntries(pairs.filter((pair): pair is readonly [string, string] => Boolean(pair[1]))))
    })
    return () => { cancelled = true }
  }, [value])

  const visible = useMemo(() => (value?.items ?? []).filter((row) => {
    const title = row.object?.title ?? row.source_item?.title ?? row.evidence?.title ?? ''
    if (query && !title.toLowerCase().includes(query.toLowerCase())) return false
    if (triage !== 'all' && row.triage_status !== triage) return false
    if (stance !== 'all' && row.evidence_card?.stance !== stance) return false
    return !unreadOnly || row.read_status === 'unread'
  }), [query, stance, triage, unreadOnly, value])

  async function updateState(id: string, body: Record<string, unknown>) {
    try {
      await projectsApi.updateCorpusItem(projectId, id, body)
      await reload()
    } catch (error) {
      toast.error(errMsg(error))
    }
  }

  async function saveJot(objectId: string, title: string) {
    setJotBusy(true)
    try {
      const note = await notesApi.jot({
        target_id: objectId,
        text: jotText.trim(),
        project_id: projectId,
        ...(noteForObject[objectId] ? { note_id: noteForObject[objectId] } : {}),
      })
      setNoteForObject((current) => ({ ...current, [objectId]: note.id }))
      setJotting(null)
      setJotText('')
      toast.success(`Note linked to ${title}`)
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setJotBusy(false)
    }
  }

  async function saveCard(sourceId: string) {
    try {
      await projectResearchApi.updateEvidenceCard(projectId, sourceId, card)
      setEditing(null)
      await reload()
    } catch (error) {
      toast.error(errMsg(error))
    }
  }

  async function compareSelected() {
    if (!selected.length || !compareProvider) return
    setComparing(true)
    try {
      const result = await projectResearchApi.askAi(projectId, {
        prompt: 'Compare the selected material and update the current understanding with agreements, contradictions, and methodological differences.',
        section_key: 'understanding',
        source_item_ids: selected,
        execution: { model_provider_id: compareProvider },
      })
      toast.success(`Comparison queued · run ${result.run_id.slice(0, 8)}`)
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setComparing(false)
    }
  }

  if (!value?.items.length) {
    return <EmptyState title="No material in the reading list" description="Collected Project material appears here after corpus sync." />
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_10rem_10rem_auto]">
        <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter material…" />
        <Select value={triage} onChange={setTriage} options={['all', 'new', 'relevant', 'maybe', 'included', 'excluded'].map((v) => ({ value: v, label: v }))} />
        <Select value={stance} onChange={setStance} options={['all', 'supports', 'contradicts', 'new_direction'].map((v) => ({ value: v, label: v.replace('_', ' ') }))} />
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={unreadOnly} onChange={(event) => setUnreadOnly(event.target.checked)} />Unread</label>
      </div>
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{selected.length} items selected</p>
        <Button size="sm" variant="outline" disabled={!selected.length || !compareProvider || comparing} onClick={() => void compareSelected()}>
          {comparing ? 'Queueing…' : 'Ask AI to compare'}
        </Button>
      </div>
      {visible.map((row) => {
        const title = row.object?.title ?? row.source_item?.title ?? row.evidence?.title ?? 'Untitled material'
        const sourceId = row.source_item_id
        return (
          <Card key={row.id} className="space-y-3 p-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div className="flex min-w-0 gap-3">
                {sourceId && <input type="checkbox" aria-label={`Select ${title}`} checked={selected.includes(sourceId)} onChange={(event) => setSelected(event.target.checked ? [...selected, sourceId] : selected.filter((id) => id !== sourceId))} />}
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button className="text-left font-medium hover:underline" onClick={() => setExpanded(expanded === row.id ? null : row.id)}>{title}</button>
                    <StatusBadge status={row.triage_status} />
                    {row.evidence_card?.stance && <Badge variant={row.evidence_card.stance === 'contradicts' ? 'destructive' : 'outline'}>{row.evidence_card.stance.replace('_', ' ')}</Badge>}
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{row.source_item?.excerpt ?? row.object?.summary ?? row.evidence?.content_excerpt}</p>
                </div>
              </div>
              <div className="grid shrink-0 grid-cols-2 gap-2">
                <Select value={row.triage_status} onChange={(v) => void updateState(row.id, { triage_status: v })} options={['new', 'relevant', 'maybe', 'included', 'excluded'].map((v) => ({ value: v, label: v }))} />
                <Select value={row.read_status} onChange={(v) => void updateState(row.id, { read_status: v })} options={['unread', 'skimmed', 'read', 'discussed'].map((v) => ({ value: v, label: v }))} />
              </div>
            </div>
            {row.evidence_card && editing !== row.id && (
              <div className="grid gap-2 text-sm md:grid-cols-3">
                <p><b>Why</b><br />{row.evidence_card.why_md || '—'}</p>
                <p><b>How</b><br />{row.evidence_card.how_md || '—'}</p>
                <p><b>What</b><br />{row.evidence_card.what_md || '—'}</p>
              </div>
            )}
            {expanded === row.id && (
              <div className="space-y-2 rounded bg-muted p-3 text-sm">
                <p>{row.source_item?.excerpt ?? row.object?.summary ?? row.evidence?.content_excerpt ?? 'No additional evidence preview is available.'}</p>
                {sourceId && <Link className="text-xs font-medium hover:underline" to={`/library/items/${sourceId}`}>Open in reader</Link>}
              </div>
            )}
            {sourceId && (editing === row.id ? (
              <div className="grid gap-2 md:grid-cols-3">
                <Textarea value={card.why_md} onChange={(event) => setCard((current) => ({ ...current, why_md: event.target.value }))} placeholder="Why it matters" />
                <Textarea value={card.how_md} onChange={(event) => setCard((current) => ({ ...current, how_md: event.target.value }))} placeholder="How it works" />
                <Textarea value={card.what_md} onChange={(event) => setCard((current) => ({ ...current, what_md: event.target.value }))} placeholder="What it found" />
                <div className="md:col-span-3"><Button size="sm" onClick={() => void saveCard(sourceId)}>Save evidence card</Button></div>
              </div>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => { setEditing(row.id); setCard({ why_md: row.evidence_card?.why_md ?? '', how_md: row.evidence_card?.how_md ?? '', what_md: row.evidence_card?.what_md ?? '' }) }}>
                {row.evidence_card ? 'Edit WHY / HOW / WHAT' : 'Add WHY / HOW / WHAT'}
              </Button>
            ))}
            {/* N7: jotting is only offered where there is something linkable.
                A corpus row targets exactly one of object / source_item /
                evidence, and only the object is a `space_objects` row — the
                other two cannot be a note_link endpoint. Material becomes one
                when it passes triage (R3), so the absence has a reason worth
                stating rather than an action that silently is not there. */}
            {!row.object_id && (
              <p className="text-xs text-muted-foreground">
                Notes attach once this has passed triage — mark it relevant to
                make it citable.
              </p>
            )}
            {row.object_id && (jotting === row.id ? (
              <div className="space-y-2">
                <Textarea
                  value={jotText}
                  onChange={(event) => setJotText(event.target.value)}
                  placeholder="What does this material tell you?"
                  aria-label={`Note about ${title}`}
                />
                <div className="flex items-center gap-2">
                  <Button size="sm" disabled={!jotText.trim() || jotBusy} onClick={() => void saveJot(row.object_id!, title)}>
                    {jotBusy ? 'Saving…' : 'Save note'}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => { setJotting(null); setJotText('') }}>Cancel</Button>
                  {noteForObject[row.object_id] && (
                    <span className="text-xs text-muted-foreground">Appends to the note you already started here.</span>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <Button size="sm" variant="ghost" onClick={() => { setJotting(row.id); setJotText('') }}>
                  {noteForObject[row.object_id] ? 'Add to note' : 'Jot a note'}
                </Button>
                {noteForObject[row.object_id] && (
                  <Link className="text-xs hover:underline" to={`/knowledge/notes/${noteForObject[row.object_id]}`}>Open note</Link>
                )}
              </div>
            ))}
          </Card>
        )
      })}
    </div>
  )
}
