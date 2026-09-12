import { useState, useEffect } from 'react'
import { safeHttpUrl } from '../lib/safeHttpUrl'
import { cn } from '../lib/utils'

function initialsFrom(name: string | null | undefined, email: string | null | undefined) {
  const n = (name ?? '').trim()
  if (n.length >= 2) return n.slice(0, 2).toUpperCase()
  if (n.length === 1) return n.toUpperCase()
  const local = (email ?? '').split('@')[0]?.trim() ?? ''
  if (local.length >= 2) return local.slice(0, 2).toUpperCase()
  if (local.length === 1) return local.toUpperCase()
  return '?'
}

export interface UserAvatarProps {
  avatarUrl: string | null | undefined
  displayName: string | null | undefined
  email?: string | null | undefined
  className?: string
  /** Extra classes on the img element (e.g. rounded-full) */
  imgClassName?: string
}

/**
 * Avatar with safe fallback: broken / blocked URLs (common with Google OAuth)
 * show initials only — no broken-image icon overlay.
 */
export function UserAvatar({
  avatarUrl,
  displayName,
  email,
  className,
  imgClassName,
}: UserAvatarProps) {
  const [failed, setFailed] = useState(false)
  const url = safeHttpUrl(avatarUrl)

  useEffect(() => {
    setFailed(false)
  }, [url])

  const initials = initialsFrom(displayName, email)

  if (!url || failed) {
    return (
      <span
        className={cn(
          'flex size-full items-center justify-center rounded-full bg-muted text-[11px] font-semibold text-accent-foreground',
          className,
        )}
        aria-hidden
      >
        {initials}
      </span>
    )
  }

  return (
    <img
      src={url}
      alt=""
      referrerPolicy="no-referrer"
      loading="lazy"
      decoding="async"
      className={cn('size-full object-cover', imgClassName)}
      onError={() => setFailed(true)}
    />
  )
}
