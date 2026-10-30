import type { ReactNode } from 'react'
import { documentTitleHeading } from './readerModel'

/**
 * The article's full title and its source metadata, above the body and outside
 * the anchored document tree. When the body opens with the same title as an h1,
 * that heading is the title and only the metadata shows; when it opens with the
 * title at a lower level, the lead keeps an h1 for assistive technology only,
 * so the page always has one main heading without printing the title twice.
 */
export function ReaderDocumentLead({ title, contentJson, meta }: {
  title: string
  contentJson: Record<string, unknown>
  meta?: ReactNode
}) {
  const heading = title.trim() ? documentTitleHeading(contentJson, title) : 'h1'
  const visibleTitle = heading === 'none'
  if (!visibleTitle && heading === 'h1' && !meta) return null
  // Without its own title line the metadata sits just above the body's heading.
  return <header className={visibleTitle ? 'reader-lead' : 'reader-lead reader-lead-compact'}>
    {visibleTitle && <h1 className="reader-lead-title">{title}</h1>}
    {heading === 'lower' && <h1 className="sr-only">{title}</h1>}
    {meta && <div className="reader-lead-meta">{meta}</div>}
  </header>
}
