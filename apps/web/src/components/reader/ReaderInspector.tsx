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
  Lock, Globe, Lightbulb, Brain, Trash2,
} from 'lucide-react'
import { annotationCountsByType, openThreadCount, type ReaderAnnotationType } from './readerModel'

const TYPE_ICONS: Record<ReaderAnnotationType, typeof Highlighter> = {
  highlight: Highlighter,
  comment: MessageSquare,
  excerpt: Quote,
  bookmark: Bookmark,
}

interface ReaderInspectorProps {
  /** Active annotations in document order. */
  annotations: ReaderAnnotation[]
  selection: TextSelection | null
  selectedAnnotation: ReaderAnnotation | null
  threads: ReaderCommentThread[]
  createLabel: string
  onCreateLabelChange: (label: string) => void
  commentInputRef: RefObject<HTMLTextAreaElement | null>
  onSelectAnnotation: (annotation: ReaderAnnotation) => void
  onAnnotationArchived: (annotationId: string) => void
  /**
   * A change to the threads of `annotationId`, as an update over the current
   * list: the request it answers may complete after another thread change,
   * or after another annotation was selected, and the owner decides whether
   * the annotation is still the one on screen.
   */
  onThreadsUpdated: (annotationId: string, update: (current: ReaderCommentThread[]) => ReaderCommentThread[]) => void
  onClose: () => void
}

export function ReaderInspector({
  annotations,
  selection,
  selectedAnnotation,
  threads,
  createLabel,
  onCreateLabelChange,
  commentInputRef,
  onSelectAnnotation,
  onAnnotationArchived,
  onThreadsUpdated,
  onClose,
}: ReaderInspectorProps) {
  const { t } = useAppTranslation()
  const [archiving, setArchiving] = useState(false)
  const [commentBody, setCommentBody] = useState('')
  const [commenting, setCommenting] = useState(false)
  const [actioning, setActioning] = useState(false)

  const counts = annotationCountsByType(annotations)
  const openThreads = openThreadCount(threads)

  async function archiveAnnotation() {
    if (!selectedAnnotation) return
    setArchiving(true)
    try {
      await readerApi.deleteAnnotation(selectedAnnotation.id)
      onAnnotationArchived(selectedAnnotation.id)
      toast.success(t('reading.annotationRemoved'))
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setArchiving(false)
    }
  }

  async function addComment() {
    if (!selectedAnnotation || !commentBody.trim()) return
    const annotationId = selectedAnnotation.id
    setCommenting(true)
    try {
      const result = await readerApi.createComment(annotationId, { body: commentBody.trim() })
      onThreadsUpdated(annotationId, (current) => {
        const updated = current.map((t) => t.id === result.thread.id ? result.thread : t)
        if (!updated.find((t) => t.id === result.thread.id)) updated.push(result.thread)
        return updated
      })
      setCommentBody('')
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setCommenting(false)
    }
  }

  async function setThreadStatus(threadId: string, status: 'open' | 'resolved') {
    if (!selectedAnnotation) return
    const annotationId = selectedAnnotation.id
    try {
      const updated = await readerApi.updateThread(threadId, { status })
      onThreadsUpdated(annotationId, (current) => current.map((t) => t.id === threadId ? updated : t))
    } catch (e) {
      toast.error(errMsg(e))
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
    <aside className="reader-inspector border-l border-border bg-background flex flex-col h-full overflow-y-auto" aria-label={t('reading.inspectorRegion')}>
      {/* Keep the mobile close control clear of Shell’s floating capture action. */}
      <div className="flex items-center justify-between pl-3 pr-20 md:pr-3 py-2 border-b border-border shrink-0">
        <div className="min-w-0">
          <p className="text-sm font-medium">{t('reading.inspector')}</p>
          <p className="text-xs text-muted-foreground">
            {t('reading.annotationCount', { count: annotations.length })}
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
            <Button
              variant="ghost" size="icon-sm" className="shrink-0"
              onClick={archiveAnnotation} disabled={archiving}
              aria-label={t('reading.removeAnnotation')}
            >
              <Trash2 className="size-3" />
            </Button>
          </div>

          <blockquote className="text-xs italic border-l-2 border-border pl-2 text-muted-foreground line-clamp-4">
            {selectedAnnotation.quote_text}
          </blockquote>

          {/* Comments */}
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">{t('reading.comments')}</p>
            {threads.length === 0 && (
              <p className="text-xs text-muted-foreground">{t('reading.noComments')}</p>
            )}
            {threads.map((thread) => (
              <Card key={thread.id} className="p-2 space-y-2">
                <div className="flex items-center justify-between">
                  <Badge variant="outline" className="text-xs">{t(`reading.thread_${thread.status}`)}</Badge>
                  <div className="flex gap-1">
                    {thread.status === 'open' && (
                      <Button variant="ghost" size="sm"
                        onClick={() => setThreadStatus(thread.id, 'resolved')}>{t('reading.resolve')}</Button>
                    )}
                    {thread.status === 'resolved' && (
                      <Button variant="ghost" size="sm"
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
              value={commentBody}
              onChange={(e) => setCommentBody(e.target.value)}
            />
            <Button size="sm" className="w-full" onClick={addComment}
              disabled={!commentBody.trim() || commenting}>
              {t('reading.comment')}
            </Button>
          </div>

          {/* Downstream actions */}
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">{t('reading.actions')}</p>
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
        {annotations.length === 0 && (
          <p className="text-xs text-muted-foreground">
            {t('reading.notebookEmpty')}
          </p>
        )}
        {annotations.map((ann) => {
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
