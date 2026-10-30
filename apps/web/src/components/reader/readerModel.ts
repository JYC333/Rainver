import type { ReaderAnnotation, ReaderCommentThread } from '../../types/api'

export type ReaderAnnotationType = ReaderAnnotation['annotation_type']

/** Annotation list state owned by the wrapper; absent means loaded. */
export type ReaderAnnotationsStatus = { state: 'loading' } | { state: 'error'; error: unknown; retry: () => void }

/** Taken when an annotation create/archive starts; see useReaderAnnotations. */
export interface ReaderAnnotationChange { scopeKey: string; epoch: number }

/** Whether a create/archive response may still change the shown list. */
export interface ReaderAnnotationAuthority {
  begin: () => ReaderAnnotationChange
  accepts: (change: ReaderAnnotationChange) => boolean
}

/** Comment-thread list state for the selected annotation; absent means loaded. */
export type ReaderThreadsStatus = { state: 'loading' } | { state: 'error'; error: unknown; retry: () => void }

/** Document-order position: tiptap_range.from, then text_range.start, else end of list. */
function anchorSortKey(ann: ReaderAnnotation): number {
  return (
    ann.anchor_json.tiptap_range?.from ??
    ann.anchor_json.text_range?.start ??
    Number.POSITIVE_INFINITY
  )
}

/**
 * A summary-level viewer gets the annotation without its body: the server
 * returns an empty quote and anchor. Such an annotation has nothing to show,
 * comment on, or keep a draft for.
 */
export function annotationBodyWithheld(annotation: Pick<ReaderAnnotation, 'quote_text' | 'anchor_json'>): boolean {
  return !annotation.quote_text && Object.keys(annotation.anchor_json ?? {}).length === 0
}

export function activeAnnotationsInDocumentOrder(
  annotations: ReaderAnnotation[],
): ReaderAnnotation[] {
  return annotations
    .filter((ann) => ann.status === 'active')
    .sort((a, b) => {
      const diff = anchorSortKey(a) - anchorSortKey(b)
      if (diff !== 0) return diff
      return a.created_at.localeCompare(b.created_at)
    })
}

export function annotationCountsByType(
  annotations: ReaderAnnotation[],
): Record<ReaderAnnotationType, number> {
  const counts: Record<ReaderAnnotationType, number> = {
    highlight: 0,
    comment: 0,
    excerpt: 0,
    bookmark: 0,
  }
  for (const ann of annotations) counts[ann.annotation_type] += 1
  return counts
}

export function openThreadCount(threads: ReaderCommentThread[]): number {
  return threads.filter((t) => t.status === 'open').length
}

function nodeText(node: unknown): string {
  if (!node || typeof node !== 'object') return ''
  const value = node as { text?: unknown; content?: unknown }
  if (typeof value.text === 'string') return value.text
  return Array.isArray(value.content) ? value.content.map(nodeText).join('') : ''
}

const comparableTitle = (value: string) => value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()

/**
 * How the document body's opening heading relates to its title:
 * - `h1`: it opens with the title as a level-1 heading, which then serves as
 *   the page's main heading, so the Reader does not print the title again;
 * - `lower`: it opens with the title at a lower level, so the Reader keeps its
 *   own h1 for structure but only for assistive technology, not visually;
 * - `none`: no matching opening heading.
 * The body tree is never edited for this: anchors depend on its positions.
 */
export function documentTitleHeading(contentJson: Record<string, unknown>, title: string): 'h1' | 'lower' | 'none' {
  const first = Array.isArray(contentJson.content) ? contentJson.content[0] as { type?: unknown; attrs?: { level?: unknown } } | undefined : undefined
  if (!first || first.type !== 'heading' || !title.trim()) return 'none'
  if (comparableTitle(nodeText(first)) !== comparableTitle(title)) return 'none'
  return (first.attrs?.level ?? 1) === 1 ? 'h1' : 'lower'
}
