import { forwardRef, type AnchorHTMLAttributes, type ReactNode } from 'react'
import { safeHttpUrl } from '../lib/safeHttpUrl'

type SafeExternalLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'target' | 'rel'> & {
  href: string | null | undefined
  children: ReactNode
}

/** Renders an http(s) link, or nothing when the href is not a safe protocol. */
export const SafeExternalLink = forwardRef<HTMLAnchorElement, SafeExternalLinkProps>(
  function SafeExternalLink({ href, children, ...props }, ref) {
    const safe = safeHttpUrl(href)
    if (!safe) return null
    return (
      <a ref={ref} href={safe} target="_blank" rel="noopener noreferrer" {...props}>
        {children}
      </a>
    )
  },
)
