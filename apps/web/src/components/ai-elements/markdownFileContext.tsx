import { createContext, useContext, useState, type ReactNode } from 'react'
import { useAppTranslation } from '../../i18n'

export const MarkdownFileContext = createContext<((path: string) => void) | null>(null)

/** Produced only by the trusted post-sanitize local-link transform. */
export function LocalMarkdownLink({ href, children }: { href?: string; children?: ReactNode }) {
  const open = useContext(MarkdownFileContext)
  const [unavailable, setUnavailable] = useState(false)
  const { t } = useAppTranslation()
  return <>
    <button type="button" role="link" title={href} className="wrap-anywhere text-left font-medium text-primary underline" onClick={() => {
      if (open && href) open(href)
      else setUnavailable(true)
    }}>{children}</button>
    {unavailable && <span role="status" className="ml-2 text-sm text-muted-foreground">{t('file_preview.unavailable')}</span>}
  </>
}

export function LocalMarkdownImage({ src, alt }: { src: string; alt?: string }) {
  const open = useContext(MarkdownFileContext)
  const { t } = useAppTranslation()
  return <button type="button" className="my-2 block max-w-full break-all rounded-md border px-3 py-2 text-left text-sm text-primary" disabled={!open} onClick={() => open?.(src)}>
    {alt || t('file_preview.open_image')}{!open && ` · ${t('file_preview.unavailable')}`}
  </button>
}
