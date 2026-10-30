import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import { Extension, Mark, Node, mergeAttributes } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { BlockIdAttribute } from './blockIds'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { safeAppPath, safeHttpUrl } from '../../lib/safeHttpUrl'
import { isSameOriginImage } from '../ai-elements/safeMarkdown'
import { cn } from '../../lib/utils'
import type { ReaderAnnotation } from '../../types/api'
import { anchorForSelection, resolveAnnotationAnchors, type AnchorResolution, type DocumentVersion } from '../reader/anchorResolution'
import { anchorAt, documentHeadings, findInDocument, flattenDocument, locateAnchor, type FlatText, type LocatedPosition, type ReaderHeading, type ReadingAnchor } from './readerNavigation'
import { scrollBehavior } from '../../lib/motion'

interface AnchorBlockRef {
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
  /** The selected words with whitespace collapsed: the annotation's quote. */
  quoteText: string
  /** The selected text as it reads (line breaks, indentation, runs of spaces kept): what "copy" copies. */
  selectedText: string
  anchorDraft: AnchorDraft
  /** Viewport-relative rect of the selected range, when the DOM can provide one. */
  selectionRect: SelectionRect | null
}

/** Imperative block-level access for keyboard-driven reading. */
export interface ReadOnlyTiptapReaderHandle {
  documentSize(): number
  rangeSelection(from: number, to: number, previous?: { from: number; to: number }): TextSelection | null
  blockCount(): number
  /** Full-block selection for keyboard highlight/comment on the focused block. */
  blockSelection(index: number): TextSelection | null
  scrollToBlock(index: number): void
  /** The place at the top of `container` (the scrolling pane), or null before the document is shown. */
  readingAnchor(container: HTMLElement): ReadingAnchor | null
  /** Where a saved place is now (see locateAnchor). */
  locate(anchor: ReadingAnchor, sameStructure: boolean): LocatedPosition
  /** Scroll `container` so tree position `pos` is at its top. */
  scrollToPos(pos: number, container: HTMLElement, smooth?: boolean): void
  headings(): ReaderHeading[]
  /** Marks every match of `query` and returns how many there are. */
  find(query: string): number
  /** Makes match `index` the current one and scrolls to it. */
  findGo(index: number): void
}

export interface ReaderCodeCopyLabels { copy: string; copied: string; failed: string }

interface ReadOnlyTiptapReaderProps {
  contentJson: Record<string, unknown>
  /** Canonical normalized text: trim → split on ≥2 newlines → trim paragraphs → join ' '.
   *  Must match the server's normalizeReaderText output. A new anchor's text_range is
   *  placed in it only where provable (see anchorForSelection). */
  normalizedText: string
  className?: string
  /**
   * Whether a cross-origin image may load inline. Off unless the document is
   * one the person chose to capture — see {@link ReaderImage}.
   */
  remoteImages?: boolean
  onTextSelected?: (selection: TextSelection | null) => void
  /** Completed native range selection, distinct from a synthetic paragraph focus. */
  onSelectionCommitted?: (selection: TextSelection) => void
  onBlockFocused?: (index: number | null) => void
  onAnnotationClick?: (annotationId: string) => void
  /** Makes "[ref-N]" citation tokens clickable; called with the token (e.g. "ref-3"). */
  onReferenceClick?: (referenceId: string) => void
  annotations?: ReaderAnnotation[]
  selectedAnnotationId?: string | null
  /** Top-level block with the keyboard focus indicator. */
  focusedBlockIndex?: number | null
  /** Versions of the document shown; annotations are placed against these (see anchorResolution). */
  documentVersion?: DocumentVersion
  /** Where each annotation landed in the current document, after every content or annotation change. */
  onAnchorsResolved?: (resolved: Map<string, AnchorResolution>) => void
  /**
   * Called with an image the reader is showing. Only an `<img>` actually
   * rendered under the document's image policy can be opened, with the address
   * it already loaded; an image shown as a link stays a link.
   */
  onImageOpen?: (image: { src: string; alt: string }) => void
  /** Labels for the copy button on code blocks; without them code blocks have none. */
  codeCopyLabels?: ReaderCodeCopyLabels
}

const highlightPluginKey = new PluginKey<DecorationSet>('annotationHighlight')
/** In-document find paints at most this many matches, centred on the current one. */
const FIND_PAINT_WINDOW = 300

/**
 * The copy button of a code block: a widget at the start of the block's text,
 * outside the document tree, so selections, quotes and anchors see only the
 * code. It copies the block's text exactly as stored.
 */
function codeCopyWidget(blockPos: number, labels: ReaderCodeCopyLabels) {
  return Decoration.widget(blockPos + 1, view => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'reader-code-copy'
    button.contentEditable = 'false'
    button.dataset.copyCode = 'true'
    button.textContent = labels.copy
    let reset = 0
    const show = (label: string) => { button.textContent = label; window.clearTimeout(reset); reset = window.setTimeout(() => { button.textContent = labels.copy }, 1500) }
    button.addEventListener('mousedown', event => event.preventDefault())
    button.addEventListener('click', event => {
      event.stopPropagation()
      const block = view.state.doc.nodeAt(blockPos)
      if (!block || block.type.name !== 'codeBlock' || !navigator.clipboard) return show(labels.failed)
      void navigator.clipboard.writeText(block.textContent).then(() => show(labels.copied), () => show(labels.failed))
    })
    return button
  }, { side: -1, ignoreSelection: true, key: `copy-code:${blockPos}:${labels.copy}`, stopEvent: () => true })
}

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
    const href = safeHttpUrl(typeof rawHref === 'string' ? rawHref : null)
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

/**
 * An image in a reader document.
 *
 * Whether a cross-origin one may load depends on where the document came from,
 * not on the renderer. A captured article's images are part of the article the
 * person chose to read, and the Reader keeps them by design
 * (`image_policy: "remote_reference"`). A *model-authored* document — a Library
 * summary or digest, written by a Run over ingested third-party items — is
 * downstream of prompt injection, and a cross-origin `<img>` there is fetched
 * with no click, from the reader's IP, to a URL the model chose.
 *
 * So `remoteImages` is off unless a caller says otherwise, and with it off an
 * external source renders as a link, exactly as chat markdown does (D5).
 * Captured pages and model-authored documents do not share one image rule.
 * `safeHttpUrl` alone accepts any host.
 */
/**
 * The image policy a Reader instance renders with. A holder, not a plain
 * option, so it can change without rebuilding the editor; the component changes
 * it only in the step that also draws the document it applies to (see the
 * content step in ReadOnlyTiptapReader), never ahead of the document.
 */
export interface ReaderImagePolicy { remoteImages: boolean }

// Passed as a function: Tiptap deep-copies plain option objects on configure(),
// which would detach the holder from the component that updates it.
const ReaderImage = Node.create<{ remoteImagesAllowed: () => boolean }>({
  name: 'image',
  group: 'block',
  atom: true,
  selectable: true,

  addOptions() {
    return { remoteImagesAllowed: () => false }
  },

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
    const raw = typeof rawSrc === 'string' ? rawSrc : null
    const src = safeAppPath(raw) ?? safeHttpUrl(raw)
    if (!src) return ['span', mergeAttributes(rest, { class: 'reader-image-missing' })]
    if (!this.options.remoteImagesAllowed() && !isSameOriginImage(src)) {
      // Named, not silently dropped: the person can see that the document had
      // an image here and where it points, and open it if they choose.
      let domain = src
      try {
        domain = new URL(src).hostname
      } catch {
        /* safeHttpUrl already parsed it */
      }
      const alt = typeof rest.alt === 'string' && rest.alt.trim() ? `${rest.alt.trim()} — ` : ''
      return [
        'a',
        {
          href: src,
          title: src,
          target: '_blank',
          rel: 'noopener noreferrer',
          class: 'reader-image-external',
          'data-external-image': 'true',
        },
        `${alt}${domain}`,
      ]
    }
    return [
      'img',
      mergeAttributes(rest, {
        src,
        loading: 'lazy',
        referrerpolicy: 'no-referrer-when-downgrade',
        // Opens larger in the Reader (the same loaded image, nothing new is fetched).
        tabindex: '0',
        'data-reader-image': 'true',
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

// A stored color is written by any Space member and lands in an inline style,
// so only a hex color or a bare color name is used; anything else could add
// declarations (a background:url() is a zero-click external request).
const SAFE_ANNOTATION_COLOR = /^(?:#[0-9a-f]{3,8}|[a-z]{3,20})$/i

function annotationColor(ann: ReaderAnnotation): string {
  if (ann.color && SAFE_ANNOTATION_COLOR.test(ann.color)) return ann.color
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
    remoteImages = false,
    onTextSelected,
    onSelectionCommitted,
    onBlockFocused,
    onAnnotationClick,
    onReferenceClick,
    annotations,
    selectedAnnotationId,
    focusedBlockIndex,
    documentVersion,
    onAnchorsResolved,
    onImageOpen,
    codeCopyLabels,
  }, ref) {
    const onAnchorsResolvedRef = useRef(onAnchorsResolved)
    onAnchorsResolvedRef.current = onAnchorsResolved
    // Resolved placements; nothing is painted from a stored range that was not checked against this document.
    const resolvedRef = useRef<Map<string, AnchorResolution>>(new Map())
    const committedRef = useRef(onSelectionCommitted)
    committedRef.current = onSelectionCommitted
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
    const onImageOpenRef = useRef(onImageOpen)
    onImageOpenRef.current = onImageOpen
    const codeLabelsRef = useRef(codeCopyLabels)
    codeLabelsRef.current = codeCopyLabels
    // Bumped whenever anything the decorations read through refs changes; the
    // plugin reuses its set otherwise (a selection change redraws nothing).
    const decorationVersion = useRef(0)
    // In-document find: the matches and the current one, painted by the plugin below.
    const findRef = useRef<{ matches: Array<{ from: number; to: number }>; active: number }>({ matches: [], active: -1 })
    // The text of the document shown, rebuilt only when it changes.
    const flatRef = useRef<{ doc: ProseMirrorNode; flat: FlatText } | null>(null)
    const flatOf = (doc: ProseMirrorNode) => {
      if (flatRef.current?.doc !== doc) flatRef.current = { doc, flat: flattenDocument(doc) }
      return flatRef.current.flat
    }

    const highlightExtension = useMemo(
      () => {
        let cached: { doc: ProseMirrorNode; version: number; set: DecorationSet } | null = null
        return Extension.create({
          name: 'annotationHighlight',
          addProseMirrorPlugins() {
            return [
              new Plugin({
                key: highlightPluginKey,
                props: {
                  decorations(state) {
                    if (cached && cached.doc === state.doc && cached.version === decorationVersion.current) return cached.set
                    const anns = annotationsRef.current
                    const selectedId = selectedIdRef.current
                    const decos: Decoration[] = []
                    const docSize = state.doc.content.size
                    for (const ann of anns) {
                      if (ann.status !== 'active') continue
                      const placed = resolvedRef.current.get(ann.id)
                      if (placed?.state !== 'located') continue
                      const from = Math.max(0, Math.min(placed.from, docSize))
                      const to = Math.max(from, Math.min(placed.to, docSize))
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
                    const codeLabels = codeLabelsRef.current
                    if (codeLabels) state.doc.descendants((node, pos) => {
                      if (node.type.name === 'codeBlock') { decos.push(codeCopyWidget(pos, codeLabels)); return false }
                      return true
                    })
                    // Matches are painted around the current one (the count and Enter cover all of them):
                    // painting every match of a common word in a long document costs more than it shows.
                    const { matches, active } = findRef.current
                    const paintFrom = Math.max(0, Math.min(Math.max(active, 0) - FIND_PAINT_WINDOW / 2, matches.length - FIND_PAINT_WINDOW))
                    matches.slice(paintFrom, paintFrom + FIND_PAINT_WINDOW).forEach((match, offset) => {
                      const index = paintFrom + offset
                      if (match.to > docSize) return
                      decos.push(Decoration.inline(match.from, match.to, {
                        class: index === findRef.current.active ? 'reader-find-match reader-find-current' : 'reader-find-match',
                      }))
                    })
                    const focused = focusedBlockRef.current
                    if (focused != null && focused >= 0 && focused < state.doc.childCount) {
                      const pos = blockStartPos(state.doc, focused)
                      decos.push(
                        Decoration.node(pos, pos + state.doc.child(focused).nodeSize, {
                          class: 'reader-block-focused',
                        }),
                      )
                    }
                    const set = DecorationSet.create(state.doc, decos)
                    cached = { doc: state.doc, version: decorationVersion.current, set }
                    return set
                  },
                },
              }),
            ]
          },
        })
      },
      // Extension is stable; refs keep values current without recreation.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [],
    )

    // Changed only in the content step below, together with the document it
    // applies to: see ReaderImagePolicy.
    const imagePolicy = useRef<ReaderImagePolicy>({ remoteImages }).current
    const extensions = useMemo(
      () => [...readerContentExtensions(imagePolicy), highlightExtension],
      // The policy holder and the highlight extension are stable for this instance.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [],
    )

    const editor = useEditor({
      extensions,
      content: contentJson,
      editable: false,
      editorProps: {
        attributes: {
          class: 'reader-surface',
        },
        handleDOMEvents: {
          pointerup: (view, event) => {
            if (event.button !== 0) return false
            // Let the browser/ProseMirror finish the native range first. Never
            // turn a collapsed paragraph click into an automatic annotation.
            window.setTimeout(() => {
              if (view.isDestroyed) return
              const range = window.getSelection()
              if (!range || range.isCollapsed || !view.dom.contains(range.anchorNode) || !view.dom.contains(range.focusNode)) return
              const { from, to } = view.state.selection
              const selected = buildSelection(view.state.doc, from, to, normalizedText, domSelectionRect())
              if (selected) committedRef.current?.(selected)
            }, 0)
            return false
          },
        },
      },
      onSelectionUpdate: ({ editor: e }) => {
        const { from, to } = e.state.selection
        if (suppressClickSelectionUpdateRef.current && from === to) return
        onSelectRef.current?.(buildSelection(e.state.doc, from, to, normalizedText, domSelectionRect()))
      },
    })

    useImperativeHandle(ref, () => ({
      documentSize: () => editor?.state.doc.content.size ?? 0,
      rangeSelection: (start: number, end: number, previous?: { from: number; to: number }) => {
        if (!editor) return null
        const doc = editor.state.doc
        let from = Math.max(0, Math.min(doc.content.size, start))
        let to = Math.max(from, Math.min(doc.content.size, end))
        // Never cut the UTF-16 halves of an emoji when a slider moves one unit.
        const split = (pos: number) => pos > 0 && pos < doc.content.size && /[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(doc.textBetween(pos - 1, pos + 1, ' '))
        if (split(from)) from += previous && from > previous.from ? 1 : -1
        if (split(to)) to += previous && to < previous.to ? -1 : 1
        return buildSelection(doc, from, to, normalizedText, null)
      },
      blockCount: () => editor?.state.doc.childCount ?? 0,
      blockSelection: (index: number) => {
        if (!editor) return null
        return blockSelectionAt(editor.state.doc, index, normalizedText, null)
      },
      scrollToBlock: (index: number) => {
        if (!editor || index < 0 || index >= editor.state.doc.childCount) return
        const dom = editor.view.nodeDOM(blockStartPos(editor.state.doc, index))
        if (dom instanceof HTMLElement) dom.scrollIntoView({ behavior: scrollBehavior(), block: 'nearest' })
      },
      readingAnchor: (container: HTMLElement) => {
        if (!editor || editor.isDestroyed) return null
        const doc = editor.state.doc
        if (!doc.textContent.trim()) return null
        const bounds = container.getBoundingClientRect()
        const surface = editor.view.dom
        // The first block whose bottom is below the pane's top edge.
        // Blocks are in reading order, so a binary search keeps this cheap on long documents.
        const blocks = surface.children
        let index = 0, high = blocks.length - 1
        while (index < high) {
          const middle = (index + high) >> 1
          if (blocks[middle].getBoundingClientRect().bottom <= bounds.top + 4) index = middle + 1; else high = middle
        }
        const block = blocks[index]
        let pos = blockStartPos(doc, Math.min(index, doc.childCount - 1)) + 1
        if (block) {
          const rect = block.getBoundingClientRect()
          const hit = editor.view.posAtCoords({ left: rect.left + Math.min(24, rect.width / 2), top: Math.max(rect.top + 2, bounds.top + 4) })
          if (hit && hit.pos >= pos - 1) pos = hit.pos
        }
        return anchorAt(doc, flatOf(doc), pos)
      },
      locate: (anchor: ReadingAnchor, sameStructure: boolean) => editor ? locateAnchor(editor.state.doc, flatOf(editor.state.doc), anchor, sameStructure) : null,
      scrollToPos: (pos: number, container: HTMLElement, smooth = false) => {
        if (!editor || editor.isDestroyed) return
        const clamped = Math.max(0, Math.min(pos, editor.state.doc.content.size))
        let top: number
        try { top = editor.view.coordsAtPos(clamped).top } catch { return }
        const offset = top - container.getBoundingClientRect().top - 8
        container.scrollTo({ top: container.scrollTop + offset, behavior: smooth ? scrollBehavior() : 'auto' })
      },
      headings: () => editor ? documentHeadings(editor.state.doc) : [],
      find: (query: string) => {
        if (!editor) return 0
        // The first match is current at once: one redraw, not two.
        const matches = findInDocument(flatOf(editor.state.doc), query)
        findRef.current = { matches, active: matches.length ? 0 : -1 }
        decorationVersion.current++
        editor.view.dispatch(editor.state.tr.setMeta(highlightPluginKey, true))
        if (matches.length) scrollToMatch(matches[0].from)
        return matches.length
      },
      findGo: (index: number) => {
        if (!editor) return
        const match = findRef.current.matches[index]
        findRef.current = { ...findRef.current, active: match ? index : -1 }
        decorationVersion.current++
        editor.view.dispatch(editor.state.tr.setMeta(highlightPluginKey, true))
        if (match) scrollToMatch(match.from)
      },
    }), [editor, normalizedText])

    function scrollToMatch(from: number) {
      if (!editor) return
      const dom = editor.view.domAtPos(from).node
      const element = dom instanceof HTMLElement ? dom : dom.parentElement
      element?.scrollIntoView?.({ behavior: scrollBehavior(), block: 'center' })
    }

    // One step draws the document from the current props under the current
    // policy. The editor's own tree is never redrawn under a policy that is not
    // its own: a policy change first clears the view while the old policy still
    // applies, then switches the policy, then draws this render's content. So an
    // image URL in the previous document is never rendered under a newly allowed
    // policy, and one in the new document never under a previous allowed policy.
    // A policy-only change redraws the same document from scratch (positions
    // unchanged); like any content change, it clears the browser selection.
    const contentKey = useMemo(() => JSON.stringify(contentJson), [contentJson])
    const drawn = useRef<{ contentKey: string; remoteImages: boolean } | null>(null)
    useEffect(() => {
      if (!editor) return
      const last = drawn.current
      if (last && last.contentKey === contentKey && last.remoteImages === remoteImages) return
      if (last && last.remoteImages !== remoteImages) {
        editor.commands.setContent({ type: 'doc', content: [{ type: 'paragraph' }] }, { emitUpdate: false })
      }
      imagePolicy.remoteImages = remoteImages
      // Matches belong to the text they were found in.
      findRef.current = { matches: [], active: -1 }
      decorationVersion.current++
      editor.commands.setContent(contentJson)
      drawn.current = { contentKey, remoteImages }
      // contentKey stands in for contentJson: an equal document in a new object must not reset the reader.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [editor, contentKey, remoteImages])

    // Place annotations against the document now shown (after the content sync above).
    const versionKey = `${documentVersion?.contentHash ?? ''}|${documentVersion?.structureHash ?? ''}`
    useEffect(() => {
      if (!editor) return
      resolvedRef.current = resolveAnnotationAnchors(editor.state.doc, annotations ?? [], {
        contentHash: documentVersion?.contentHash ?? '', structureHash: documentVersion?.structureHash ?? null,
      })
      onAnchorsResolvedRef.current?.(resolvedRef.current)
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [editor, contentKey, annotations, versionKey])

    // Dispatch a no-op transaction so the decoration plugin re-evaluates refs.
    useEffect(() => {
      if (!editor) return
      decorationVersion.current++
      editor.view.dispatch(
        editor.state.tr.setMeta(highlightPluginKey, true),
      )
    }, [editor, annotations, selectedAnnotationId, focusedBlockIndex, contentKey, versionKey])

    function openImage(target: HTMLElement): boolean {
      // Only an image the policy let the reader load: its loaded address, never the stored one.
      if (!(target instanceof HTMLImageElement) || !onImageOpenRef.current) return false
      const src = target.currentSrc || target.getAttribute('src')
      if (!src) return false
      onImageOpenRef.current({ src, alt: target.alt })
      return true
    }

    function handleClick(e: React.MouseEvent<HTMLDivElement>) {
      const target = e.target as HTMLElement
      if (target.closest('[data-copy-code]')) return
      if (openImage(target)) return
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
      if (!clickedBlock || focusedBlockRef.current === clickedBlock.index) {
        onBlockFocusedRef.current?.(null)
        onSelectRef.current?.(null)
        return
      }
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
      <div onClick={handleClick} onKeyDown={event => {
        if ((event.key === 'Enter' || event.key === ' ') && openImage(event.target as HTMLElement)) event.preventDefault()
      }}>
        <EditorContent
          editor={editor}
          className={cn('reader-tiptap-root select-text cursor-text', className)}
        />
      </div>
    )
  },
)

/**
 * The Reader's document schema: every node and mark a stored Reader document
 * may contain (`@rainver/reader-document` normalizes to exactly this). Exported
 * so tests check stored trees against the schema the Reader actually uses.
 */
export function readerContentExtensions(imagePolicy: ReaderImagePolicy = { remoteImages: false }) {
  return [
    StarterKit.configure({ link: false }),
    // Declared, not generated: the reader never saves, but a schema
    // without the attribute would drop ids from the document it reasons
    // about. Minting ids in a read-only view would be pure churn.
    BlockIdAttribute,
    ReaderLink,
    ReaderImage.configure({ remoteImagesAllowed: () => imagePolicy.remoteImages }),
    ReaderTable,
    ReaderTableRow,
    ReaderTableCell,
    ReaderTableHeader,
  ]
}

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
  // Quote and context come from the Reader's own text at the selected place
  // (see anchorForSelection); the stored range only where it is provable.
  const anchor = anchorForSelection(doc, from, to, normalizedText)
  if (!anchor) return null
  const quoteText = anchor.quoteText
  // Not provable: a range just past the end of the normalized text, which the
  // server's check can never verify (the annotation is stored unverified)
  // and nothing uses to place it.
  const { start, end } = anchor.textRange ?? { start: normalizedText.length, end: normalizedText.length + quoteText.length }
  const beforeCtx = anchor.before
  const afterCtx = anchor.after

  // Blocks are separated by a line break; text inside a block is kept as it is.
  const selectedText = doc.textBetween(from, to, '\n').replace(/^\n+|\n+$/g, '')

  return {
    quoteText,
    selectedText,
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
