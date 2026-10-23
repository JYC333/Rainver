import type { AgentAttentionReason } from '@rainver/protocol'
import { useAppTranslation } from '../../i18n'
import { Badge } from '../../components/ui/badge'

export function WorkReasons({ reasons }: { reasons: AgentAttentionReason[] }) {
  const { t } = useAppTranslation()
  if (!reasons.length) return null
  return <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
    {reasons.map((reason, index) => <p key={index} className="flex flex-wrap items-center gap-1.5">
      <Badge variant="warning">{t(`agent_work.reasons.${reason.kind}`)}</Badge>
      <span className="text-muted-foreground">
        {'code' in reason && <>{t(`agent_work.codes.${reason.code}`, { defaultValue: reason.code })}</>}
        {'status' in reason && <>{'code' in reason && ' · '}{t(`agent_work.status.${reason.status}`)}</>}
        {'responsible' in reason && <>{('code' in reason || 'status' in reason) && ' · '}{t('agent_work.responsible', { name: reason.responsible.display_name ?? reason.responsible.id ?? t('agent_work.unassigned') })}</>}
      </span>
    </p>)}
  </div>
}
