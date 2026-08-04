import { useState } from 'react'
import { toast } from 'sonner'
import { SpaceLink as Link } from '../../../core/spaceNav'
import { inquiryApi } from '../../../api/client'
import { errMsg } from '../../../lib/utils'
import type {
  InquiryEvidenceSignal, InquiryIteration, InquiryThread, InquiryThreadDetail, NoteSummary, ProjectCorpusItem,
} from '../../../types/api'
import { Badge } from '../../../components/ui/badge'
import { Button } from '../../../components/ui/button'
import { Select } from '../../../components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../components/ui/tabs'
import { eligiblePrimaryParents } from './threadGrouping'
import type { ThreadTabId } from './nextFocus'

const CLASSIFICATION_GROUPS: Array<{ ids: string[]; label: string; tone: string }> = [
  { ids: ['contradicts'], label: 'Challenges this position', tone: 'text-destructive' },
  { ids: ['raises_gap'], label: 'Raises a new gap', tone: 'text-amber-600' },
  { ids: ['fills_gap'], label: 'Fills a gap', tone: 'text-emerald-600' },
  { ids: ['supports'], label: 'Supports this position', tone: 'text-muted-foreground' },
  { ids: ['adds_context', 'adds_method'], label: 'Adds context or method', tone: 'text-muted-foreground' },
]

function corpusTitle(item: ProjectCorpusItem | undefined, fallbackId: string | null): string {
  return item?.source_item?.title
    ?? item?.object?.title
    ?? (fallbackId ? `Corpus item ${fallbackId.slice(0, 8)}` : 'Unlinked evidence')
}

function EvidenceTab({ signals, corpus, projectId }: {
  signals: InquiryEvidenceSignal[]
  corpus: Map<string, ProjectCorpusItem>
  projectId: string
}) {
  if (signals.length === 0) {
    return (
      <div className="space-y-2 py-4">
        <p className="text-sm text-muted-foreground">No evidence has been classified against this Thread yet.</p>
        <Button size="sm" variant="outline" asChild>
          <Link to={`/projects/${projectId}/research`}>Open the project Reading List</Link>
        </Button>
      </div>
    )
  }

  const grouped = CLASSIFICATION_GROUPS
    .map(group => ({ ...group, items: signals.filter(signal => group.ids.includes(signal.classification)) }))
    .filter(group => group.items.length > 0)

  return (
    <div className="space-y-4 py-2">
      {grouped.map(group => (
        <section key={group.label}>
          <p className={`mb-1.5 text-xs font-medium ${group.tone}`}>{group.label} ({group.items.length})</p>
          <div className="space-y-1">
            {group.items.map(signal => (
              <div key={signal.id} className="rounded-md border p-2">
                <p className="text-sm">{corpusTitle(corpus.get(signal.corpus_item_id ?? ''), signal.corpus_item_id)}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {signal.is_material ? 'Material · ' : ''}
                  {signal.confidence !== null ? `confidence ${Math.round(signal.confidence * 100)}% · ` : ''}
                  {signal.model_version ?? 'manual'} · {signal.status.replace(/_/g, ' ')}
                </p>
              </div>
            ))}
          </div>
        </section>
      ))}
      <p className="border-t pt-3 text-xs text-muted-foreground">
        Only classified evidence appears here.{' '}
        <Link className="underline" to={`/projects/${projectId}/research`}>See every retrieved item in the Reading List</Link>.
      </p>
    </div>
  )
}

function RelationsTab({ projectId, detail, allThreads, onChanged }: {
  projectId: string
  detail: InquiryThreadDetail
  allThreads: InquiryThread[]
  onChanged: () => Promise<void>
}) {
  const [relationTarget, setRelationTarget] = useState('')
  const [relationKind, setRelationKind] = useState('related_to')
  const [primaryParentId, setPrimaryParentId] = useState(detail.primary_parent_id ?? '')
  const byId = new Map(allThreads.map(thread => [thread.id, thread]))
  // Only the primary-parent tree must stay acyclic. A typed relation may point
  // at any other Thread, descendants included — `decomposes_into` pointing at
  // a sub-question is the ordinary case.
  const parentOptions = eligiblePrimaryParents(allThreads, detail.id)
  const relationTargets = allThreads.filter(thread => thread.id !== detail.id)
  const canAct = detail.lifecycle_status === 'active'

  async function addRelation() {
    if (!relationTarget) return
    try {
      await inquiryApi.addRelation(projectId, { from_thread_id: detail.id, to_thread_id: relationTarget, relation_kind: relationKind })
      setRelationTarget('')
      await onChanged()
    } catch (error) { toast.error(errMsg(error)) }
  }

  async function removeRelation(relationId: string) {
    try {
      await inquiryApi.removeRelation(projectId, relationId)
      await onChanged()
    } catch (error) { toast.error(errMsg(error)) }
  }

  async function savePrimaryParent(value: string) {
    setPrimaryParentId(value)
    try {
      await inquiryApi.setPrimaryParent(projectId, detail.id, value || null)
      await onChanged()
    } catch (error) { toast.error(errMsg(error)) }
  }

  return (
    <div className="space-y-4 py-2">
      <section>
        <p className="mb-1.5 text-xs font-medium text-muted-foreground">Sits under</p>
        <Select
          ariaLabel="Primary parent"
          value={primaryParentId}
          onChange={savePrimaryParent}
          options={[
            { value: '', label: 'No primary parent' },
            ...parentOptions.map(thread => ({ value: thread.id, label: thread.statement.slice(0, 60) })),
          ]}
        />
      </section>

      <section>
        <p className="mb-1.5 text-xs font-medium text-muted-foreground">Typed relations</p>
        {detail.relations.length === 0 && <p className="text-sm text-muted-foreground">No relations yet.</p>}
        <div className="space-y-1">
          {detail.relations.map(relation => {
            const outgoing = relation.from_thread_id === detail.id
            const other = byId.get(outgoing ? relation.to_thread_id : relation.from_thread_id)
            return (
              <div key={relation.id} className="flex items-center gap-2 rounded-md border p-2">
                <Badge variant="outline" className="shrink-0 text-[10px]">
                  {outgoing ? '→' : '←'} {relation.relation_kind.replace(/_/g, ' ')}
                </Badge>
                <p className="min-w-0 flex-1 truncate text-sm">{other?.statement ?? 'Thread outside this Project view'}</p>
                {canAct && <Button size="sm" variant="ghost" onClick={() => removeRelation(relation.id)}>Remove</Button>}
              </div>
            )
          })}
        </div>
        {canAct && relationTargets.length > 0 && (
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <Select ariaLabel="Relation kind" value={relationKind} onChange={setRelationKind} options={[
              { value: 'related_to', label: 'related to' }, { value: 'depends_on', label: 'depends on' },
              { value: 'supports', label: 'supports' }, { value: 'contradicts', label: 'contradicts' },
              { value: 'decomposes_into', label: 'decomposes into' }, { value: 'proposes', label: 'proposes' },
            ]} />
            <Select
              ariaLabel="Relation target"
              value={relationTarget}
              onChange={setRelationTarget}
              options={[
                { value: '', label: 'Select a Thread…' },
                ...relationTargets.map(thread => ({ value: thread.id, label: thread.statement.slice(0, 60) })),
              ]}
            />
            <Button size="sm" variant="outline" onClick={addRelation} disabled={!relationTarget}>Add relation</Button>
          </div>
        )}
      </section>
    </div>
  )
}

function NotesTab({ projectId, detail, notes, onChanged }: {
  projectId: string
  detail: InquiryThreadDetail
  notes: NoteSummary[]
  onChanged: () => Promise<void>
}) {
  const [noteObjectId, setNoteObjectId] = useState('')
  const canAct = detail.lifecycle_status === 'active'

  async function linkNote(value: string) {
    setNoteObjectId(value)
    if (!value) return
    try {
      await inquiryApi.linkNote(projectId, detail.id, value)
      setNoteObjectId('')
      await onChanged()
    } catch (error) { toast.error(errMsg(error)) }
  }

  async function unlinkNote(noteId: string) {
    try {
      await inquiryApi.unlinkNote(projectId, detail.id, noteId)
      await onChanged()
    } catch (error) { toast.error(errMsg(error)) }
  }

  return (
    <div className="space-y-4 py-2">
      <section>
        <p className="mb-1.5 text-xs font-medium text-muted-foreground">Linked notes</p>
        {detail.note_links.length === 0 && <p className="text-sm text-muted-foreground">No notes linked.</p>}
        <div className="space-y-1">
          {detail.note_links.map(link => (
            <div key={link.id} className="flex items-center gap-2 rounded-md border p-2">
              <p className="min-w-0 flex-1 truncate text-sm">
                {notes.find(note => note.id === link.note_object_id)?.title ?? 'Linked note'}
              </p>
              <Badge variant="outline" className="text-[10px]">{link.link_kind.replace(/_/g, ' ')}</Badge>
              {canAct && <Button size="sm" variant="ghost" onClick={() => unlinkNote(link.note_object_id)}>Unlink</Button>}
            </div>
          ))}
        </div>
        {canAct && (
          <div className="mt-2">
            <Select
              ariaLabel="Note to link"
              value={noteObjectId}
              onChange={linkNote}
              options={[
                { value: '', label: notes.length ? 'Link a Project note…' : 'No Project notes available' },
                ...notes.map(note => ({ value: note.id, label: note.title })),
              ]}
            />
          </div>
        )}
      </section>

      <section>
        <p className="mb-1.5 text-xs font-medium text-muted-foreground">Decisions referencing this Thread</p>
        {(detail.decision_cases?.length ?? 0) === 0
          ? <p className="text-sm text-muted-foreground">No Decision Cases reference this Thread.</p>
          : (
            <div className="space-y-1">
              {detail.decision_cases?.map(item => (
                <Link
                  key={item.id}
                  to={`/projects/${projectId}/decisions?open=${item.id}`}
                  className="flex items-center gap-2 rounded-md border p-2 hover:bg-muted/50"
                >
                  <span className="min-w-0 flex-1 truncate text-sm">{item.title}</span>
                  <Badge variant="outline" className="text-[10px]">{item.status}</Badge>
                </Link>
              ))}
            </div>
          )}
      </section>
    </div>
  )
}

function HistoryTab({ iterations }: { iterations: InquiryIteration[] }) {
  if (iterations.length === 0) return <p className="py-4 text-sm text-muted-foreground">No confirmed Iterations yet.</p>
  return (
    <div className="space-y-2 py-2">
      {iterations.map(iteration => (
        <div key={iteration.id} className="border-l-2 border-border py-1 pl-3">
          <p className="text-sm">{iteration.change_summary}</p>
          <p className="text-xs text-muted-foreground">
            {new Date(iteration.created_at).toLocaleString()}
            {iteration.confirmed_next_focus ? ` · next: ${iteration.confirmed_next_focus.replace(/_/g, ' ')}` : ''}
          </p>
        </div>
      ))}
    </div>
  )
}

export function ThreadTabs({ projectId, detail, allThreads, notes, signals, corpus, iterations, activeTab, onTabChange, onChanged }: {
  projectId: string
  detail: InquiryThreadDetail
  allThreads: InquiryThread[]
  notes: NoteSummary[]
  signals: InquiryEvidenceSignal[]
  corpus: Map<string, ProjectCorpusItem>
  iterations: InquiryIteration[]
  activeTab: ThreadTabId
  onTabChange: (tab: ThreadTabId) => void
  onChanged: () => Promise<void>
}) {
  return (
    <Tabs value={activeTab} onValueChange={value => onTabChange(value as ThreadTabId)}>
      <TabsList className="grid w-full grid-cols-4">
        <TabsTrigger value="evidence">Evidence{signals.length > 0 ? ` (${signals.length})` : ''}</TabsTrigger>
        <TabsTrigger value="relations">Relations{detail.relations.length > 0 ? ` (${detail.relations.length})` : ''}</TabsTrigger>
        <TabsTrigger value="notes">Notes &amp; decisions</TabsTrigger>
        <TabsTrigger value="history">History</TabsTrigger>
      </TabsList>
      <TabsContent value="evidence"><EvidenceTab signals={signals} corpus={corpus} projectId={projectId} /></TabsContent>
      <TabsContent value="relations"><RelationsTab projectId={projectId} detail={detail} allThreads={allThreads} onChanged={onChanged} /></TabsContent>
      <TabsContent value="notes"><NotesTab projectId={projectId} detail={detail} notes={notes} onChanged={onChanged} /></TabsContent>
      <TabsContent value="history"><HistoryTab iterations={iterations} /></TabsContent>
    </Tabs>
  )
}
