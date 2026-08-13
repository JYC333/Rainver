import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import { Extension, Mark, Node, mergeAttributes } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { BlockIdAttribute } from './blockIds'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { cn } from '../../lib/utils'
import type { ReaderAnnotation } from '../../types/api'

export interface AnchorBlockRef {
  index: number
  node_type: string
  from: number
  to: number
}

export interface AnchorDraft {
  quote_text: string
  text_range: { start: number; end: number; unit: 'utf16' }
  before_context: string
  after_context: string
  tiptap_range?: { from: number; to: number }
  block_ref?: AnchorBlockRef
}

export interface SelectionRect {
  top: number
  left: number
  bottom: number
  right: number
  width: number
  height: number
}

export interface TextSelection {
  quoteText: string
  anchorDraft: AnchorDraft
  /** Viewport-relative rect of the selected range, when the DOM can provide one. */
  selectionRect: SelectionRect | null
}

/** Imperative block-level access for keyboard-driven reading. */
export interface ReadOnlyTiptapReaderHandle {
  blockCount(): number
  /** Full-block selection for keyboard highlight/comment on the focused block. */
  blockSelection(index: number): TextSelection | null
  scrollToBlock(index: number): void
}

interface ReadOnlyTiptapReaderProps {
  contentJson: Record<string, unknown>
  /** Canonical normalized text: trim → split on ≥2 newlines → trim paragraphs → join ' '.
   *  Must match the server's normalizeReaderText output. Used for context slicing so
   *  before_context/after_context offsets align with server-computed text_range. */
  normalizedText: string
  className?: string
  onTextSelected?: (selection: TextSelection | null) => void
  onBlockFocused?: (index: number | null) => void
  onAnnotationClick?: (annotationId: string) => void
  /** Makes "[ref-N]" citation tokens clickable; called with the token (e.g. "ref-3"). */
  onReferenceClick?: (referenceId: string) => void
  annotations?: ReaderAnnotation[]
  selectedAnnotationId?: string | null
  /** Top-level block with the keyboard focus indicator. */
  focusedBlockIndex?: number | null
}

const highlightPluginKey = new PluginKey<DecorationSet>('annotationHighlight')

const ReaderLink = Mark.create({
  name: 'link',
  inclusive: false,

  addAttributes() {
    return {
      href: { default: null },
    }
  },

  parseHTML() {
    return [{ tag: 'a[href]' }]
  },

  renderHTML({ HTMLAttributes }) {
    const { href: rawHref, ...rest } = HTMLAttributes
    const href = typeof rawHref === 'string' && /^https?:\/\//i.test(rawHref) ? rawHref : null
    if (!href) return ['span', rest, 0]
    return [
      'a',
      mergeAttributes(rest, {
        href,
        target: '_blank',
        rel: 'noreferrer noopener',
      }),
      0,
    ]
  },
})

const ReaderImage = Node.create({
  name: 'image',
  group: 'block',
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      src: { default: null },
      alt: { default: '' },
      title: { default: null },
    }
  },

  parseHTML() {
    return [{ tag: 'img[src]' }]
  },

  renderHTML({ HTMLAttributes }) {
    const { src: rawSrc, ...rest } = HTMLAttributes
    const src = typeof rawSrc === 'string' && /^https?:\/\//i.test(rawSrc) ? rawSrc : null
    if (!src) return ['span', mergeAttributes(rest, { class: 'reader-image-missing' })]
    return [
      'img',
      mergeAttributes(rest, {
        src,
        loading: 'lazy',
        referrerpolicy: 'no-referrer-when-downgrade',
      }),
    ]
  },
})

const ReaderTable = Node.create({
  name: 'table',
  group: 'block',
  content: 'tableRow+',
  isolating: true,

  parseHTML() {
    return [{ tag: 'table' }]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      { class: 'reader-table-scroll' },
      ['table', mergeAttributes(HTMLAttributes, { class: 'reader-table' }), ['tbody', 0]],
    ]
  },
})

const ReaderTableRow = Node.create({
  name: 'tableRow',
  content: '(tableCell | tableHeader)+',

  parseHTML() {
    return [{ tag: 'tr' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['tr', HTMLAttributes, 0]
  },
})

const ReaderTableCell = Node.create({
  name: 'tableCell',
  content: 'block+',
  isolating: true,

  addAttributes() {
    return {
      colspan: { default: 1 },
      rowspan: { default: 1 },
    }
  },

  parseHTML() {
    return [{ tag: 'td' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['td', mergeAttributes(tableCellAttrs(HTMLAttributes)), 0]
  },
})

const ReaderTableHeader = Node.create({
  name: 'tableHeader',
  content: 'block+',
  isolating: true,

  addAttributes() {
    return {
      colspan: { default: 1 },
      rowspan: { default: 1 },
    }
  },

  parseHTML() {
    return [{ tag: 'th' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['th', mergeAttributes(tableCellAttrs(HTMLAttributes)), 0]
  },
})

function tableCellAttrs(attrs: Record<string, unknown>): Record<string, unknown> {
  const colspan = boundedSpan(attrs.colspan)
  const rowspan = boundedSpan(attrs.rowspan)
  return {
    ...(colspan > 1 ? { colspan } : {}),
    ...(rowspan > 1 ? { rowspan } : {}),
  }
}

function boundedSpan(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? Math.min(20, Math.max(1, Math.floor(n))) : 1
}

function annotationColor(ann: ReaderAnnotation): string {
  if (ann.color) return ann.color
  const colors: Record<string, string> = {
    highlight: '#fde047',
    comment: '#86efac',
    excerpt: '#93c5fd',
    bookmark: '#f9a8d4',
  }
  return colors[ann.annotation_type] ?? '#e2e8f0'
}

export const ReadOnlyTiptapReader = forwardRef<ReadOnlyTiptapReaderHandle, ReadOnlyTiptapReaderProps>(
  function ReadOnlyTiptapReader({
    contentJson,
    normalizedText,
    className,
    onTextSelected,
    onBlockFocused,
    onAnnotationClick,
    onReferenceClick,
    annotations,
    selectedAnnotationId,
    focusedBlockIndex,
  }, ref) {
    const onSelectRef = useRef(onTextSelected)
    onSelectRef.current = onTextSelected
    const onBlockFocusedRef = useRef(onBlockFocused)
    onBlockFocusedRef.current = onBlockFocused
    const onAnnotationClickRef = useRef(onAnnotationClick)
    onAnnotationClickRef.current = onAnnotationClick
    const onReferenceClickRef = useRef(onReferenceClick)
    onReferenceClickRef.current = onReferenceClick
    const suppressClickSelectionUpdateRef = useRef(false)

    const annotationsRef = useRef<ReaderAnnotation[]>([])
    annotationsRef.current = annotations ?? []

    const selectedIdRef = useRef<string | null | undefined>(null)
    selectedIdRef.current = selectedAnnotationId

    const focusedBlockRef = useRef<number | null | undefined>(null)
    focusedBlockRef.current = focusedBlockIndex

    const highlightExtension = useMemo(
      () =>
        Extension.create({
          name: 'annotationHighlight',
          addProseMirrorPlugins() {
            return [
              new Plugin({
                key: highlightPluginKey,
                props: {
                  decorations(state) {
                    const anns = annotationsRef.current
                    const selectedId = selectedIdRef.current
                    const decos: Decoration[] = []
                    const docSize = state.doc.content.size
                    for (const ann of anns) {
                      if (ann.status !== 'active') continue
                      const tiptapRange = ann.anchor_json.tiptap_range as
                        | { from: number; to: number }
                        | undefined
                      if (!tiptapRange) continue
                      const from = Math.max(0, Math.min(tiptapRange.from, docSize))
                      const to = Math.max(from, Math.min(tiptapRange.to, docSize))
                      if (from >= to) continue
                      const isSelected = ann.id === selectedId
                      decos.push(
                        Decoration.inline(from, to, {
                          class: cn(
                            'reader-highlight',
                            isSelected && 'reader-highlight-selected',
                          ),
                          style: `--reader-annotation-color:${annotationColor(ann)};`,
                          'data-annotation-id': ann.id,
                        }),
                      )
                    }
                    if (onReferenceClickRef.current) {
                      state.doc.descendants((node, pos) => {
                        if (!node.isText || !node.text) return
                        const groupRe = /\[[^\]]*\bref-\d+[a-z]*\b[^\]]*\]/g
                        let group: RegExpExecArray | null
                        while ((group = groupRe.exec(node.text))) {
                          const tokenRe = /\bref-\d+[a-z]*\b/g
                          let token: RegExpExecArray | null
                          while ((token = tokenRe.exec(group[0]))) {
                            const from = pos + group.index + token.index
                            decos.push(
                              Decoration.inline(from, from + token[0].length, {
                                class: 'reader-ref-citation',
                                'data-ref-id': token[0],
                              }),
                            )
                          }
                        }
                      })
                    }
                    const focused = focusedBlockRef.current
                    if (focused != null && focused >= 0 && focused < state.doc.childCount) {
                      const pos = blockStartPos(state.doc, focused)
                      decos.push(
                        Decoration.node(pos, pos + state.doc.child(focused).nodeSize, {
                          class: 'reader-block-focused',
                        }),
                      )
                    }
                    return DecorationSet.create(state.doc, decos)
                  },
                },
              }),
            ]
          },
        }),
      // Extension is stable; refs keep values current without recreation.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [],
    )

    const extensions = useMemo(
      () => [
        StarterKit.configure({ link: false }),
        // Declared, not generated: the reader never saves, but a schema
        // without the attribute would drop ids from the document it reasons
        // about. Minting ids in a read-only view would be pure churn.
        BlockIdAttribute,
        ReaderLink,
        ReaderImage,
        ReaderTable,
        ReaderTableRow,
        ReaderTableCell,
        ReaderTableHeader,
        highlightExtension,
      ],
      [highlightExtension],
    )

    const editor = useEditor({
      extensions,
      content: contentJson,
      editable: false,
      editorProps: {
        attributes: {
          class: 'reader-surface',
        },
      },
      onSelectionUpdate: ({ editor: e }) => {
        const { from, to } = e.state.selection
        if (suppressClickSelectionUpdateRef.current && from === to) return
        onSelectRef.current?.(buildSelection(e.state.doc, from, to, normalizedText, domSelectionRect()))
      },
    })

    useImperativeHandle(ref, () => ({
      blockCount: () => editor?.state.doc.childCount ?? 0,
      blockSelection: (index: number) => {
        if (!editor) return null
        return blockSelectionAt(editor.state.doc, index, normalizedText, null)
      },
      scrollToBlock: (index: number) => {
        if (!editor || index < 0 || index >= editor.state.doc.childCount) return
        const dom = editor.view.nodeDOM(blockStartPos(editor.state.doc, index))
        if (dom instanceof HTMLElement) dom.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      },
    }), [editor, normalizedText])

    // Sync content when it changes
    const contentKey = useMemo(() => JSON.stringify(contentJson), [contentJson])
    useEffect(() => {
      if (!editor) return
      editor.commands.setContent(contentJson)
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [editor, contentKey])

    // Dispatch a no-op transaction so the decoration plugin re-evaluates refs.
    useEffect(() => {
      if (!editor) return
      editor.view.dispatch(
        editor.state.tr.setMeta(highlightPluginKey, true),
      )
    }, [editor, annotations, selectedAnnotationId, focusedBlockIndex])

    function handleClick(e: React.MouseEvent<HTMLDivElement>) {
      const target = e.target as HTMLElement
      const citation = target.closest<HTMLElement>('[data-ref-id]')
      if (citation?.dataset.refId && onReferenceClickRef.current) {
        onReferenceClickRef.current(citation.dataset.refId)
        return
      }
      const annotated = target.closest<HTMLElement>('[data-annotation-id]')
      if (annotated) {
        const id = annotated.dataset.annotationId
        if (id) onAnnotationClickRef.current?.(id)
        return
      }
      if (!editor || target.closest('a[href]')) return
      if (window.getSelection()?.toString().trim()) return

      const clickedBlock = topLevelReaderBlock(e.currentTarget, target)
      if (!clickedBlock) return
      onBlockFocusedRef.current?.(clickedBlock.index)
      const selection = blockSelectionAt(
        editor.state.doc,
        clickedBlock.index,
        normalizedText,
        rectToSelectionRect(clickedBlock.element.getBoundingClientRect()),
      )
      if (!selection) {
        onSelectRef.current?.(null)
        return
      }
      suppressClickSelectionUpdateRef.current = true
      window.setTimeout(() => {
        suppressClickSelectionUpdateRef.current = false
      }, 0)
      window.getSelection()?.removeAllRanges()
      onSelectRef.current?.(selection)
    }

    return (
      <div onClick={handleClick}>
        <EditorContent
          editor={editor}
          className={cn('reader-tiptap-root select-text cursor-text', className)}
        />
      </div>
    )
  },
)

/** Document position immediately before the top-level block at `index`. */
function blockStartPos(doc: ProseMirrorNode, index: number): number {
  let pos = 0
  for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize
  return pos
}

function blockSelectionAt(
  doc: ProseMirrorNode,
  index: number,
  normalizedText: string,
  selectionRect: SelectionRect | null,
): TextSelection | null {
  if (index < 0 || index >= doc.childCount) return null
  const pos = blockStartPos(doc, index)
  const node = doc.child(index)
  return buildSelection(doc, pos + 1, pos + node.nodeSize - 1, normalizedText, selectionRect)
}

function buildSelection(
  doc: ProseMirrorNode,
  from: number,
  to: number,
  normalizedText: string,
  selectionRect: SelectionRect | null,
): TextSelection | null {
  if (from >= to) return null
  const selected = doc.textBetween(from, to, ' ')
  const selectedText = selected.trim()
  if (!selectedText) return null

  const beforeRange = doc.textBetween(0, from, ' ')
  const estimatedStart = utf16Length(beforeRange)
  const resolved = resolveNormalizedRange(normalizedText, selectedText, estimatedStart)
  const quoteText = resolved.quoteText
  const start = resolved.start
  const end = resolved.end

  const contextWindow = 80
  const beforeCtx = normalizedText.slice(Math.max(0, start - contextWindow), start)
  const afterCtx = normalizedText.slice(end, end + contextWindow)

  return {
    quoteText,
    anchorDraft: {
      quote_text: quoteText,
      text_range: { start, end, unit: 'utf16' },
      before_context: beforeCtx,
      after_context: afterCtx,
      tiptap_range: { from, to },
      block_ref: blockRefAt(doc, from),
    },
    selectionRect,
  }
}

function topLevelReaderBlock(
  root: HTMLElement,
  target: HTMLElement,
): { element: HTMLElement; index: number } | null {
  const surface = root.querySelector<HTMLElement>('.reader-surface')
  if (!surface) return null
  let current: HTMLElement | null = target
  while (current && current.parentElement !== surface) {
    if (current === surface || current === root) return null
    current = current.parentElement
  }
  if (!current) return null
  const children = Array.from(surface.children)
  const index = children.indexOf(current)
  return index >= 0 ? { element: current, index } : null
}

function rectToSelectionRect(rect: DOMRect): SelectionRect {
  return {
    top: rect.top,
    left: rect.left,
    bottom: rect.bottom,
    right: rect.right,
    width: rect.width,
    height: rect.height,
  }
}

function resolveNormalizedRange(
  normalizedText: string,
  selectedText: string,
  estimatedStart: number,
): { quoteText: string; start: number; end: number } {
  const exact = nearestRange(normalizedText, selectedText, estimatedStart)
  if (exact) return { quoteText: selectedText, ...exact }

  const whitespaceNormalized = selectedText.replace(/\s+/g, ' ')
  if (whitespaceNormalized !== selectedText) {
    const normalized = nearestRange(normalizedText, whitespaceNormalized, estimatedStart)
    if (normalized) return { quoteText: whitespaceNormalized, ...normalized }
  }

  return {
    quoteText: selectedText,
    start: estimatedStart,
    end: estimatedStart + utf16Length(selectedText),
  }
}

function nearestRange(
  text: string,
  quote: string,
  estimatedStart: number,
): { start: number; end: number } | null {
  if (!quote) return null
  let bestStart = -1
  let bestDistance = Number.POSITIVE_INFINITY
  let index = text.indexOf(quote)
  while (index !== -1) {
    const distance = Math.abs(index - estimatedStart)
    if (distance < bestDistance) {
      bestDistance = distance
      bestStart = index
    }
    index = text.indexOf(quote, index + quote.length)
  }
  if (bestStart === -1) return null
  return { start: bestStart, end: bestStart + utf16Length(quote) }
}

/** Block metadata for the top-level block containing `pos`. Frontend assistance only. */
function blockRefAt(doc: ProseMirrorNode, pos: number): AnchorBlockRef | undefined {
  const $pos = doc.resolve(pos)
  if ($pos.depth < 1) return undefined
  return {
    index: $pos.index(0),
    node_type: $pos.node(1).type.name,
    from: $pos.before(1),
    to: $pos.after(1),
  }
}

/** Viewport rect of the current DOM selection, for positioning the floating toolbar. */
function domSelectionRect(): SelectionRect | null {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0)
  if (typeof range.getBoundingClientRect !== 'function') return null
  const rect = range.getBoundingClientRect()
  return {
    top: rect.top,
    left: rect.left,
    bottom: rect.bottom,
    right: rect.right,
    width: rect.width,
    height: rect.height,
  }
}

function utf16Length(str: string): number {
  let len = 0
  for (const ch of str) {
    const cp = ch.codePointAt(0) ?? 0
    len += cp > 0xffff ? 2 : 1
  }
  return len
}
