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
  onThreadsUpdated: (threads: ReaderCommentThread[]) => void
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
      toast.success('Annotation removed')
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setArchiving(false)
    }
  }

  async function addComment() {
    if (!selectedAnnotation || !commentBody.trim()) return
    setCommenting(true)
    try {
      const result = await readerApi.createComment(selectedAnnotation.id, { body: commentBody.trim() })
      const updated = threads.map((t) => t.id === result.thread.id ? result.thread : t)
      if (!updated.find((t) => t.id === result.thread.id)) updated.push(result.thread)
      onThreadsUpdated(updated)
      setCommentBody('')
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setCommenting(false)
    }
  }

  async function setThreadStatus(threadId: string, status: 'open' | 'resolved') {
    try {
      const updated = await readerApi.updateThread(threadId, { status })
      onThreadsUpdated(threads.map((t) => t.id === threadId ? updated : t))
    } catch (e) {
      toast.error(errMsg(e))
    }
  }

  async function createEvidence() {
    if (!selectedAnnotation) return
    setActioning(true)
    try {
      await readerApi.createEvidence(selectedAnnotation.id, {})
      toast.success('Evidence candidate created')
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
      toast.success(proposalType === 'memory_create' ? 'Memory proposal created' : 'Knowledge proposal created')
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setActioning(false)
    }
  }

  return (
    <aside className="reader-inspector border-l bg-background flex flex-col h-full overflow-y-auto" aria-label="Reader inspector">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b shrink-0">
        <div className="min-w-0">
          <p className="text-sm font-medium">Inspector</p>
          <p className="text-xs text-muted-foreground">
            {annotations.length} annotation{annotations.length === 1 ? '' : 's'}
            {selectedAnnotation ? ` · ${openThreads} open thread${openThreads === 1 ? '' : 's'}` : ''}
          </p>
        </div>
        <Button variant="ghost" size="icon" className="size-6" onClick={onClose} aria-label="Close inspector">
          <X className="size-4" />
        </Button>
      </div>

      {/* Current selection */}
      {selection && !selectedAnnotation && (
        <section className="p-3 space-y-2 border-b" aria-label="Current selection">
          <p className="text-xs font-medium text-muted-foreground">Selection</p>
          <blockquote className="text-xs italic border-l-2 pl-2 text-muted-foreground line-clamp-3">
            {selection.quoteText}
          </blockquote>
          <Input
            className="h-7 text-xs"
            placeholder="Label (optional)"
            value={createLabel}
            onChange={(e) => onCreateLabelChange(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Use the toolbar over the selection to save a highlight, comment, excerpt, or bookmark.
          </p>
        </section>
      )}

      {/* Selected annotation */}
      {selectedAnnotation && (
        <section className="p-3 space-y-3 border-b" aria-label="Selected annotation">
          <div className="flex items-start justify-between gap-2">
            <div className="space-y-1 min-w-0">
              <div className="flex gap-1 flex-wrap">
                <Badge variant="outline" className="text-xs">{selectedAnnotation.annotation_type}</Badge>
                <Badge variant={selectedAnnotation.visibility === 'private' ? 'secondary' : 'default'} className="text-xs">
                  {selectedAnnotation.visibility === 'private' ? <Lock className="size-2.5 mr-0.5" /> : <Globe className="size-2.5 mr-0.5" />}
                  {selectedAnnotation.visibility}
                </Badge>
                {selectedAnnotation.anchor_state === 'unverified' && (
                  <Badge variant="destructive" className="text-xs">unverified anchor</Badge>
                )}
              </div>
              {selectedAnnotation.label && (
                <p className="text-xs font-medium">{selectedAnnotation.label}</p>
              )}
            </div>
            <Button
              variant="ghost" size="icon" className="size-6 shrink-0"
              onClick={archiveAnnotation} disabled={archiving}
              aria-label="Remove annotation"
            >
              <Trash2 className="size-3" />
            </Button>
          </div>

          <blockquote className="text-xs italic border-l-2 pl-2 text-muted-foreground line-clamp-4">
            {selectedAnnotation.quote_text}
          </blockquote>

          {/* Comments */}
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Comments</p>
            {threads.length === 0 && (
              <p className="text-xs text-muted-foreground">No comments yet.</p>
            )}
            {threads.map((thread) => (
              <Card key={thread.id} className="p-2 space-y-2">
                <div className="flex items-center justify-between">
                  <Badge variant="outline" className="text-xs">{thread.status}</Badge>
                  <div className="flex gap-1">
                    {thread.status === 'open' && (
                      <Button variant="ghost" size="sm" className="h-5 text-xs px-1"
                        onClick={() => setThreadStatus(thread.id, 'resolved')}>Resolve</Button>
                    )}
                    {thread.status === 'resolved' && (
                      <Button variant="ghost" size="sm" className="h-5 text-xs px-1"
                        onClick={() => setThreadStatus(thread.id, 'open')}>Reopen</Button>
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
              placeholder="Add a comment…"
              value={commentBody}
              onChange={(e) => setCommentBody(e.target.value)}
            />
            <Button size="sm" className="w-full" onClick={addComment}
              disabled={!commentBody.trim() || commenting}>
              Comment
            </Button>
          </div>

          {/* Downstream actions */}
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">Actions</p>
            <div className="flex flex-col gap-1">
              <Button
                variant="outline" size="sm" className="h-7 text-xs justify-start"
                onClick={createEvidence} disabled={actioning}
              >
                <Quote className="size-3 mr-1.5" />Save as evidence
              </Button>
              <Button
                variant="outline" size="sm" className="h-7 text-xs justify-start"
                onClick={() => createProposal('knowledge_create')} disabled={actioning}
              >
                <Lightbulb className="size-3 mr-1.5" />Propose knowledge
              </Button>
              <Button
                variant="outline" size="sm" className="h-7 text-xs justify-start"
                onClick={() => createProposal('memory_create')} disabled={actioning}
              >
                <Brain className="size-3 mr-1.5" />Propose memory
              </Button>
            </div>
          </div>
        </section>
      )}

      {/* Notebook */}
      <section className="p-3 space-y-1 flex-1" aria-label="Annotation notebook">
        <p className="text-xs font-medium text-muted-foreground pb-1">Notebook</p>
        {annotations.length === 0 && (
          <p className="text-xs text-muted-foreground">
            Select text in the document and use the toolbar to create your first annotation.
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
                <span>{ann.annotation_type}</span>
                {ann.visibility === 'private'
                  ? <Lock className="size-2.5 shrink-0" />
                  : <Globe className="size-2.5 shrink-0" />}
                {ann.anchor_state === 'unverified' && (
                  <Badge variant="destructive" className="text-[10px] px-1 py-0">unverified</Badge>
                )}
              </div>
              <p className="text-xs line-clamp-2">{ann.quote_text}</p>
              {ann.label && <p className="text-[10px] text-muted-foreground truncate">{ann.label}</p>}
            </button>
          )
        })}
        <p className="sr-only" data-testid="annotation-type-counts">
          {`highlights ${counts.highlight}, comments ${counts.comment}, excerpts ${counts.excerpt}, bookmarks ${counts.bookmark}`}
        </p>
      </section>
    </aside>
  )
}
