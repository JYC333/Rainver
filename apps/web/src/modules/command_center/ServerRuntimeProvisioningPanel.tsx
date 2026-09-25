import { useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { hostsApi } from '../../api/client'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { errMsg } from '../../lib/utils'
import type { HostRuntimeProvisioningStatus } from '../../types/api'

function healthLabel(status: HostRuntimeProvisioningStatus['installation']) {
  if (status.state === 'failed') return 'Provisioning failed'
  if (status.state === 'ready' && status.active_version === status.desired_version) return 'ACP health passed'
  if (status.state === 'ready') return 'Waiting for Host health report'
  return 'ACP health pending'
}

function nativeAccountLabel(loggedIn: boolean | null) {
  if (loggedIn === true) return 'signed in'
  if (loggedIn === false) return 'not signed in'
  return 'not reported yet'
}

/**
 * Presentational: the Hosts page owns the one refresh loop and hands this
 * panel the status it already fetched, so a page showing the Server Runtime
 * issues a single poll rather than one per panel.
 */
export default function ServerRuntimeProvisioningPanel({
  hostId,
  canRetry,
  status,
  error,
  loading,
  onRefresh,
}: {
  hostId: string
  canRetry: boolean
  status: HostRuntimeProvisioningStatus | null
  error: string | null
  loading: boolean
  onRefresh: () => Promise<void> | void
}) {
  const [retrying, setRetrying] = useState(false)

  async function retry() {
    if (retrying) return
    setRetrying(true)
    try {
      await hostsApi.retryServerRuntimeProvisioning(hostId)
      toast.success('Server Runtime provisioning retry queued')
      await onRefresh()
    } catch (caught) {
      toast.error(errMsg(caught))
    } finally {
      setRetrying(false)
    }
  }

  const installation = status?.installation
  const healthy = installation?.state === 'ready' && installation.active_version === installation.desired_version
  const badgeVariant = installation?.state === 'failed'
    ? 'destructive'
    : healthy ? 'success' : 'warning'

  return (
    <section className="w-full space-y-1.5 border-t pt-2" aria-label="Server Runtime provisioning">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium">OpenCode</span>
        {installation && <Badge variant={badgeVariant}>{healthLabel(installation)}</Badge>}
        {/* The Hosts page keeps the last good status when a read fails, because
            "could not ask again" is not "the copy disappeared" — but then the
            error branch below is unreachable and the badge silently claims to
            be current. Say the status is stale right where it is read. */}
        {installation && error && (
          <span className="text-destructive" role="status">Status stale: {error}</span>
        )}
        {installation && <span className="text-muted-foreground">Provisioning: {installation.state}</span>}
        {(loading || retrying) && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-6 px-1.5"
          aria-label="Refresh Server Runtime status"
          onClick={() => { void onRefresh() }}
          disabled={loading || retrying}
        >
          <RefreshCw className="size-3" />
        </Button>
      </div>
      {installation ? (
        <>
          <p className="text-xs text-muted-foreground">
            Rainver-pinned {installation.desired_version}; installed {installation.installed_version ?? 'none'}; active {installation.active_version ?? 'not reported'}.
          </p>
          <p className="text-xs text-muted-foreground">
            Native account {nativeAccountLabel(status.native_account.logged_in)}. ACP models may still work without an account; ModelProvider Profiles use Rainver&apos;s proxy.
          </p>
          {/* Plan Phase 4 §8: said where the login actually happens, not only
              on the Agent surfaces that consume it. */}
          <p className="text-xs text-muted-foreground">
            If signed in, this account is instance-wide: every person authorized to run Agents on the Server Runtime can use it.
          </p>
          {installation.error && <p className="text-xs text-destructive">{installation.error}</p>}
          {installation.state === 'failed' && canRetry && (
            <Button type="button" size="sm" variant="outline" onClick={() => void retry()} disabled={retrying}>
              Retry Server Runtime provisioning
            </Button>
          )}
        </>
      ) : error ? (
        <div className="flex items-center gap-2 text-xs text-destructive">
          <span>Could not load Server Runtime status: {error}</span>
          <Button type="button" size="sm" variant="outline" onClick={() => { void onRefresh() }}>Retry status</Button>
        </div>
      ) : <p className="text-xs text-muted-foreground">Loading Server Runtime provisioning status…</p>}
    </section>
  )
}
