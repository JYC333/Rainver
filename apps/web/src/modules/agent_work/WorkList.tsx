import type { AgentAttentionPage, AgentWorkItem } from '@rainver/protocol'
import { AgentAttentionGroupSchema } from '@rainver/protocol'
import { formatDateTime, formatNumber, formatRelativeTime } from '../../i18n/format'
import { useAppTranslation } from '../../i18n'
import { useSpace } from '../../contexts/SpaceContext'
import { cn } from '../../lib/utils'
import { Badge } from '../../components/ui/badge'
import { WorkReasons } from './WorkReasons'
import { formatWorkDuration } from './formatWorkDuration'

function elapsedSeconds(item: AgentWorkItem, asOf: string): number | null {
  const starts = item.runs.flatMap(run => run.started_at ? [Date.parse(run.started_at)] : [])
  if (!starts.length) return null
  const end = Math.max(...item.runs.map(run => Date.parse(run.ended_at ?? asOf)))
  return Math.max(0, (end - Math.min(...starts)) / 1000)
}

export function WorkList({ page, selectedKey, onOpen }: {
  page: AgentAttentionPage; selectedKey?: string; onOpen: (item: AgentWorkItem) => void
}) {
  const { t } = useAppTranslation()
  const { spaces } = useSpace()
  return <div>
    {AgentAttentionGroupSchema.options.map(group => <section key={group} aria-label={t(`agent_work.groups.${group}`)} className="border-b border-border last:border-b-0">
      <h2 className="sticky top-0 z-10 flex items-center justify-between gap-2 bg-card px-3 py-2 text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
        {t(`agent_work.groups.${group}`)} <Badge variant={group === 'needs_you' && page.counts[group] > 0 ? 'warning' : 'muted'}>{formatNumber(page.counts[group])}</Badge>
      </h2>
      {page.items.filter(item => item.group === group).map(item => {
        const elapsed = elapsedSeconds(item, page.as_of)
        const selected = selectedKey === item.work_key
        return <button key={item.work_key} data-work-row={item.work_key} aria-current={selected ? 'true' : undefined}
          className={cn('w-full space-y-1 border-t border-border px-3 py-2.5 text-left transition-colors hover:bg-accent/30',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring', selected && 'bg-accent/40')}
          onClick={() => onOpen(item)}>
          {group === 'needs_you' && <WorkReasons reasons={item.reasons} />}
          <div className="flex items-start justify-between gap-2">
            <span className="break-words text-sm font-medium text-foreground">{item.title}</span>
            {item.unread && <Badge className="shrink-0">{t('agent_work.unread')}</Badge>}
          </div>
          <p className="text-xs text-muted-foreground">{spaces.find(space => space.id === item.space_id)?.name ?? item.space_id}
            {item.project_id && <> · {t('agent_work.project', { id: item.project_id })}</>}
            {' · '}{t(`agent_work.groups.${item.group}`)}
          </p>
          <p className="truncate text-xs text-muted-foreground">{[...new Set(item.runs.map(run => `${run.agent_name ?? run.agent_id} · ${run.runtime_key ?? t('agent_work.runtime_unknown')}`))].join(', ')} · {t('agent_work.members', { count: formatNumber(item.visible_run_count) })}</p>
          <p className="text-xs text-muted-foreground">
            {elapsed === null
              ? t('agent_work.duration_unknown')
              : t(item.visible_run_count > item.runs.length ? 'agent_work.partial_duration' : 'agent_work.duration', { value: formatWorkDuration(elapsed) })}
            {' · '}<span title={formatDateTime(item.last_activity_at)}>{t('agent_work.updated', { time: formatRelativeTime(item.last_activity_at) })}</span>
          </p>
          {group !== 'needs_you' && item.reasons.length > 0 && <WorkReasons reasons={item.reasons} />}
          {!item.mine && <p className="text-xs text-muted-foreground">{t('agent_work.other_work')}</p>}
        </button>
      })}
    </section>)}
  </div>
}
