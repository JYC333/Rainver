import { Badge, type BadgeProps } from './ui/badge'
import type { ObjectVisibility } from '../types/api'

interface ScopeBadgeProps {
  visibility?: ObjectVisibility | null
  spaceName?: string
  ownerLabel?: string
  omitShared?: boolean
  className?: string
}

const VISIBILITY_LABELS: Record<string, { label: string; variant: BadgeProps['variant'] }> = {
  private: { label: 'Only me', variant: 'warning' },
  selected_users: { label: 'Selected people', variant: 'destructive' },
  space_shared: { label: 'Shared in scope', variant: 'muted' },
}

export function ScopeBadge({ visibility, spaceName, ownerLabel, omitShared = false, className }: ScopeBadgeProps) {
  if (!visibility) return null
  const normalized = String(visibility).toLowerCase()
  if (normalized === 'space_shared' && omitShared) return null

  const known = VISIBILITY_LABELS[normalized]
  if (!known) {
    return (
      <Badge variant="outline" className={className} title="Unknown scope">
        Unknown scope
      </Badge>
    )
  }

  const icon = normalized === 'private' ? '🔒' : normalized === 'selected_users' ? '🔐' : '👥'
  const detail = ownerLabel ?? spaceName
  return (
    <Badge variant={known.variant} className={className} title={detail ? `${known.label}: ${detail}` : known.label}>
      {icon} {known.label}
    </Badge>
  )
}
