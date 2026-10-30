import { markdownToReaderDocument, type ReaderNode } from '@rainver/reader-document'

/**
 * Markdown → the Reader document tree `ReadOnlyTiptapReader` renders. The
 * converter itself is `@rainver/reader-document` (markdown-it), shared with the
 * server's canonical reading writer, so the browser and stored documents agree
 * on every node and mark.
 */
export function markdownToProseMirrorJson(markdown: string): ReaderNode {
  return markdownToReaderDocument(markdown)
}

/** Best-effort plain text extraction, used only for the reader's `normalizedText` prop
 *  (context slicing for selection features). Brief/Artifacts markdown rendering does not
 *  wire annotations yet, so this does not need to match the server's exact normalization. */
export function markdownToPlainText(doc: ReaderNode): string {
  const parts: string[] = []
  const walk = (node: ReaderNode) => {
    if (node.type === 'text' && node.text) parts.push(node.text)
    for (const child of node.content ?? []) walk(child)
    if (node.type !== 'text' && node.type !== 'doc') parts.push('\n\n')
  }
  walk(doc)
  return parts.join('').replace(/\n{3,}/g, '\n\n').trim()
}
