import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { providersApi } from '../../../api/client'
import { Button } from '../../../components/ui/button'
import { Card, CardTitle } from '../../../components/ui/card'
import { Input } from '../../../components/ui/input'
import { errMsg } from '../../../lib/utils'
import type { SubscriptionQuotaPolicy } from '../../../types/api'

/**
 * Where this Space draws its two subscription lines, next to the
 * subscription quota they read. Past the
 * warning line the composer and a discussion's header show the account's
 * window; past the reserve line Agent-triggered turns wait for the window to
 * reset unless a person continues anyway. A person's own message is never
 * held.
 */
export default function SubscriptionQuotaPolicyCard({ canEdit }: { canEdit: boolean }) {
  const [policy, setPolicy] = useState<SubscriptionQuotaPolicy | null>(null)
  const [warn, setWarn] = useState('')
  const [reserve, setReserve] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let active = true
    providersApi.subscriptionQuotaPolicy()
      .then(next => {
        if (!active) return
        setPolicy(next)
        setWarn(String(next.warn_pct))
        setReserve(String(next.reserve_pct))
      })
      .catch(() => { /* the card stays empty; nothing depends on it here */ })
    return () => { active = false }
  }, [])

  const warnPct = Number(warn)
  const reservePct = Number(reserve)
  const valid = Number.isInteger(warnPct) && Number.isInteger(reservePct)
    && warnPct >= 1 && reservePct <= 100 && warnPct <= reservePct
  const changed = policy !== null && (warnPct !== policy.warn_pct || reservePct !== policy.reserve_pct)

  async function save() {
    setSaving(true)
    try {
      const next = await providersApi.updateSubscriptionQuotaPolicy({ warn_pct: warnPct, reserve_pct: reservePct })
      setPolicy(next)
      toast.success('Subscription quota lines saved')
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setSaving(false)
    }
  }

  if (!policy) return null
  return (
    <Card className="space-y-3 p-4" aria-label="Subscription quota lines">
      <div>
        <CardTitle>Subscription quota lines</CardTitle>
        <p className="mt-1 text-xs text-muted-foreground">
          For CLI subscription logins. Past the warning line conversations show the account&apos;s window; past the
          reserve line turns started by Agents — discussion rounds, delegations, follow-ups — wait for the window to
          reset unless someone continues anyway. A person&apos;s own messages are never held.
        </p>
      </div>
      {canEdit ? (
        <>
          <div className="flex flex-wrap gap-3">
            <label className="space-y-1.5">
              <span className="block text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Warning at %</span>
              <Input aria-label="Warning line percent" type="number" min={1} max={100} value={warn} onChange={event => setWarn(event.target.value)} className="w-24" />
            </label>
            <label className="space-y-1.5">
              <span className="block text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Reserve at %</span>
              <Input aria-label="Reserve line percent" type="number" min={1} max={100} value={reserve} onChange={event => setReserve(event.target.value)} className="w-24" />
            </label>
          </div>
          {!valid && <p role="alert" className="text-xs text-destructive">Both are whole percentages, and the warning line is not above the reserve line.</p>}
          <Button size="sm" onClick={() => void save()} disabled={saving || !valid || !changed}>
            {saving ? 'Saving…' : 'Save quota lines'}
          </Button>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          Warning at {policy.warn_pct}% · reserve at {policy.reserve_pct}%. Only Space owners/admins can change them.
        </p>
      )}
    </Card>
  )
}
