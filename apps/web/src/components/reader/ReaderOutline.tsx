import { X } from 'lucide-react'
import { Button } from '../ui/button'
import { useAppTranslation } from '../../i18n'
import type { ReaderHeading } from '../editor/readerNavigation'

/** The document's headings; the one being read is marked. Docked beside the text, or laid over it when narrow. */
export function ReaderOutline({ headings, currentBlock, overlay, onSelect, onClose }: {
  headings: ReaderHeading[]
  /** Top-level block at the top of the view, for marking the current section. */
  currentBlock: number | null
  overlay: boolean
  onSelect: (heading: ReaderHeading) => void
  onClose: () => void
}) {
  const { t } = useAppTranslation()
  const current = currentBlock == null ? -1 : headings.reduce((found, heading, index) => heading.blockIndex <= currentBlock ? index : found, -1)
  const top = Math.min(...headings.map(heading => heading.level), 6)
  return <nav aria-label={t('reading.outline')} className={`reader-outline${overlay ? ' reader-outline-overlay' : ''} flex h-full flex-col overflow-y-auto border-r border-border bg-background`}>
    <div className="sticky top-0 flex items-center justify-between border-b border-border bg-background px-3 py-2">
      <p className="text-sm font-medium">{t('reading.outline')}</p>
      <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label={t('reading.hideOutline')}><X className="size-4" /></Button>
    </div>
    {headings.length === 0 ? <p className="p-3 text-xs text-muted-foreground">{t('reading.outlineEmpty')}</p> :
      <ol className="space-y-0.5 p-2">
        {headings.map((heading, index) => <li key={`${heading.pos}`}>
          <button type="button" aria-current={index === current ? 'location' : undefined}
            className={`w-full rounded-md py-1.5 pr-2 text-left text-sm leading-snug hover:bg-accent ${index === current ? 'bg-accent/60 font-medium text-foreground' : 'text-muted-foreground'}`}
            style={{ paddingLeft: `${0.5 + (heading.level - top) * 0.75}rem` }}
            onClick={() => onSelect(heading)}>{heading.text}</button>
        </li>)}
      </ol>}
  </nav>
}
