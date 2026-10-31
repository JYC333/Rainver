import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type CSSProperties } from 'react'
import { toast } from 'sonner'
import { BookOpenText, CircleHelp, Gauge, ListTree, Maximize2, Minimize2, Search, Type } from 'lucide-react'
import type { ReaderAnchorJson, ReaderAnnotation, ReaderAnnotationCreate, ReaderDocumentPayload } from '../../types/api'
import { readerApi } from '../../api/client'
import { useAppTranslation } from '../../i18n'
import { errMsg } from '../../lib/utils'
import { ReadOnlyTiptapReader, type ReadOnlyTiptapReaderHandle, type SelectionRect, type TextSelection } from '../editor/ReadOnlyTiptapReader'
import { ReaderAnnotationLayer } from './ReaderAnnotationLayer'
import { ReaderInspector } from './ReaderInspector'
import { ReaderSelectionToolbar } from './ReaderSelectionToolbar'
import { ReaderShortcutsDialog } from './ReaderShortcutsDialog'
import { activeAnnotationsInDocumentOrder, annotationBodyWithheld, type ReaderAnnotationAuthority, type ReaderAnnotationsStatus, type ReaderAnnotationType } from './readerModel'
import { readerShortcutAction, useReaderShortcuts, readerShortcutBlocked } from './readerShortcuts'
import { beginCommentSend, clearCommentDraft, commentDraftsVersion, commentSending, finishCommentSend, readCommentDrafts, subscribeCommentDrafts, writeCommentDraft, type ReaderDraftScope } from './commentDrafts'
import { isReaderAccessError } from './useReaderAnnotations'
import { useCommentThreads } from './useCommentThreads'
import type { AnchorResolution } from './anchorResolution'
import type { ReaderHeading } from '../editor/readerNavigation'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog'
import { scrollBehavior } from '../../lib/motion'
import { appearanceStyle, useReaderAppearance } from './readerAppearance'
import { ReaderAppearancePanel } from './ReaderAppearancePanel'
import { ReaderDocumentNote } from './ReaderDocumentNote'
import { ReaderRangeEditor } from './ReaderRangeEditor'
import { ReaderAnnotationExport } from './ReaderAnnotationExport'
import { ReaderPanelResizeHandle } from './ReaderPanelResizeHandle'
import { ReaderFindBar } from './ReaderFindBar'
import { ReaderOutline } from './ReaderOutline'
import { ReaderPopover } from './ReaderPopover'
import { ReaderProgressBar, ReaderProgressPanel, ReaderRestoreNotice, ReaderSyncStatus } from './ReaderProgress'
import { useReaderPosition } from './useReaderPosition'
import { copyText } from './readerClipboard'
import { readReaderLayout, writeReaderLayout } from './readerLayout'

interface ReaderWorkspaceControls {
  panelOpen: boolean
  togglePanel: () => void
  /** Focus mode hides the wrapper's header with the rest of the app's chrome. */
  focusMode: boolean
  /** Unsent comments kept for this document, for a visible cue when the inspector is closed. */
  unsentComments: number
}


/** Same breakpoint as the drawer CSS in index.css. */
function narrowReaderViewport(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(max-width: 768px)').matches === true
}

/**
 * Below this Reader width the text and a docked inspector do not both fit
 * (≈ a 640px reading column + the 320px panel): the inspector then overlays
 * the text on request instead of squeezing the article into a strip. Measured
 * on the Reader's own row, so Shell, Project navigation and side panes count.
 */
const DOCKED_INSPECTOR_MIN_WIDTH = 960
/** Below this the contents list overlays the text too (it docks only beside a full column). */
const DOCKED_OUTLINE_MIN_WIDTH = 1180

function rectOf(rect: DOMRect): SelectionRect {
  return { top: rect.top, left: rect.left, bottom: rect.bottom, right: rect.right, width: rect.width, height: rect.height }
}

export function ReaderWorkspace({ document, annotations, onAnnotationsChange, annotationsStatus, annotationAuthority, header, lead, banner, onReferenceClick, remoteImages = false }: {
  document: ReaderDocumentPayload
  annotations: ReaderAnnotation[]
  onAnnotationsChange: (items: ReaderAnnotation[]) => void
  /**
   * From useReaderAnnotations: a create/archive response may change the list
   * only while the authority it started under still holds (see that hook).
   * Without it, every confirmed change applies.
   */
  annotationAuthority?: ReaderAnnotationAuthority
  /** Loading/failure of the annotation list only; the document stays readable. */
  annotationsStatus?: ReaderAnnotationsStatus
  header?: (controls: ReaderWorkspaceControls) => ReactNode
  /** Title and source metadata shown above the body, outside the anchored document tree. */
  lead?: ReactNode
  banner?: ReactNode
  onReferenceClick?: (referenceId: string) => void
  /**
   * Whether this document's cross-origin images may load inline. Off unless the
   * caller says otherwise, because this component renders more than one kind of
   * document: a captured article, whose images are part of the article the
   * person chose to read, and a research report, which a synthesis Run wrote
   * over ingested third-party items. Deciding it here would give both the same
   * answer.
   */
  remoteImages?: boolean
}) {
  const { t } = useAppTranslation()
  const { keys: shortcutKeys } = useReaderShortcuts()
  // A phone opens on the text; the drawer appears when the reader asks for it.
  // Elsewhere the panels open as the person last left them on this browser.
  const [panelOpen, setPanelOpen] = useState(() => document.can_annotate !== false && !narrowReaderViewport() && readReaderLayout().inspector)
  const [outlineOpen, setOutlineOpen] = useState(() => !narrowReaderViewport() && readReaderLayout().outline)
  const [panelWidths, setPanelWidths] = useState(() => readReaderLayout())
  const [rowWidth, setRowWidth] = useState(() => window.innerWidth)
  const outlineMax = Math.max(200, Math.min(360, panelOpen ? rowWidth * 0.25 : rowWidth - 406))
  const outlineWidth = Math.min(panelWidths.outlineWidth, Math.floor(outlineMax))
  const inspectorMax = Math.max(280, Math.min(480, rowWidth - (outlineOpen ? outlineWidth : 0) - 412))
  const inspectorWidth = Math.min(panelWidths.inspectorWidth, Math.floor(inspectorMax))
  const changePanelWidth = (name: 'outlineWidth' | 'inspectorWidth', value: number) => {
    setPanelWidths(current => ({ ...current, [name]: value }))
    writeReaderLayout({ [name]: value })
  }
  const [overlayInspector, setOverlayInspector] = useState(false)
  const [overlayOutline, setOverlayOutline] = useState(false)
  const [findOpen, setFindOpen] = useState(false)
  const findStartRef = useRef<number | null>(null)
  const [focusMode, setFocusMode] = useState(false)
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null)
  const [headings, setHeadings] = useState<ReaderHeading[]>([])
  const [currentBlock, setCurrentBlock] = useState<number | null>(null)
  const [noticeDismissed, setNoticeDismissed] = useState(false)
  // Until the reader opens or closes the panel themself, a first measurement
  // of a narrow Reader closes it rather than covering the text.
  const panelChosenRef = useRef(false)
  const rowRef = useRef<HTMLDivElement>(null)
  const [selection, setSelection] = useState<TextSelection | null>(null)
  const [selectedAnnotation, setSelectedAnnotation] = useState<ReaderAnnotation | null>(null)
  const [rangeEdit, setRangeEdit] = useState<{ annotation: ReaderAnnotation; initial: TextSelection; scope: string } | null>(null)
  const rangePendingRef = useRef(false)
  const rangeAccessDenied = annotationsStatus?.state === 'error' && isReaderAccessError(annotationsStatus.error)
  useEffect(() => { if (rangeAccessDenied) setRangeEdit(null) }, [rangeAccessDenied])
  const rangeEditRef = useRef(rangeEdit)
  rangeEditRef.current = rangeEdit
  const resolvedRef = useRef(new Map<string, AnchorResolution>())
  const [pendingType, setPendingType] = useState<ReaderAnnotationType | null>(null)
  const [label, setLabel] = useState('')
  const [autoHighlight, setAutoHighlight] = useState(false)
  const archiveRef = useRef<(id: string) => Promise<void>>(async () => {})
  const [focusedBlock, setFocusedBlock] = useState<number | null>(null)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [focusCommentId, setFocusCommentId] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const shellRef = useRef<HTMLDivElement>(null)
  const readerRef = useRef<ReadOnlyTiptapReaderHandle>(null)
  const commentInputRef = useRef<HTMLTextAreaElement>(null)
  const clearTextSelection = useCallback(() => {
    setSelection(null); setFocusedBlock(null)
    const native = window.getSelection()
    // Only clear this Reader's range, never text selected in an inspector/input elsewhere.
    if (native?.anchorNode && rootRef.current?.querySelector('.reader-surface')?.contains(native.anchorNode)) native.removeAllRanges()
  }, [])
  // The annotation whose threads the panel is showing. A thread list that
  // arrives for an annotation selected earlier is dropped against this.
  const selectedAnnotationIdRef = useRef<string | null>(null)
  selectedAnnotationIdRef.current = selectedAnnotation?.id ?? null
  // Replies for a document the reader has since left are dropped against this.
  const documentKey = `${document.document_type}:${document.document_id}`
  const rangeScope = `${document.space_id}:${documentKey}:${document.content_hash}:${document.structure_hash ?? ''}`
  const rangeScopeRef = useRef(rangeScope)
  rangeScopeRef.current = rangeScope
  useEffect(() => { setAutoHighlight(false); setRangeEdit(null) }, [documentKey, document.content_hash, document.structure_hash])
  const documentKeyRef = useRef(documentKey)
  documentKeyRef.current = documentKey
  const annotationsRef = useRef(annotations)
  annotationsRef.current = annotations
  const authorityRef = useRef(annotationAuthority)
  authorityRef.current = annotationAuthority
  // A wrapper may unmount this workspace while it loads the next document; a
  // reply that lands afterwards must not write the old list over the new one.
  const mountedRef = useRef(false)
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false } }, [])
  // Which createAnnotation call owns the pending state. A document switch
  // releases it at once; the old call's completion then changes nothing.
  const creationOwner = useRef<number | null>(null)
  const creationSeq = useRef(0)
  // Sends this instance started; a send that an earlier Reader instance
  // started and that finishes while this one shows the annotation triggers a reread.
  const ownSends = useRef(new Set<string>())
  // A press on the selection toolbar may collapse the browser selection first
  // (touch browsers do); the stored selection must survive until the action runs.
  const toolbarPressRef = useRef(false)
  const setToolbarPressed = useCallback((pressed: boolean) => { toolbarPressRef.current = pressed }, [])
  const ordered = useMemo(() => activeAnnotationsInDocumentOrder(annotations), [annotations])
  // Annotations that cannot be placed in the document as it is now (see
  // anchorResolution): listed with their quote and comments, never painted.
  const [unlocatedIds, setUnlocatedIds] = useState<ReadonlySet<string>>(() => new Set())
  const documentVersion = useMemo(() => ({ contentHash: document.content_hash, structureHash: document.structure_hash ?? null }),
    [document.content_hash, document.structure_hash])
  const onAnchorsResolved = useCallback((resolved: Map<string, AnchorResolution>) => {
    resolvedRef.current = resolved
    const next = new Set([...resolved].filter(([, placement]) => placement.state === 'unlocated').map(([id]) => id))
    setUnlocatedIds(current => current.size === next.size && [...next].every(id => current.has(id)) ? current : next)
  }, [])

  // Comment drafts belong to their annotation and outlive this component (see
  // commentDrafts.ts): switching annotations, closing the drawer, leaving by
  // any route or a late reply never moves or clears what was typed elsewhere.
  const draftScope = useMemo<ReaderDraftScope>(() => ({ spaceId: document.space_id, documentType: document.document_type, documentId: document.document_id }),
    [document.space_id, document.document_type, document.document_id])
  // Subscribed for re-rendering; the reads below are pure and run every render,
  // so an expired draft is gone from view as soon as anything re-renders.
  useSyncExternalStore(subscribeCommentDrafts, commentDraftsVersion)
  const drafts = readCommentDrafts(draftScope)
  const draftIds = new Set(Object.keys(drafts))

  /** Forget the selected annotation and everything shown or sent for it. */
  const dropSelection = useCallback(() => {
    setSelectedAnnotation(null); selectedAnnotationIdRef.current = null; setFocusCommentId(null)
  }, [])
  const thread = useCommentThreads({
    documentKey,
    onAccessLost: (annotationId, error) => {
      // Comments need full access to the annotation: nothing of it may stay on screen or in memory.
      clearCommentDraft(draftScope, annotationId)
      if (selectedAnnotationIdRef.current === annotationId) { dropSelection(); thread.show(null) }
      toast.error(errMsg(error))
    },
  })
  const { threads, status: threadsStatus } = thread

  const { appearance, change: changeAppearance, reset: resetAppearance } = useReaderAppearance()
  // A document without readable text (metadata only, not yet prepared, failed)
  // has no reading position: no percentage, no saved place, no reset. A short
  // real text is read through at 100%; that is a different case.
  const hasBody = Boolean(document.normalized_text?.trim() || document.plain_text?.trim())
  const position = useReaderPosition({ document, readerRef, shellRef, enabled: hasBody })
  const codeCopyLabels = useMemo(() => ({ copy: t('reading.copyCode'), copied: t('reading.copied'), failed: t('reading.copyFailed') }), [t])

  // Headings of the document shown (the reader draws new content before this runs).
  useEffect(() => { setHeadings(readerRef.current?.headings() ?? []) }, [document.content_json])
  // The section being read, for the contents list; measured only while it is open.
  useEffect(() => {
    const shell = shellRef.current
    if (!outlineOpen || !shell) return
    let frame = 0
    const update = () => { frame = 0; setCurrentBlock(readerRef.current?.readingAnchor(shell)?.block_index ?? null) }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update) }
    update()
    shell.addEventListener('scroll', schedule, { passive: true })
    return () => { if (frame) cancelAnimationFrame(frame); shell.removeEventListener('scroll', schedule) }
  }, [outlineOpen, documentKey])

  // Focus mode hides the app's navigation (Shell marks it data-shell-chrome) for this Reader only.
  useEffect(() => {
    if (!focusMode) return
    const root = window.document.documentElement
    root.dataset.readerFocus = 'true'
    return () => { delete root.dataset.readerFocus }
  }, [focusMode])

  useEffect(() => {
    setSelection(null); setSelectedAnnotation(null); setFocusedBlock(null)
    setFindOpen(false); setLightbox(null); setNoticeDismissed(false)
    ownSends.current.clear()
    // A save still running for the previous document must not keep this one disabled.
    creationOwner.current = null; setPendingType(null)
  }, [documentKey])

  // An explicit refusal of the list, or an authoritative list in which the
  // selected annotation is gone or no longer readable in full, ends what the
  // inspector shows for it. Other failures keep the selection and its draft.
  const selectedId = selectedAnnotation?.id ?? null
  useEffect(() => {
    if (!selectedId) return
    if (annotationsStatus?.state === 'error') {
      if (!isReaderAccessError(annotationsStatus.error)) return
      dropSelection(); thread.show(null)
      return
    }
    if (annotationsStatus) return
    const current = annotations.find(item => item.id === selectedId && item.status === 'active')
    if (current && !annotationBodyWithheld(current)) return
    clearCommentDraft(draftScope, selectedId)
    dropSelection(); thread.show(null)
  }, [annotations, annotationsStatus, selectedId])

  // A send started by an earlier Reader instance (before the person left and
  // came back) finishing now: reread so its comment appears.
  const foreignSendShown = selectedId !== null && commentSending(draftScope, selectedId) && !ownSends.current.has(selectedId)
  const foreignSendWas = useRef(false)
  useEffect(() => {
    if (foreignSendWas.current && !foreignSendShown && selectedId) thread.reload(selectedId)
    foreignSendWas.current = foreignSendShown
  }, [foreignSendShown, selectedId])
  useEffect(() => {
    if (focusCommentId && panelOpen && selectedAnnotation?.id === focusCommentId && commentInputRef.current) {
      commentInputRef.current.focus(); setFocusCommentId(null)
    }
  }, [focusCommentId, panelOpen, selectedAnnotation?.id])

  useEffect(() => {
    const row = rowRef.current
    if (!row || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width
      if (width > 0) setRowWidth(width)
      const overlay = width > 0 && width < DOCKED_INSPECTOR_MIN_WIDTH
      setOverlayInspector(overlay)
      setOverlayOutline(width > 0 && width < DOCKED_OUTLINE_MIN_WIDTH)
      if (overlay && !panelChosenRef.current) { setPanelOpen(false); setOutlineOpen(false) }
    })
    observer.observe(row)
    return () => observer.disconnect()
  }, [])
  // Overlays do not both cover the text: opening one closes the other.
  const choosePanel = useCallback((update: (open: boolean) => boolean) => {
    if (document.can_annotate === false) return
    panelChosenRef.current = true
    setPanelOpen(current => {
      const next = update(current)
      if (next && overlayInspector) setOutlineOpen(false)
      if (!narrowReaderViewport()) writeReaderLayout({ inspector: next })
      return next
    })
  }, [overlayInspector, document.can_annotate])
  const chooseOutline = useCallback((update: (open: boolean) => boolean) => {
    setOutlineOpen(current => {
      const next = update(current)
      if (next && overlayOutline) setPanelOpen(false)
      if (!narrowReaderViewport()) writeReaderLayout({ outline: next })
      return next
    })
  }, [overlayOutline])
  const jumpToHeading = useCallback((heading: ReaderHeading) => {
    const shell = shellRef.current
    if (!shell) return
    readerRef.current?.scrollToPos(heading.pos, shell, true)
    setFocusedBlock(heading.blockIndex)
    if (overlayOutline) setOutlineOpen(false)
  }, [overlayOutline])
  const openFind = useCallback(() => {
    if (!findOpen) findStartRef.current = shellRef.current?.scrollTop ?? null
    setFindOpen(true)
  }, [findOpen])
  const closeFind = useCallback((returnToStart: boolean) => {
    readerRef.current?.find('')
    setFindOpen(false)
    const start = findStartRef.current
    if (returnToStart && start != null) shellRef.current?.scrollTo({ top: start, behavior: 'auto' })
    findStartRef.current = null
  }, [])
  const findInDocument = useCallback((query: string) => readerRef.current?.find(query) ?? 0, [])
  const goToMatch = useCallback((index: number) => readerRef.current?.findGo(index), [])

  // Publish the soft keyboard's overlap so the drawer and docked toolbar stay above it.
  useEffect(() => {
    const viewport = window.visualViewport
    const root = rootRef.current
    if (!viewport || !root) return
    const update = () => {
      // Pinch zoom also shrinks the visual viewport; only an unzoomed one means a keyboard.
      const inset = Math.abs(viewport.scale - 1) < 0.01 ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop) : 0
      root.style.setProperty('--reader-keyboard-inset', `${Math.round(inset)}px`)
      root.style.setProperty('--reader-visual-height', `${Math.round(viewport.height)}px`)
    }
    update()
    viewport.addEventListener('resize', update); viewport.addEventListener('scroll', update)
    return () => { viewport.removeEventListener('resize', update); viewport.removeEventListener('scroll', update) }
  }, [])

  // Dismiss only transient text selection, without touching saved annotations/drafts.
  useEffect(() => {
    if (!selection && focusedBlock == null) return
    const dismiss = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Element) || target.closest('.reader-selection-toolbar')) return
      const root = rootRef.current
      if (!root) return
      if (root.contains(target)) {
        // Reader tools/inspector keep their quote; only the canvas gutter dismisses.
        if (!shellRef.current?.contains(target) || target.closest('.reader-surface > *')) return
      }
      clearTextSelection()
    }
    window.document.addEventListener('pointerdown', dismiss)
    return () => window.document.removeEventListener('pointerdown', dismiss)
  }, [selection, focusedBlock, clearTextSelection])

  // Keep the floating toolbar on the selected text across scroll/viewport changes.
  const hasSelection = selection !== null
  useEffect(() => {
    if (!hasSelection) return
    const shell = shellRef.current
    let frame = 0
    const measure = () => {
      frame = 0
      if (!shell) return
      const domSelection = window.getSelection()
      let rect: SelectionRect | null = null
      if (domSelection && domSelection.rangeCount > 0 && !domSelection.isCollapsed && shell.contains(domSelection.anchorNode)) {
        rect = rectOf(domSelection.getRangeAt(0).getBoundingClientRect())
      } else if (focusedBlock != null) {
        const block = shell.querySelector('.reader-surface')?.children[focusedBlock]
        if (block) rect = rectOf(block.getBoundingClientRect())
      }
      const bounds = shell.getBoundingClientRect()
      if (rect && (rect.bottom < bounds.top || rect.top > bounds.bottom)) rect = null
      setSelection(current => current && { ...current, selectionRect: rect })
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure) }
    shell?.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    window.visualViewport?.addEventListener('resize', schedule)
    window.visualViewport?.addEventListener('scroll', schedule)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      shell?.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      window.visualViewport?.removeEventListener('resize', schedule)
      window.visualViewport?.removeEventListener('scroll', schedule)
    }
  }, [hasSelection, focusedBlock])

  const selectAnnotation = useCallback((annotation: ReaderAnnotation, scroll = false) => {
    // A summary-only annotation has no body or comments to show.
    if (annotationBodyWithheld(annotation)) return
    setRangeEdit(null)
    setSelectedAnnotation(annotation); setSelection(null); setPanelOpen(true)
    if (overlayOutline) setOutlineOpen(false)
    selectedAnnotationIdRef.current = annotation.id
    if (scroll) {
      const marks = shellRef.current?.querySelectorAll<HTMLElement>(`[data-annotation-id="${CSS.escape(annotation.id)}"]`)
      marks?.[0]?.scrollIntoView({ behavior: scrollBehavior(), block: 'center' })
      // A short flash shows which text the jump landed on.
      marks?.forEach(mark => { mark.classList.remove('reader-highlight-flash'); void mark.offsetWidth; mark.classList.add('reader-highlight-flash') })
    }
    thread.show(annotation.id)
  }, [overlayOutline, thread])

  const selectAnnotationRef = useRef(selectAnnotation)
  selectAnnotationRef.current = selectAnnotation

  const createAnnotation = useCallback(async (type: ReaderAnnotationType, selected: TextSelection, automatic = false) => {
    if (document.can_annotate === false) return
    // A ref, not state: two key presses inside one render must create one annotation.
    if (creationOwner.current !== null) return
    const owner = ++creationSeq.current
    creationOwner.current = owner
    setPendingType(type)
    const key = documentKeyRef.current
    const change = authorityRef.current?.begin()
    try {
      const draft = selected.anchorDraft
      const anchor: ReaderAnchorJson = {
        schema_version: 1, normalizer: 'plain_text_v1', quote_text: draft.quote_text, text_range: draft.text_range,
        before_context: draft.before_context, after_context: draft.after_context,
        ...(draft.tiptap_range ? { tiptap_range: draft.tiptap_range } : {}), ...(draft.block_ref ? { block_ref: draft.block_ref } : {}),
        content_hash: document.content_hash, ...(document.structure_hash ? { structure_hash: document.structure_hash } : {}), document_ref: { document_type: document.document_type, document_id: document.document_id },
      }
      const body: ReaderAnnotationCreate = {
        document_type: document.document_type as ReaderAnnotationCreate['document_type'], document_id: document.document_id,
        annotation_type: type, quote_text: selected.quoteText, anchor_json: anchor, label: label.trim() || undefined,
      }
      const created = await readerApi.createAnnotation(body)
      if (!mountedRef.current || documentKeyRef.current !== key) return
      // Access was refused (or refused and restored) since this started: the
      // created quote may only reappear through a new authoritative read.
      if (change && !authorityRef.current?.accepts(change)) return
      onAnnotationsChange([...annotationsRef.current, created]); setSelection(null); setLabel('')
      window.getSelection()?.removeAllRanges()
      if (type === 'comment') {
        // A comment needs the panel and its field.
        setSelectedAnnotation(created); selectedAnnotationIdRef.current = created.id; thread.show(created.id, { fetch: false })
        setPanelOpen(true); setFocusCommentId(created.id)
        toast.success(t('reading.annotationSaved'))
      } else {
        // Highlighting is quiet: the text stays in view and the panel stays as it was.
        let undoing = false
        const toastId = toast.success(t(`reading.saved_${type}`), { ...(automatic ? { duration: Infinity, closeButton: true } : {}), action: automatic
          ? { label: t('reading.undo'), onClick: event => {
            event.preventDefault()
            if (undoing || !mountedRef.current || documentKeyRef.current !== key || (change && !authorityRef.current?.accepts(change))) return
            undoing = true
            void archiveRef.current(created.id).then(() => toast.dismiss(toastId)).catch(error => { undoing = false; toast.error(errMsg(error)) })
          } }
          : { label: t('reading.view'), onClick: () => { if (mountedRef.current && documentKeyRef.current === key) selectAnnotationRef.current?.(created) } } })
      }
    } catch (error) {
      if (mountedRef.current && documentKeyRef.current === key) toast.error(errMsg(error))
    } finally {
      // Only the call that still owns the pending state releases it.
      if (creationOwner.current === owner) { creationOwner.current = null; if (mountedRef.current) setPendingType(null) }
    }
  }, [document, label, onAnnotationsChange, t, thread])

  const submitComment = useCallback(async (annotationId: string) => {
    const scope = draftScope
    const body = (readCommentDrafts(scope)[annotationId] ?? '').trim()
    if (!body) return
    // The claim lives with the draft: leaving and returning shows it pending and cannot post it twice.
    const claim = beginCommentSend(scope, annotationId, body)
    if (!claim) return
    ownSends.current.add(annotationId)
    const key = documentKeyRef.current
    try {
      // Adds the posted comments only; the thread's status is left to status writes.
      await thread.write(annotationId, () => readerApi.createComment(annotationId, { body }), result => current => {
        const existing = current.find(item => item.id === result.thread.id)
        if (!existing) return [...current, result.thread]
        const known = new Set(existing.comments.map(comment => comment.id))
        const added = result.thread.comments.filter(comment => !known.has(comment.id))
        return current.map(item => item === existing ? { ...item, comments: [...item.comments, ...added] } : item)
      })
      // Clears only the text that was sent, and only within the same session.
      finishCommentSend(claim, true)
    } catch (error) {
      if (finishCommentSend(claim, false) && mountedRef.current && documentKeyRef.current === key) toast.error(errMsg(error))
    } finally {
      ownSends.current.delete(annotationId)
    }
  }, [draftScope, thread])

  /**
   * Undo of a removal: the server restores the archived annotation (owner only,
   * and only while the document is still readable), with its comments. The
   * restored annotation joins the list only under the authority this started in.
   */
  const restoreAnnotation = useCallback(async (annotationId: string, key: string) => {
    const change = authorityRef.current?.begin()
    try {
      const restored = await readerApi.updateAnnotation(annotationId, { status: 'active' })
      if (!mountedRef.current || documentKeyRef.current !== key) return
      if (change && !authorityRef.current?.accepts(change)) return
      if (!annotationsRef.current.some(item => item.id === restored.id)) onAnnotationsChange([...annotationsRef.current, restored])
      toast.success(t('reading.annotationRestored'))
    } catch (error) {
      if (mountedRef.current && documentKeyRef.current === key) toast.error(errMsg(error))
    }
  }, [onAnnotationsChange, t])

  const archiveAnnotation = useCallback(async (annotationId: string) => {
    const key = documentKeyRef.current
    const change = authorityRef.current?.begin()
    await readerApi.deleteAnnotation(annotationId)
    // The comment draft goes with the annotation regardless of what is shown now.
    clearCommentDraft(draftScope, annotationId)
    if (!mountedRef.current || documentKeyRef.current !== key) return
    if (change && !authorityRef.current?.accepts(change)) return
    onAnnotationsChange(annotationsRef.current.filter(item => item.id !== annotationId))
    if (selectedAnnotationIdRef.current === annotationId) { dropSelection(); thread.show(null) }
    toast.success(t('reading.annotationRemoved'), { action: { label: t('reading.undo'), onClick: () => void restoreAnnotation(annotationId, key) } })
  }, [draftScope, dropSelection, onAnnotationsChange, restoreAnnotation, t, thread])

  archiveRef.current = archiveAnnotation

  const setThreadStatus = useCallback(async (annotationId: string, threadId: string, status: 'open' | 'resolved') => {
    // Sets the status only; comments are left to comment writes.
    await thread.write(annotationId, () => readerApi.updateThread(threadId, { status }),
      updated => current => current.map(item => item.id === threadId ? { ...item, status: updated.status, updated_at: updated.updated_at } : item))
  }, [thread])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (readerShortcutBlocked(event, rootRef.current)) return
      const annotate = (type: ReaderAnnotationType) => {
        if (event.repeat) return
        event.preventDefault()
        if (selection) return void createAnnotation(type, selection)
        if (focusedBlock == null) return
        const block = readerRef.current?.blockSelection(focusedBlock)
        if (block) void createAnnotation(type, block); else toast.error(t('reading.focusedBlockEmpty'))
      }
      const action = readerShortcutAction(event.key, event.shiftKey, shortcutKeys)
      if (rangeEdit && action !== 'escape') return
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        // Shift+Arrow extends a selection, and arrows on a focused inspector
        // control belong to that control: only the page or the text moves paragraphs.
        const target = event.target instanceof Node ? event.target : null
        const onText = !target || target === window.document.body || target === window.document.documentElement || shellRef.current?.contains(target)
        if (event.shiftKey || !onText) return
        const count = readerRef.current?.blockCount() ?? 0; if (!count) return
        event.preventDefault(); const delta = event.key === 'ArrowDown' ? 1 : -1
        const next = focusedBlock == null ? (delta > 0 ? 0 : count - 1) : Math.min(count - 1, Math.max(0, focusedBlock + delta))
        setFocusedBlock(next); readerRef.current?.scrollToBlock(next)
      } else if (action === 'highlight') annotate('highlight')
      else if (action === 'comment') annotate('comment')
      else if (action === 'outline') { event.preventDefault(); chooseOutline(open => !open) }
      else if (action === 'inspector') { event.preventDefault(); choosePanel(open => !open) }
      else if (action === 'find') { event.preventDefault(); openFind() }
      else if (action === 'focus') { if (event.repeat) return; event.preventDefault(); setFocusMode(on => !on) }
      else if (action === 'escape') {
        if (rangeEdit) { if (!rangePendingRef.current) setRangeEdit(null); return }
        if (selection || focusedBlock != null) { clearTextSelection() }
        else if (panelOpen && (overlayInspector || narrowReaderViewport())) choosePanel(() => false)
        else if (outlineOpen && overlayOutline) chooseOutline(() => false)
        else if (focusMode) setFocusMode(false)
      } else if (action === 'help') { event.preventDefault(); setShortcutsOpen(true) }
    }
    window.addEventListener('keydown', onKeyDown); return () => window.removeEventListener('keydown', onKeyDown)
  }, [chooseOutline, choosePanel, clearTextSelection, createAnnotation, focusMode, focusedBlock, openFind, outlineOpen, overlayInspector, overlayOutline, panelOpen, selection, shortcutKeys, rangeEdit, t])

  const activeIds = useMemo(() => new Set(ordered.map(item => item.id)), [ordered])
  const unsentComments = [...draftIds].filter(id => activeIds.has(id)).length
  const showNotice = !noticeDismissed && !focusMode
  return <div ref={rootRef} className={`reader-workspace flex h-full flex-col${focusMode ? ' reader-focus-mode' : ''}`}>
    {!focusMode && header?.({ panelOpen, togglePanel: () => choosePanel(open => !open), unsentComments, focusMode })}
    <div role="toolbar" aria-label={t('reading.readerTools')} className="reader-tools flex shrink-0 items-center gap-0.5 border-b border-border px-2 py-1">
      <Button variant="ghost" size="icon-sm" aria-pressed={outlineOpen} aria-label={t(outlineOpen ? 'reading.hideOutline' : 'reading.showOutline')} title={`${t(outlineOpen ? 'reading.hideOutline' : 'reading.showOutline')} (${shortcutKeys.outline})`}
        onClick={() => chooseOutline(open => !open)}><ListTree className="size-4" /></Button>
      <Button variant="ghost" size="icon-sm" aria-pressed={findOpen} aria-label={t('reading.findInDocument')} title={`${t('reading.findInDocument')} (${shortcutKeys.find})`}
        onClick={() => findOpen ? closeFind(false) : openFind()}><Search className="size-4" /></Button>
      <ReaderPopover label={t('reading.appearance')} align="start" icon={<Type className="size-4" />}>
        {() => <><ReaderAppearancePanel appearance={appearance} onChange={changeAppearance} onReset={resetAppearance} />
          <label className="mt-3 flex items-start gap-2 border-t border-border pt-3 text-sm"><input type="checkbox" checked={autoHighlight} disabled={document.can_annotate !== true || annotationsStatus?.state === 'error'} onChange={event => setAutoHighlight(event.target.checked)} />
            <span>{t('reading.autoHighlight')}<span className="mt-1 block text-xs text-muted-foreground">{t('reading.autoHighlightHint')}</span></span></label></>}
      </ReaderPopover>
      {hasBody && <ReaderPopover label={t('reading.progress')} align="start" icon={<Gauge className="size-4" />}>
        {close => <ReaderProgressPanel shellRef={shellRef} position={position} close={close} />}
      </ReaderPopover>}
      <div className="flex-1" />
      <ReaderSyncStatus position={position} />
      {document.can_annotate !== false && <ReaderDocumentNote spaceId={document.space_id} documentType={document.document_type} documentId={document.document_id} />}
      {document.can_annotate !== false && <ReaderAnnotationExport documentType={document.document_type} documentId={document.document_id} authority={annotationAuthority} />}
      <Button variant="ghost" size="icon-sm" aria-label={t('reading.shortcutsTitle')} title={`${t('reading.shortcutsTitle')} (${shortcutKeys.help})`} onClick={() => setShortcutsOpen(true)}><CircleHelp className="size-4" /></Button>
      <Button variant="ghost" size="icon-sm" aria-pressed={focusMode} aria-label={t(focusMode ? 'reading.exitFocus' : 'reading.enterFocus')} title={`${t(focusMode ? 'reading.exitFocus' : 'reading.enterFocus')} (${shortcutKeys.focus})`}
        onClick={() => setFocusMode(on => !on)}>{focusMode ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}</Button>
    </div>
    {rangeEdit && rangeEdit.scope === rangeScope && !rangeAccessDenied && readerRef.current && <ReaderRangeEditor key={rangeEdit.annotation.id} annotation={rangeEdit.annotation} initial={rangeEdit.initial}
      document={document} reader={readerRef.current} authority={annotationAuthority}
      onPendingChange={pending => { if (rangeEditRef.current === rangeEdit) rangePendingRef.current = pending }}
      live={() => mountedRef.current && rangeEditRef.current === rangeEdit && rangeScopeRef.current === rangeEdit.scope}
      onSaved={updated => {
        onAnnotationsChange(annotationsRef.current.map(item => item.id === updated.id ? updated : item))
        setSelectedAnnotation(updated); setRangeEdit(null); toast.success(t('reading.rangeSaved'))
      }} onCancel={() => setRangeEdit(null)} />}
    {!focusMode && banner}
    {showNotice && <ReaderRestoreNotice position={position} onDone={() => setNoticeDismissed(true)} />}
    {/* Above the pane, not in its content: opening or closing it never moves the text. */}
    {findOpen && <ReaderFindBar key={documentKey} onFind={findInDocument} onGo={goToMatch} onClose={closeFind} />}
    <div ref={rowRef} className="relative flex min-h-0 flex-1 overflow-hidden"
      style={{ '--reader-outline-width': `${outlineWidth}px`, '--reader-inspector-width': `${inspectorWidth}px` } as CSSProperties}>
      {outlineOpen && !focusMode && <ReaderOutline headings={headings} currentBlock={currentBlock} overlay={overlayOutline} onSelect={jumpToHeading} onClose={() => chooseOutline(() => false)} />}
      {outlineOpen && !focusMode && !overlayOutline && <ReaderPanelResizeHandle label={t('reading.resizeOutline')}
        width={outlineWidth} min={200} max={Math.floor(outlineMax)} side="left" onChange={value => changePanelWidth('outlineWidth', value)} />}
      <div className="reader-document-shell relative min-w-0 flex-1 overflow-y-auto" ref={shellRef} data-reader-theme={appearance.theme}>
        {hasBody && <ReaderProgressBar shellRef={shellRef} furthest={position.furthest} />}
        <ReaderAnnotationLayer annotations={annotations} selectedAnnotationId={selectedId} onSelect={annotation => selectAnnotation(annotation)} />
        <div className="reader-column mx-auto" style={appearanceStyle(appearance)}>
          {lead}
          <ReadOnlyTiptapReader ref={readerRef} contentJson={document.content_json} normalizedText={document.normalized_text}
            remoteImages={remoteImages}
            onSelectionCommitted={value => {
              if (!rangeEdit && autoHighlight && document.can_annotate === true && annotationsStatus?.state !== 'error' && annotationsStatus?.state !== 'loading') void createAnnotation('highlight', value, true)
            }}
            onTextSelected={value => {
              if (!value && toolbarPressRef.current) return
              setSelection(value); if (value && !rangeEdit) setSelectedAnnotation(null)
            }} onBlockFocused={setFocusedBlock}
            onAnnotationClick={id => { const annotation = annotations.find(item => item.id === id); if (annotation) selectAnnotation(annotation) }}
            onReferenceClick={onReferenceClick}
            annotations={annotations} selectedAnnotationId={selectedId} focusedBlockIndex={focusedBlock}
            documentVersion={documentVersion} onAnchorsResolved={onAnchorsResolved}
            onImageOpen={setLightbox} codeCopyLabels={codeCopyLabels} />
        </div>
      </div>
      {panelOpen && !focusMode && !overlayInspector && <ReaderPanelResizeHandle label={t('reading.resizeInspector')}
        width={inspectorWidth} min={280} max={Math.floor(inspectorMax)} side="right" onChange={value => changePanelWidth('inspectorWidth', value)} />}
      {panelOpen && !focusMode && <ReaderInspector annotations={ordered} annotationsStatus={annotationsStatus} selection={selection} selectedAnnotation={selectedAnnotation} threads={threads}
        threadsStatus={threadsStatus} draftAnnotationIds={draftIds} unlocatedAnnotationIds={unlocatedIds}
        createLabel={label} onCreateLabelChange={setLabel}
        commentInputRef={commentInputRef} onSelectAnnotation={annotation => selectAnnotation(annotation, true)}
        commentDraft={selectedId ? drafts[selectedId] ?? '' : ''}
        onCommentDraftChange={value => { if (selectedId) writeCommentDraft(draftScope, selectedId, value) }}
        commentPending={selectedId ? commentSending(draftScope, selectedId) : false}
        onSubmitComment={() => { if (selectedId) void submitComment(selectedId) }}
        onAdjustRange={!rangeEdit && !annotationsStatus && document.can_annotate === true && document.structure_hash ? annotation => {
          if (rangeScopeRef.current !== rangeScope) return
          const located = resolvedRef.current.get(annotation.id)
          const initial = located?.state === 'located' ? readerRef.current?.rangeSelection(located.from, located.to) : null
          if (!initial) { toast.error(t('reading.rangeUnavailable')); return }
          rangePendingRef.current = false
          setRangeEdit({ annotation, initial, scope: rangeScope })
        } : undefined}
        onArchiveAnnotation={archiveAnnotation}
        onSetThreadStatus={(threadId, status) => selectedId ? setThreadStatus(selectedId, threadId, status) : Promise.resolve()}
        overlay={overlayInspector}
        onClose={() => choosePanel(() => false)} />}
    </div>
    {selection && !rangeEdit && document.can_annotate !== false && <ReaderSelectionToolbar selectionRect={selection.selectionRect} pending={pendingType !== null}
      onPressChange={setToolbarPressed}
      onCopy={() => void copyText(selection.selectedText).then(ok => ok ? toast.success(t('reading.copied')) : toast.error(t('reading.copyFailed')))}
      onAction={type => void createAnnotation(type, selection)} />}
    <ReaderShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    {/* The image as the Reader already shows it; nothing new is requested. */}
    <Dialog open={lightbox !== null} onOpenChange={open => { if (!open) setLightbox(null) }}>
      <DialogContent className="reader-lightbox max-w-[min(96vw,1400px)] p-2">
        <DialogTitle className="sr-only">{lightbox?.alt || t('reading.image')}</DialogTitle>
        {lightbox && <img src={lightbox.src} alt={lightbox.alt} referrerPolicy="no-referrer-when-downgrade" className="mx-auto max-h-[85vh] w-auto max-w-full object-contain" />}
      </DialogContent>
    </Dialog>
    {focusMode && <Button variant="outline" size="sm" className="reader-focus-exit" onClick={() => setFocusMode(false)}><BookOpenText className="size-4" />{t('reading.exitFocus')}</Button>}
  </div>
}
