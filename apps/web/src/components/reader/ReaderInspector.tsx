import { useAppTranslation } from '../../i18n'
import { useState, type RefObject } from 'react'
import { toast } from 'sonner'
import { readerApi } from '../../api/client'
import { errMsg } from '../../lib/utils'
import type { ReaderAnnotation, ReaderCommentThread } from '../../types/api'
import type { TextSelection } from '../../components/editor/ReadOnlyTiptapReader'
import { Button } from '../../components/ui/button'
import { Badge } from '../../components/ui/badge'
import { Card } from '../../components/ui/card'
import { Input } from '../../components/ui/input'
import { Textarea } from '../../components/ui/textarea'
import {
  X, MessageSquare, Bookmark, Quote, Highlighter,
  Lock, Globe, Lightbulb, Brain, Trash2, Copy,
} from 'lucide-react'
import { copyText } from './readerClipboard'
import { annotationCountsByType, openThreadCount, type ReaderAnnotationsStatus, type ReaderAnnotationType, type ReaderThreadsStatus } from './readerModel'

const TYPE_ICONS: Record<ReaderAnnotationType, typeof Highlighter> = {
  highlight: Highlighter,
  comment: MessageSquare,
  excerpt: Quote,
  bookmark: Bookmark,
}

interface ReaderInspectorProps {
  /** Active annotations in document order. */
  annotations: ReaderAnnotation[]
  /** Loading/failure of the annotation list; the counts and notebook are not shown as empty meanwhile. */
  annotationsStatus?: ReaderAnnotationsStatus
  selection: TextSelection | null
  selectedAnnotation: ReaderAnnotation | null
  threads: ReaderCommentThread[]
  /** Loading/failure of the selected annotation's threads; never shown as "no comments". */
  threadsStatus?: ReaderThreadsStatus
  /** Annotations with an unsent comment kept for this document. */
  draftAnnotationIds?: ReadonlySet<string>
  /** Annotations that cannot be placed in the current document; kept and listed, not painted. */
  unlocatedAnnotationIds?: ReadonlySet<string>
  createLabel: string
  onCreateLabelChange: (label: string) => void
  commentInputRef: RefObject<HTMLTextAreaElement | null>
  /** The selected annotation's unsent comment, owned by the workspace. */
  commentDraft: string
  onCommentDraftChange: (value: string) => void
  commentPending: boolean
  onSubmitComment: () => void
  onSelectAnnotation: (annotation: ReaderAnnotation) => void
  /** Archives on the server; the workspace decides whether the list may still change. */
  onArchiveAnnotation: (annotationId: string) => Promise<void>
  onAdjustRange?: (annotation: ReaderAnnotation) => void
  /** Resolves or reopens a thread of the selected annotation; the workspace coordinates it with other writes. */
  onSetThreadStatus: (threadId: string, status: 'open' | 'resolved') => Promise<void>
  onClose: () => void
  /** Laid over the text because the Reader is too narrow to dock it beside. */
  overlay?: boolean
}

/** Notebook filters: every annotation, one type, or those not placed in this version. */
type NotebookFilter = 'all' | ReaderAnnotationType | 'unlocated'

export function ReaderInspector({
  annotations,
  annotationsStatus,
  selection,
  selectedAnnotation,
  threads,
  threadsStatus,
  draftAnnotationIds,
  unlocatedAnnotationIds,
  createLabel,
  onCreateLabelChange,
  commentInputRef,
  commentDraft,
  onCommentDraftChange,
  commentPending,
  onSubmitComment,
  onSelectAnnotation,
  onArchiveAnnotation,
  onAdjustRange,
  onSetThreadStatus,
  onClose,
  overlay = false,
}: ReaderInspectorProps) {
  const { t } = useAppTranslation()
  const [archiving, setArchiving] = useState(false)
  const [actioning, setActioning] = useState(false)
  // One status change per thread at a time; a second click cannot race the first.
  const [threadPending, setThreadPending] = useState<Record<string, boolean>>({})
  const [filter, setFilter] = useState<NotebookFilter>('all')
  const draftCount = annotations.filter(item => draftAnnotationIds?.has(item.id)).length
  const unlocatedCount = annotations.filter(item => unlocatedAnnotationIds?.has(item.id)).length

  const counts = annotationCountsByType(annotations)
  const filters: Array<{ value: NotebookFilter; count: number }> = [
    { value: 'all', count: annotations.length },
    ...(['highlight', 'comment', 'excerpt', 'bookmark'] as const).map(value => ({ value, count: counts[value] })).filter(item => item.count > 0),
    ...(unlocatedCount > 0 ? [{ value: 'unlocated' as const, count: unlocatedCount }] : []),
  ]
  // A filter whose annotations are all gone falls back to everything.
  const activeFilter = filters.some(item => item.value === filter) ? filter : 'all'
  const shown = annotations.filter(item => activeFilter === 'all' || (activeFilter === 'unlocated' ? unlocatedAnnotationIds?.has(item.id) : item.annotation_type === activeFilter))
  const openThreads = openThreadCount(threads)

  async function archiveAnnotation() {
    if (!selectedAnnotation) return
    setArchiving(true)
    try {
      // The workspace confirms the removal and offers Undo.
      await onArchiveAnnotation(selectedAnnotation.id)
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setArchiving(false)
    }
  }

  async function setThreadStatus(threadId: string, status: 'open' | 'resolved') {
    if (!selectedAnnotation || threadPending[threadId]) return
    setThreadPending(current => ({ ...current, [threadId]: true }))
    try {
      await onSetThreadStatus(threadId, status)
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setThreadPending(current => { const { [threadId]: _done, ...rest } = current; return rest })
    }
  }

  async function createEvidence() {
    if (!selectedAnnotation) return
    setActioning(true)
    try {
      await readerApi.createEvidence(selectedAnnotation.id, {})
      toast.success(t('reading.evidenceCreated'))
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setActioning(false)
    }
  }

  async function createProposal(proposalType: 'memory_create' | 'knowledge_create') {
    if (!selectedAnnotation) return
    setActioning(true)
    try {
      await readerApi.createProposal(selectedAnnotation.id, { proposal_type: proposalType })
      toast.success(proposalType === 'memory_create' ? t('reading.memoryProposed') : t('reading.knowledgeProposed'))
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setActioning(false)
    }
  }

  return (
    <aside className={`reader-inspector${overlay ? ' reader-inspector-overlay' : ''} border-l border-border bg-background flex flex-col h-full overflow-y-auto`} aria-label={t('reading.inspectorRegion')}>
      {/* Sticky so the drawer can always be closed; keeps the mobile close
          control clear of Shell’s floating capture action. */}
      <div className="sticky top-0 z-10 flex items-center justify-between bg-background pl-3 pr-20 md:pr-3 py-2 border-b border-border shrink-0">
        <div className="min-w-0">
          <p className="text-sm font-medium">{t('reading.inspector')}</p>
          <p className="text-xs text-muted-foreground">
            {annotationsStatus ? t(annotationsStatus.state === 'loading' ? 'reading.annotationsLoading' : 'reading.annotationsFailed') : t('reading.annotationCount', { count: annotations.length })}
            {selectedAnnotation && <> · {t('reading.openThreadCount', { count: openThreads })}</>}
          </p>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label={t('reading.closeInspector')}>
          <X className="size-4" />
        </Button>
      </div>

      {/* Current selection */}
      {selection && !selectedAnnotation && (
        <section className="p-3 space-y-2 border-b border-border" aria-label={t('reading.currentSelection')}>
          <p className="text-xs font-medium text-muted-foreground">{t('reading.selection')}</p>
          <blockquote className="text-xs italic border-l-2 border-border pl-2 text-muted-foreground line-clamp-3">
            {selection.quoteText}
          </blockquote>
          <Input
            className="h-7 text-xs"
            placeholder={t('reading.optionalLabel')}
            value={createLabel}
            onChange={(e) => onCreateLabelChange(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            {t('reading.selectionHint')}
          </p>
        </section>
      )}

      {/* Selected annotation */}
      {selectedAnnotation && (
        <section className="p-3 space-y-3 border-b border-border" aria-label={t('reading.selectedAnnotation')}>
          <div className="flex items-start justify-between gap-2">
            <div className="space-y-1 min-w-0">
              <div className="flex gap-1 flex-wrap">
                <Badge variant="outline" className="text-xs">{t(`reading.${selectedAnnotation.annotation_type}`)}</Badge>
                <Badge variant={selectedAnnotation.visibility === 'private' ? 'secondary' : 'default'} className="text-xs">
                  {selectedAnnotation.visibility === 'private' ? <Lock className="size-2.5 mr-0.5" /> : <Globe className="size-2.5 mr-0.5" />}
                  {t(`reading.visibility_${selectedAnnotation.visibility}`, { defaultValue: selectedAnnotation.visibility })}
                </Badge>
                {selectedAnnotation.anchor_state === 'unverified' && (
                  <Badge variant="destructive" className="text-xs">{t('reading.unverifiedAnchor')}</Badge>
                )}
              </div>
              {selectedAnnotation.label && (
                <p className="text-xs font-medium">{selectedAnnotation.label}</p>
              )}
            </div>
            <div className="flex shrink-0 gap-0.5">
              {onAdjustRange && <Button variant="ghost" size="sm" onClick={() => onAdjustRange(selectedAnnotation)}>{t('reading.adjustRange')}</Button>}
              <Button variant="ghost" size="icon-sm" aria-label={t('reading.copyQuote')} title={t('reading.copyQuote')}
                onClick={() => void copyText(selectedAnnotation.quote_text).then(ok => ok ? toast.success(t('reading.copied')) : toast.error(t('reading.copyFailed')))}>
                <Copy className="size-3" />
              </Button>
              <Button
                variant="ghost" size="icon-sm"
                onClick={archiveAnnotation} disabled={archiving}
                aria-label={t('reading.removeAnnotation')} title={t('reading.removeAnnotation')}
              >
                <Trash2 className="size-3" />
              </Button>
            </div>
          </div>

          <blockquote className="text-xs italic border-l-2 border-border pl-2 text-muted-foreground line-clamp-4">
            {selectedAnnotation.quote_text}
          </blockquote>
          {unlocatedAnnotationIds?.has(selectedAnnotation.id) && (
            <p className="text-xs text-muted-foreground">{t('reading.unlocatedDetail')}</p>
          )}

          {/* Comments */}
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">{t('reading.comments')}</p>
            {threadsStatus?.state === 'loading' && (
              <p role="status" className="text-xs text-muted-foreground">{t('reading.commentsLoading')}</p>
            )}
            {threadsStatus?.state === 'error' && (
              <div role="alert" className="space-y-2 rounded-md border border-destructive/40 p-2 text-xs">
                <p className="font-medium">{t('reading.commentsFailed')}</p>
                <p className="break-words text-muted-foreground">{errMsg(threadsStatus.error)}</p>
                <Button size="sm" variant="outline" onClick={threadsStatus.retry}>{t('reading.retry')}</Button>
              </div>
            )}
            {!threadsStatus && threads.length === 0 && (
              <p className="text-xs text-muted-foreground">{t('reading.noComments')}</p>
            )}
            {threads.map((thread) => (
              <Card key={thread.id} className="p-2 space-y-2">
                <div className="flex items-center justify-between">
                  <Badge variant="outline" className="text-xs">{t(`reading.thread_${thread.status}`)}</Badge>
                  <div className="flex gap-1">
                    {thread.status === 'open' && (
                      <Button variant="ghost" size="sm" disabled={threadPending[thread.id]}
                        onClick={() => setThreadStatus(thread.id, 'resolved')}>{t('reading.resolve')}</Button>
                    )}
                    {thread.status === 'resolved' && (
                      <Button variant="ghost" size="sm" disabled={threadPending[thread.id]}
                        onClick={() => setThreadStatus(thread.id, 'open')}>{t('reading.reopen')}</Button>
                    )}
                  </div>
                </div>
                {thread.comments.map((c) => (
                  <div key={c.id} className="text-xs space-y-0.5">
                    <p className="font-medium text-muted-foreground truncate">{c.created_by_user_id}</p>
                    <p className="whitespace-pre-wrap">{c.body}</p>
                  </div>
                ))}
              </Card>
            ))}
            <Textarea
              ref={commentInputRef}
              className="text-xs resize-none min-h-0"
              rows={2}
              placeholder={t('reading.addComment')}
              aria-label={t('reading.addComment')}
              value={commentDraft}
              onChange={(e) => onCommentDraftChange(e.target.value)}
            />
            <div className="flex gap-2">
              <Button size="sm" className="flex-1" onClick={onSubmitComment}
                disabled={!commentDraft.trim() || commentPending}>
                {commentPending ? t('reading.commentSaving') : t('reading.comment')}
              </Button>
              {/* Kept drafts are only ever discarded on purpose. */}
              {commentDraft.trim() && !commentPending && (
                <Button size="sm" variant="ghost" onClick={() => onCommentDraftChange('')}>{t('reading.discardDraft')}</Button>
              )}
            </div>
          </div>

          {/* Downstream actions */}
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">{t('reading.actions')}</p>
            <p className="text-xs text-muted-foreground">{t('reading.actionsHint')}</p>
            <div className="flex flex-col gap-1">
              <Button
                variant="outline" size="sm" className="h-7 text-xs justify-start"
                onClick={createEvidence} disabled={actioning}
              >
                <Quote className="size-3 mr-1.5" />{t('reading.saveEvidence')}
              </Button>
              <Button
                variant="outline" size="sm" className="h-7 text-xs justify-start"
                onClick={() => createProposal('knowledge_create')} disabled={actioning}
              >
                <Lightbulb className="size-3 mr-1.5" />{t('reading.proposeKnowledge')}
              </Button>
              <Button
                variant="outline" size="sm" className="h-7 text-xs justify-start"
                onClick={() => createProposal('memory_create')} disabled={actioning}
              >
                <Brain className="size-3 mr-1.5" />{t('reading.proposeMemory')}
              </Button>
            </div>
          </div>
        </section>
      )}

      {/* Notebook */}
      <section className="p-3 space-y-1 flex-1" aria-label={t('reading.notebookRegion')}>
        <p className="text-xs font-medium text-muted-foreground pb-1">{t('reading.notebook')}</p>
        {draftCount > 0 && (
          <p role="status" className="text-xs text-primary">{t('reading.unsentComments', { count: draftCount })}</p>
        )}
        {unlocatedCount > 0 && (
          <p role="status" className="rounded-md border border-warning/40 bg-warning/5 p-2 text-xs">{t('reading.unlocatedNotice', { count: unlocatedCount })}</p>
        )}
        {annotationsStatus?.state === 'loading' && (
          <p role="status" className="text-xs text-muted-foreground">{t('reading.annotationsLoading')}</p>
        )}
        {annotationsStatus?.state === 'error' && (
          <div role="alert" className="space-y-2 rounded-md border border-destructive/40 p-2 text-xs">
            <p className="font-medium">{t('reading.annotationsFailed')}</p>
            <p className="break-words text-muted-foreground">{errMsg(annotationsStatus.error)}</p>
            <Button size="sm" variant="outline" onClick={annotationsStatus.retry}>{t('reading.retry')}</Button>
          </div>
        )}
        {!annotationsStatus && annotations.length === 0 && (
          <p className="text-xs text-muted-foreground">
            {t('reading.notebookEmpty')}
          </p>
        )}
        {filters.length > 2 && (
          <div role="group" aria-label={t('reading.notebookFilter')} className="flex flex-wrap gap-1 pb-1">
            {filters.map(item => <button key={item.value} type="button" aria-pressed={activeFilter === item.value}
              className={`min-h-7 rounded-full border px-2 text-xs ${activeFilter === item.value ? 'border-primary bg-primary/12' : 'border-border text-muted-foreground hover:bg-accent'}`}
              onClick={() => setFilter(item.value)}>
              {t(item.value === 'all' ? 'reading.filterAll' : item.value === 'unlocated' ? 'reading.unlocated' : `reading.${item.value}`)} {item.count}
            </button>)}
          </div>
        )}
        {shown.map((ann) => {
          const Icon = TYPE_ICONS[ann.annotation_type]
          const isSelected = ann.id === selectedAnnotation?.id
          return (
            <button
              key={ann.id}
              type="button"
              onClick={() => onSelectAnnotation(ann)}
              className={`w-full text-left rounded-md border p-2 space-y-1 hover:bg-accent/50 transition-colors ${isSelected ? 'border-primary bg-accent/40' : 'border-transparent'}`}
            >
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Icon className="size-3 shrink-0" />
                <span>{t(`reading.${ann.annotation_type}`)}</span>
                {ann.visibility === 'private'
                  ? <Lock className="size-2.5 shrink-0" />
                  : <Globe className="size-2.5 shrink-0" />}
                {ann.anchor_state === 'unverified' && (
                  <Badge variant="destructive" className="text-xs px-1 py-0">{t('reading.unverified')}</Badge>
                )}
                {unlocatedAnnotationIds?.has(ann.id) && (
                  <Badge variant="outline" className="text-xs px-1 py-0">{t('reading.unlocated')}</Badge>
                )}
                {draftAnnotationIds?.has(ann.id) && (
                  <Badge variant="outline" className="text-xs px-1 py-0">{t('reading.unsentDraft')}</Badge>
                )}
              </div>
              <p className="text-xs line-clamp-2">{ann.quote_text}</p>
              {ann.label && <p className="text-xs text-muted-foreground truncate">{ann.label}</p>}
            </button>
          )
        })}
        <p className="sr-only" data-testid="annotation-type-counts">
          {t('reading.typeCounts', { highlights: counts.highlight, comments: counts.comment, excerpts: counts.excerpt, bookmarks: counts.bookmark })}
        </p>
      </section>
    </aside>
  )
}
