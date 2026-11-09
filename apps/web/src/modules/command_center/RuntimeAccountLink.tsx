import type { HostRuntimeUsage } from '../../types/api'
import { Button } from '../../components/ui/button'
import { SpaceLink } from '../../core/spaceNav'
import { useAppTranslation } from '../../i18n'

export default function RuntimeAccountLink({ usage, hostId, runtimeKey, installation }: {
  usage?: HostRuntimeUsage; hostId: string; runtimeKey: string; installation: string
}) {
  const { t } = useAppTranslation()
  const account = usage?.quota.account
  const display = usage?.quota.account_display
  const query = usage?.pool_id ? `pool=${encodeURIComponent(usage.pool_id)}`
    : `host=${encodeURIComponent(hostId)}&runtime=${encodeURIComponent(runtimeKey)}&installation=${encodeURIComponent(installation)}`
  return <span className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-1">
    {(display || account) && <span className="min-w-0 break-words text-muted-foreground [overflow-wrap:anywhere]">{display ? [display.email, display.workspace_name].filter(Boolean).join(' · ') : t('subscription_usage.account', { account: account!.account_id.slice(0, 8) })}</span>}
    <Button asChild size="sm" variant="outline"><SpaceLink to={`/usage?tab=quotas&${query}`}>{t('subscription_usage.view')}</SpaceLink></Button>
  </span>
}
