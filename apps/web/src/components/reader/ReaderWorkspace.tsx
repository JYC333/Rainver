import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import type { ReaderAnchorJson, ReaderAnnotation, ReaderAnnotationCreate, ReaderCommentThread, ReaderDocumentPayload } from '../../types/api'
import { readerApi } from '../../api/client'
import { errMsg } from '../../lib/utils'
import { ReadOnlyTiptapReader, type ReadOnlyTiptapReaderHandle, type TextSelection } from '../editor/ReadOnlyTiptapReader'
import { ReaderAnnotationLayer } from './ReaderAnnotationLayer'
import { ReaderInspector } from './ReaderInspector'
import { ReaderSelectionToolbar } from './ReaderSelectionToolbar'
import { ReaderShortcutsDialog } from './ReaderShortcutsDialog'
import { activeAnnotationsInDocumentOrder, type ReaderAnnotationType } from './readerModel'

export interface ReaderWorkspaceControls { panelOpen: boolean; togglePanel: () => void }

export function ReaderWorkspace({ document, annotations, onAnnotationsChange, header, banner, onReferenceClick }: {
  document: ReaderDocumentPayload
  annotations: ReaderAnnotation[]
  onAnnotationsChange: (items: ReaderAnnotation[]) => void
  header?: (controls: ReaderWorkspaceControls) => ReactNode
  banner?: ReactNode
  onReferenceClick?: (referenceId: string) => void
}) {
  const [threads, setThreads] = useState<ReaderCommentThread[]>([])
  const [panelOpen, setPanelOpen] = useState(true)
  const [selection, setSelection] = useState<TextSelection | null>(null)
  const [selectedAnnotation, setSelectedAnnotation] = useState<ReaderAnnotation | null>(null)
  const [pendingType, setPendingType] = useState<ReaderAnnotationType | null>(null)
  const [label, setLabel] = useState('')
  const [focusedBlock, setFocusedBlock] = useState<number | null>(null)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [focusCommentId, setFocusCommentId] = useState<string | null>(null)
  const shellRef = useRef<HTMLDivElement>(null)
  const readerRef = useRef<ReadOnlyTiptapReaderHandle>(null)
  const commentInputRef = useRef<HTMLTextAreaElement>(null)
  const ordered = useMemo(() => activeAnnotationsInDocumentOrder(annotations), [annotations])

  useEffect(() => { setSelection(null); setSelectedAnnotation(null); setThreads([]); setFocusedBlock(null) }, [document.document_type, document.document_id])
  useEffect(() => {
    if (focusCommentId && panelOpen && selectedAnnotation?.id === focusCommentId && commentInputRef.current) {
      commentInputRef.current.focus(); setFocusCommentId(null)
    }
  }, [focusCommentId, panelOpen, selectedAnnotation?.id])

  const selectAnnotation = useCallback((annotation: ReaderAnnotation, scroll = false) => {
    setSelectedAnnotation(annotation); setSelection(null); setPanelOpen(true)
    if (scroll) shellRef.current?.querySelector(`[data-annotation-id="${CSS.escape(annotation.id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    readerApi.listThreads(annotation.id).then(result => setThreads(result.items)).catch(error => toast.error(errMsg(error)))
  }, [])

  const createAnnotation = useCallback(async (type: ReaderAnnotationType, selected: TextSelection) => {
    if (pendingType) return
    setPendingType(type)
    try {
      const draft = selected.anchorDraft
      const anchor: ReaderAnchorJson = {
        schema_version: 1, normalizer: 'plain_text_v1', quote_text: draft.quote_text, text_range: draft.text_range,
        before_context: draft.before_context, after_context: draft.after_context,
        ...(draft.tiptap_range ? { tiptap_range: draft.tiptap_range } : {}), ...(draft.block_ref ? { block_ref: draft.block_ref } : {}),
        content_hash: document.content_hash, document_ref: { document_type: document.document_type, document_id: document.document_id },
      }
      const body: ReaderAnnotationCreate = {
        document_type: document.document_type as ReaderAnnotationCreate['document_type'], document_id: document.document_id,
        annotation_type: type, quote_text: selected.quoteText, anchor_json: anchor, label: label.trim() || undefined,
      }
      const created = await readerApi.createAnnotation(body)
      onAnnotationsChange([...annotations, created]); setSelection(null); setSelectedAnnotation(created); setThreads([]); setPanelOpen(true); setLabel('')
      if (type === 'comment') setFocusCommentId(created.id)
      toast.success('Annotation saved')
    } catch (error) { toast.error(errMsg(error)) } finally { setPendingType(null) }
  }, [annotations, document, label, onAnnotationsChange, pendingType])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]') || event.metaKey || event.ctrlKey || event.altKey) return
      const annotate = (type: ReaderAnnotationType) => {
        if (selection) return void createAnnotation(type, selection)
        if (focusedBlock == null) return
        const block = readerRef.current?.blockSelection(focusedBlock)
        if (block) void createAnnotation(type, block); else toast.error('Focused block has no text to annotate')
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const count = readerRef.current?.blockCount() ?? 0; if (!count) return
        event.preventDefault(); const delta = event.key === 'ArrowDown' ? 1 : -1
        const next = focusedBlock == null ? (delta > 0 ? 0 : count - 1) : Math.min(count - 1, Math.max(0, focusedBlock + delta))
        setFocusedBlock(next); readerRef.current?.scrollToBlock(next)
      } else if (event.key.toLowerCase() === 'h') annotate('highlight')
      else if (event.key.toLowerCase() === 'n') annotate('comment')
      else if (event.key === '[' || event.key === ']') setPanelOpen(open => !open)
      else if (event.key === 'Escape') { setSelection(null); setFocusedBlock(null) }
      else if (event.key === '?') setShortcutsOpen(true)
    }
    window.addEventListener('keydown', onKeyDown); return () => window.removeEventListener('keydown', onKeyDown)
  }, [createAnnotation, focusedBlock, selection])

  return <div className="reader-workspace flex h-full flex-col">
    {header?.({ panelOpen, togglePanel: () => setPanelOpen(open => !open) })}
    {banner}
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <div className="reader-document-shell relative flex-1 overflow-y-auto" ref={shellRef}>
        <ReaderAnnotationLayer annotations={annotations} selectedAnnotationId={selectedAnnotation?.id ?? null} onSelect={annotation => selectAnnotation(annotation)} />
        <div className="reader-column mx-auto px-6 py-10">
          <ReadOnlyTiptapReader ref={readerRef} contentJson={document.content_json} normalizedText={document.normalized_text}
            onTextSelected={value => { setSelection(value); if (value) setSelectedAnnotation(null) }} onBlockFocused={setFocusedBlock}
            onAnnotationClick={id => { const annotation = annotations.find(item => item.id === id); if (annotation) selectAnnotation(annotation) }}
            onReferenceClick={onReferenceClick}
            annotations={annotations} selectedAnnotationId={selectedAnnotation?.id ?? null} focusedBlockIndex={focusedBlock} />
        </div>
      </div>
      {panelOpen && <ReaderInspector annotations={ordered} selection={selection} selectedAnnotation={selectedAnnotation} threads={threads}
        createLabel={label} onCreateLabelChange={setLabel}
        commentInputRef={commentInputRef} onSelectAnnotation={annotation => selectAnnotation(annotation, true)}
        onAnnotationArchived={id => { onAnnotationsChange(annotations.filter(item => item.id !== id)); setSelectedAnnotation(null); setThreads([]) }}
        onThreadsUpdated={setThreads} onClose={() => setPanelOpen(false)} />}
    </div>
    {selection && <ReaderSelectionToolbar selectionRect={selection.selectionRect} pending={pendingType !== null} onAction={type => void createAnnotation(type, selection)} />}
    <ReaderShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
  </div>
}
