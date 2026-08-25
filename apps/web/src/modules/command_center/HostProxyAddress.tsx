import { useState } from 'react'
import { toast } from 'sonner'
import { hostsApi } from '../../api/client'
import { errMsg } from '../../lib/utils'
import type { Host } from '../../types/api'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'

/**
 * Where this host reaches the provider proxy — the one setting that decides
 * whether a binding on this host can work at all, and the last part of this
 * feature that could only be changed by editing a file on the server.
 *
 * The effective address is computed by the server with the same function a
 * dispatched run uses, not re-derived here: a second derivation would be free
 * to disagree, and the disagreement would surface only as a run failing on
 * someone else's machine.
 */
export default function HostProxyAddress({
  host,
  onChanged,
}: {
  host: Host
  onChanged: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(host.provider_proxy_base_url ?? '')
  const [busy, setBusy] = useState(false)
  const effective = host.provider_proxy_effective_url ?? null

  async function save(next: string) {
    setBusy(true)
    try {
      await hostsApi.setProviderProxyUrl(host.id, next)
      setEditing(false)
      onChanged()
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setBusy(false)
    }
  }

  if (!editing) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">Proxy address:</span>
        {effective ? (
          <>
            <code className="font-mono">{effective}</code>
            <span className="text-muted-foreground">
              {host.provider_proxy_base_url ? '(set for this host)' : '(derived)'}
            </span>
          </>
        ) : (
          <span className="text-destructive">
            none — a bound run on this host will fail until the daemon reconnects or you set one
          </span>
        )}
        <Button size="sm" variant="ghost" onClick={() => { setValue(host.provider_proxy_base_url ?? ''); setEditing(true) }}>
          {host.provider_proxy_base_url ? 'Change' : 'Override'}
        </Button>
      </div>
    )
  }

  return (
    <div className="w-full space-y-1">
      <Label className="text-xs">Proxy address for this host</Label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="max-w-sm"
          value={value}
          disabled={busy}
          placeholder={effective ?? 'http://<reachable-address>:8021'}
          onChange={e => setValue(e.target.value)}
        />
        <Button size="sm" onClick={() => save(value.trim())} disabled={busy}>Save</Button>
        <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={busy}>Cancel</Button>
        {host.provider_proxy_base_url && (
          <Button size="sm" variant="ghost" onClick={() => save('')} disabled={busy}>
            Use derived
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Leave this alone unless the derived address is wrong — a reverse proxy in front of the API,
        or the proxy published somewhere other than the API's host.
      </p>
    </div>
  )
}
