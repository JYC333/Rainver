import { useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { useAppTranslation } from '../../i18n'
import ApiPlanUsagePanel from './ApiPlanUsagePanel'
import SubscriptionQuotaPanel from './SubscriptionQuotaPanel'

export default function QuotaOverview() {
  const { t } = useAppTranslation()
  const [refreshKey, setRefreshKey] = useState(0)
  const [cliBusy, setCliBusy] = useState(true)
  const [apiBusy, setApiBusy] = useState(true)
  const busy = cliBusy || apiBusy
  return <div className="space-y-8">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-muted-foreground">{t('quota_refresh.description')}</p>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => {
        setCliBusy(true); setApiBusy(true); setRefreshKey(value => value + 1)
      }}><RefreshCw className={busy ? 'size-3.5 animate-spin' : 'size-3.5'} />{t(busy ? 'quota_refresh.refreshing' : 'quota_refresh.all')}</Button>
    </div>
    <SubscriptionQuotaPanel refreshKey={refreshKey} onBusyChange={setCliBusy} />
    <ApiPlanUsagePanel refreshKey={refreshKey} onBusyChange={setApiBusy} />
  </div>
}
