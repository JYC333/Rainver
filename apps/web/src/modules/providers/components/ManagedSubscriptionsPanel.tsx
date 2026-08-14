import { useState } from 'react'
import { ExternalLink, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  providersApi,
  type ManagedSubscriptionLoginEvent,
  type ManagedSubscriptionType,
  type ModelProviderOut,
} from '../../../api/client'
import { Badge } from '../../../components/ui/badge'
import { Button } from '../../../components/ui/button'
import { Card, CardTitle } from '../../../components/ui/card'
import { Input } from '../../../components/ui/input'
import { errMsg } from '../../../lib/utils'

const LABELS: Record<ManagedSubscriptionType, string> = {
  anthropic: 'Claude Pro / Max',
  openai_codex: 'OpenAI Codex (ChatGPT Plus / Pro)',
}

export default function ManagedSubscriptionsPanel({
  providers,
  isInstanceAdmin,
  onChanged,
  onDisconnected,
}: {
  providers: ModelProviderOut[]
  isInstanceAdmin: boolean
  onChanged: (provider: ModelProviderOut) => void
  onDisconnected: (providerId: string) => void
}) {
  const [connecting, setConnecting] = useState<ManagedSubscriptionType | null>(null)
  const [events, setEvents] = useState<Partial<Record<ManagedSubscriptionType, ManagedSubscriptionLoginEvent>>>({})
  const [manualInput, setManualInput] = useState('')

  async function connect(type: ManagedSubscriptionType) {
    setConnecting(type)
    setEvents(previous => ({ ...previous, [type]: { type: 'progress', message: 'Starting secure login…' } }))
    try {
      for await (const event of providersApi.subscriptionLoginStream(type)) {
        setEvents(previous => ({ ...previous, [type]: event }))
        if (event.type === 'auth_url') window.open(event.url, '_blank', 'noopener,noreferrer')
        if (event.type === 'connected') {
          onChanged(event.provider)
          toast.success(`${LABELS[type]} connected`)
        }
        if (event.type === 'error') toast.error(event.message)
      }
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setConnecting(null)
    }
  }

  async function submit(type: ManagedSubscriptionType) {
    try {
      await providersApi.sendSubscriptionLoginInput(type, manualInput)
      setManualInput('')
    } catch (error) {
      toast.error(errMsg(error))
    }
  }

  async function refresh(provider: ModelProviderOut) {
    try {
      onChanged(await providersApi.refreshSubscriptionQuota(provider.id))
      toast.success('Subscription quota refreshed')
    } catch (error) {
      toast.error(errMsg(error))
    }
  }

  async function disconnect(provider: ModelProviderOut) {
    try {
      await providersApi.disconnectSubscription(provider.id)
      onDisconnected(provider.id)
      setEvents(previous => ({
        ...previous,
        [provider.provider_type as ManagedSubscriptionType]: { type: 'info', message: 'Subscription disconnected.' },
      }))
      toast.success('Subscription disconnected')
    } catch (error) {
      toast.error(errMsg(error))
    }
  }

  return (
    <Card>
      <div className="space-y-4">
        <div>
          <CardTitle>Managed subscriptions</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            Instance-admin OAuth for in-process managed calls. These credentials are separate from CLI login profiles.
          </p>
        </div>
        {!isInstanceAdmin && (
          <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
            Connecting subscription capacity requires the configured instance admin.
          </p>
        )}
        {(['anthropic', 'openai_codex'] as const).map(type => {
          const provider = providers.find(candidate => candidate.provider_type === type && candidate.has_subscription)
          const event = events[type]
          const quota = provider?.subscription_quota
          return (
            <div key={type} className="rounded-md border border-border p-3 space-y-2">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-medium">{LABELS[type]}</div>
                <Badge variant={provider ? 'success' : 'muted'}>{provider ? 'Connected' : 'Not connected'}</Badge>
              </div>
              {provider && (
                <p className="text-xs text-muted-foreground">
                  5h: {quota?.session_pct ?? '—'}% · week: {quota?.week_pct ?? '—'}%
                  {quota?.error ? ` · ${quota.error}` : ''}
                </p>
              )}
              {event?.type === 'auth_url' && (
                <a href={event.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-primary underline">
                  Open authorization page <ExternalLink className="size-3" />
                </a>
              )}
              {event?.type === 'device_code' && (
                <div className="text-xs">
                  Open <a href={event.verificationUri} target="_blank" rel="noreferrer" className="text-primary underline">{event.verificationUri}</a>
                  {' '}and enter <span className="font-mono font-semibold">{event.userCode}</span>.
                </div>
              )}
              {event?.type === 'prompt' && (
                <div className="flex gap-2">
                  <Input value={manualInput} onChange={e => setManualInput(e.target.value)} placeholder={event.placeholder ?? 'Paste redirect URL or code'} />
                  <Button size="sm" onClick={() => submit(type)} disabled={!manualInput.trim()}>Submit</Button>
                </div>
              )}
              {(event?.type === 'progress' || event?.type === 'info') && (
                <p className="text-xs text-muted-foreground">{event.message}</p>
              )}
              <div className="flex gap-2">
                {!provider && isInstanceAdmin && (
                  <Button size="sm" variant="outline" onClick={() => connect(type)} disabled={connecting !== null}>
                    {connecting === type ? <Loader2 className="size-3.5 animate-spin" /> : 'Connect'}
                  </Button>
                )}
                {provider && isInstanceAdmin && (
                  <>
                    <Button size="sm" variant="outline" onClick={() => refresh(provider)}>Refresh quota</Button>
                    <Button size="sm" variant="outline" onClick={() => disconnect(provider)}>Disconnect</Button>
                  </>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </Card>
  )
}
