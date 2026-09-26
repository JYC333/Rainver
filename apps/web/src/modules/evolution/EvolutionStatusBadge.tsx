import { StatusBadge } from '../../components/ui/badge'
import { useAppTranslation } from '../../i18n'

/** Keep the wire status for color and behavior while localizing this page's label. */
export function EvolutionStatusBadge({ status, className }: { status: string; className?: string }) {
  const { t } = useAppTranslation()
  return <StatusBadge status={status} label={t('evolution.status.' + status, { defaultValue: status })} className={className} />
}
