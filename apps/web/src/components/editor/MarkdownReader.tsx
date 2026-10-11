import { useMemo } from 'react'
import { ReadOnlyTiptapReader } from './ReadOnlyTiptapReader'
import { markdownToPlainText, markdownToProseMirrorJson } from './markdownToProseMirror'

interface MarkdownReaderProps {
  markdown: string
  className?: string
}

/**
 * Renders a markdown string through the shared reading core (L1,
 * `ReadOnlyTiptapReader`) instead of a second rendering engine. Markdown is
 * translated to Tiptap/ProseMirror JSON at the data layer (L0); this
 * component does not implement any of its own typography or block layout.
 *
 * This component does not wire annotation or selection. Callers that need
 * it should extend this component rather than reimplementing
 * `ReadOnlyTiptapReader` usage elsewhere.
 */
export function MarkdownReader({ markdown, className }: MarkdownReaderProps) {
  const doc = useMemo(() => markdownToProseMirrorJson(markdown), [markdown])
  const normalizedText = useMemo(() => markdownToPlainText(doc), [doc])
  return (
    <ReadOnlyTiptapReader
      contentJson={doc as unknown as Record<string, unknown>}
      normalizedText={normalizedText}
      className={className}
    />
  )
}
