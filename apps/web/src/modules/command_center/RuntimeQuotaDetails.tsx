import { useEffect, useId, useRef, useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { Button } from '../../components/ui/button'
import * as Popover from '@radix-ui/react-popover'
import type { HostRuntimeUsage } from '../../types/api'

function formatPercent(value: number): string {
  return value < 1 ? value.toFixed(1) : Math.round(value).toString()
}

/** The list stays compact; every reported window remains inspectable on demand. */
export default function RuntimeQuotaDetails({ usage, title, canRefresh, busy, online, onRefresh }: {
  usage?: HostRuntimeUsage
  title: string
  canRefresh: boolean
  busy: boolean
  online: boolean
  onRefresh: () => void
}) {
  const [open, setOpen] = useState(false)
  const titleId = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hovered = useRef(false)
  function cancelClose() {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = null
  }
  function leave() {
    hovered.current = false
    cancelClose()
    closeTimer.current = setTimeout(() => {
      if (!content.current?.contains(document.activeElement)) setOpen(false)
    }, 120)
  }
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current) }, [])

  const quota = usage?.quota
  const named = quota?.windows ?? []
  const includeAccount = !named.length || usage?.runtime_key === 'claude_code'
  const windows = [
    ...(includeAccount && quota?.session_pct != null && !named.some(w => w.id === 'five_hour' || w.id === 'session')
      ? [{ id: 'session', label: 'Session', used_pct: quota.session_pct, resets: quota.session_resets }] : []),
    ...(includeAccount && quota?.week_pct != null && !named.some(w => w.id === 'seven_day' || w.id === 'week')
      ? [{ id: 'week', label: 'Weekly', used_pct: quota.week_pct, resets: quota.week_resets }] : []),
    ...named,
  ]
  const measured = windows.flatMap(window => window.used_pct === null ? [] : [window.used_pct])
  const highest = measured.length && quota?.available ? Math.max(...measured) : null
  const summary = highest === null ? usage ? 'Usage unavailable' : 'Usage not checked' : `Highest used ${formatPercent(highest)}%`
  return (
    <Popover.Root open={open} onOpenChange={setOpen} modal={false}>
      <Popover.Trigger asChild>
      <Button ref={trigger} aria-haspopup="dialog" aria-expanded={open}
        onPointerEnter={event => { if (event.pointerType !== 'touch') { hovered.current = true; cancelClose(); setOpen(true) } }}
        onPointerLeave={leave}
        onFocus={() => { cancelClose(); setOpen(true) }}
        onBlur={event => { if (!content.current?.contains(event.relatedTarget as Node | null)) leave() }}
 size="sm" variant="outline" className={highest !== null && highest >= 90 ? 'text-warning' : ''}
        aria-label={`Usage details for ${title}`} onClick={event => { event.preventDefault(); cancelClose(); setOpen(true) }}>
        {summary}
      </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content ref={content} sideOffset={6} collisionPadding={12} align="start"
          aria-labelledby={titleId}
          onOpenAutoFocus={event => event.preventDefault()}
          onCloseAutoFocus={event => event.preventDefault()}
          onPointerEnter={() => { hovered.current = true; cancelClose() }}
          onPointerLeave={leave}
          onFocusCapture={cancelClose}
          onBlurCapture={event => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null) && !hovered.current) leave()
          }}
          className="z-50 w-80 max-w-[calc(100vw-1.5rem)] max-h-[min(28rem,var(--radix-popover-content-available-height))] overflow-y-auto rounded-md border border-border bg-card p-3 text-foreground shadow-md">
          <h3 id={titleId} className="text-sm font-medium">Usage · {title}</h3>
          <p className="mt-1 text-xs text-muted-foreground">Capacity used per window.</p>
          <div className="mt-3 space-y-3">
            {!quota?.available && <p role="status" className="text-sm text-muted-foreground">
              {quota?.error ?? (usage ? 'No measured quota is available.' : 'Refresh to check this account’s quota.')}
            </p>}
            {windows.map(window => (
              <div key={window.id} className="space-y-1.5">
                <div className="flex items-start justify-between gap-3 text-sm">
                  <span className="min-w-0 break-words">{window.label}</span>
                  <span className="shrink-0 tabular-nums">{window.used_pct === null ? 'Unavailable' : `${formatPercent(window.used_pct)}% used`}</span>
                </div>
                {window.used_pct !== null && <div role="progressbar" aria-label={window.label} aria-valuemin={0} aria-valuemax={100}
                  aria-valuenow={Math.min(100, window.used_pct)} aria-valuetext={`${formatPercent(window.used_pct)}% used`}
                  className="h-2 overflow-hidden rounded-full bg-muted">
                  <div className={`h-full ${window.used_pct >= 90 ? 'bg-destructive' : 'bg-primary'}`}
                    style={{ width: `${Math.min(100, window.used_pct)}%` }} />
                </div>}
                {window.resets && <p className="break-words text-xs text-muted-foreground">{window.resets}</p>}
              </div>
            ))}
            {usage && <p className="text-xs text-muted-foreground">Checked {new Date(usage.checked_at).toLocaleString()}</p>}
            {canRefresh && <Button variant="outline" disabled={!online || busy} onClick={onRefresh}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {busy ? 'Refreshing…' : 'Refresh usage'}
            </Button>}
            {!online && <p className="text-xs text-muted-foreground">Host offline. Cached readings may be out of date.</p>}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
