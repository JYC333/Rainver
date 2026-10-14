import { useEffect } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from './button'
import { cn } from '../../lib/utils'
import { useAppTranslation } from '../../i18n'
import { formatNumber } from '../../i18n/format'

interface PaginationProps {
  total: number
  limit: number
  offset: number
  onChange: (offset: number) => void
  className?: string
}

export function Pagination({ total, limit, offset, onChange, className }: PaginationProps) {
  const { t } = useAppTranslation()
  const page     = Math.floor(offset / limit) + 1
  const pages    = Math.ceil(total / limit)
  const hasPrev  = offset > 0
  const hasNext  = offset + limit < total

  // An offset past the end — the list shrank under the caller, say by the
  // last item of page two leaving the filter — is an empty page with no way
  // back once the controls are hidden. Settle it onto the last real page.
  const lastPageOffset = total > 0 ? Math.floor((total - 1) / limit) * limit : 0
  const pastEnd = offset > lastPageOffset
  useEffect(() => {
    if (pastEnd) onChange(lastPageOffset)
  }, [pastEnd, lastPageOffset, onChange])

  if (total <= limit) return null

  return (
    <div className={cn('flex items-center justify-between text-xs text-muted-foreground', className)}>
      <span>
        {t('core_ui.pagination.range', { from: formatNumber(offset + 1), to: formatNumber(Math.min(offset + limit, total)), total: formatNumber(total) })}
      </span>
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          disabled={!hasPrev}
          aria-label={t('core_ui.pagination.previous')}
          onClick={() => onChange(offset - limit)}
        >
          <ChevronLeft className="size-3.5" />
        </Button>
        <span className="px-1">{page} / {pages}</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          disabled={!hasNext}
          aria-label={t('core_ui.pagination.next')}
          onClick={() => onChange(offset + limit)}
        >
          <ChevronRight className="size-3.5" />
        </Button>
      </div>
    </div>
  )
}
