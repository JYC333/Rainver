import type { Host } from '../../types/api'
import { Badge } from '../../components/ui/badge'
import { useAppTranslation } from '../../i18n'
import { cn } from '../../lib/utils'
import { HOST_STATUS_VARIANT, fmt, hostDisplayName, hostProblems, type HostProvisioning } from './hostDisplay'

/**
 * Every execution environment the person can see, with what is already
 * known to be wrong with each. Choosing one opens its detail; the list itself
 * reads nothing.
 */
export default function HostSummaryList({ hosts, selectedId, provisioning, onSelect, className }: {
  hosts: Host[]
  selectedId: string | null
  provisioning: Record<string, HostProvisioning>
  onSelect: (hostId: string) => void
  className?: string
}) {
  const { t } = useAppTranslation()
  return (
    <nav aria-label={t('command_center.hosts')} className={cn('min-w-0 space-y-3', className)}>
      <ul className="space-y-1">
        {hosts.map(host => {
          const selected = host.id === selectedId
          const problems = hostProblems(host, provisioning[host.id])
          return (
            <li key={host.id}>
              <button type="button" data-host-button={host.id} aria-current={selected ? 'true' : undefined} onClick={() => onSelect(host.id)}
                className={cn(
                  'flex w-full min-w-0 flex-col gap-1 rounded-md border px-2 py-1.5 text-left text-xs transition-colors',
                  'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                  selected ? 'border-primary bg-accent text-foreground' : 'border-border hover:bg-accent/40',
                )}>
                <span className="flex min-w-0 items-center justify-between gap-2">
                  <span className="truncate font-medium">{hostDisplayName(host, t('command_center.builtin_name'))}</span>
                  <Badge variant={HOST_STATUS_VARIANT[host.status]}>{host.status}</Badge>
                </span>
                <span className="truncate text-muted-foreground">
                  {host.kind === 'server' ? t('command_center.kind_builtin') : `${t('command_center.kind_paired')} · ${host.environment_kind ?? host.platform ?? '—'}`}
                </span>
                {problems.length > 0 && (
                  <span className="flex flex-wrap gap-1">
                    {problems.map(problem => (
                      <Badge key={problem.key} variant={problem.key === 'revoked' || problem.key === 'provisioning_failed' ? 'destructive' : 'warning'}>
                        {problem.key === 'offline'
                          ? (problem.time ? t('command_center.problem_offline', { time: fmt(problem.time) }) : t('command_center.problem_never_seen'))
                          : problem.key === 'runtime_logged_out'
                            ? t('command_center.problem_runtime_logged_out', { count: problem.count })
                            : t(`command_center.problem_${problem.key}`)}
                      </Badge>
                    ))}
                  </span>
                )}
              </button>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
