import { Unplug } from 'lucide-react'
import type { ConversationExecutionSummary, ConversationExecutionRuntimeProfile, RoomDetail } from '../../types/api'
import i18n, { useAppTranslation } from '../../i18n'
import { ConversationLink as Link } from './ConversationScope'
import { ConversationGitContext } from './ConversationGitContext'
import { commandCenterHostPath } from '../command_center/hostLinks'

export function InitializedSummary({ summary, profiles, participants, cacheNotice }: {
  cacheNotice?: React.ReactNode
  summary: ConversationExecutionSummary
  profiles: ConversationExecutionRuntimeProfile[]
  participants: RoomDetail['agent_members']
}) {
  const { t } = useAppTranslation()
  const host = summary.host
  const primary = summary.primary
  const runtime = summary.runtime
  const pinnedRuntimes = summary.runtimes?.length ? summary.runtimes : (summary.runtime?[summary.runtime]:[])
  const runtimes: PinnedRuntime[] = pinnedRuntimes.length > 0 ? pinnedRuntimes : runtime ? [runtime] : []
  return <div className="space-y-1.5 text-xs">
    <SummaryRow label={t('conversation_ui.preflight.host_label')} value={host ? `${host.host_name}${host.online ? t('conversation_ui.preflight.daemon_online_suffix') : t('conversation_ui.preflight.daemon_offline_suffix')}` : t('conversation_ui.preflight.unavailable_value')} tone={host?.online === false ? 'danger' : undefined} />
    <SummaryRow label={t('conversation_ui.preflight.primary_cwd')} value={primary?.display_path ?? (primary?.kind === 'managed' ? t('conversation_ui.settings.allocated') : t('conversation_ui.preflight.unavailable_value'))} />
    <SummaryRow label={t('conversation_ui.settings.work_mode')} value={t(primary?.kind === 'location' ? 'conversation_ui.settings.independent' : 'conversation_ui.settings.managed')} />
    {summary.blocked_reason && <p className="rounded bg-destructive/10 px-2 py-1 text-destructive">{localizedWorkspaceReason(summary.blocked_reason,t)}</p>}
    {host?.online === false && <div className="flex items-center gap-1 text-muted-foreground"><Unplug className="size-3.5" />{t('conversation_ui.preflight.offline_note')}<Link to={commandCenterHostPath(host.host_id, 'connection')} className="underline">{t('conversation_ui.preflight.reconnect_host')}</Link></div>}
    <details className="space-y-1"><summary className="cursor-pointer text-muted-foreground">{t('conversation_ui.settings.diagnostics')}</summary>
      <ConversationGitContext snapshot={summary.primary?.kind === 'location' ? summary.git : undefined} />
      {cacheNotice}
      {runtimes.length > 0 ? runtimes.map(pinned => (
        <div key={pinned.agent_id}>
          <SummaryRow
            label={participants.find(participant => participant.agent_id === pinned.agent_id)?.agent_name
              ?? profiles.find(profile => profile.runtime_profile_id === pinned.runtime_profile_id)?.agent_name
              ?? t('conversation_ui.preflight.unknown_agent')}
            value={`${pinned.runtime_key} · ${pinned.runtime_installation} · ${('session_config' in pinned ? pinned.session_config?.find(option=>option.category==='model')?.value : null)??t('conversation_ui.participants.model_default')}${sessionOccupancy(pinned)}`}
          />
          {pinned.session_config_dropped && <p className="text-muted-foreground">{t('conversation_ui.participants.model_unavailable')}</p>}
          {pinned.handoff_artifact_id ? (
            <div className="pl-26 text-muted-foreground">
              {t('conversation_ui.preflight.session_renewed')}<Link to={`/artifacts/${pinned.handoff_artifact_id}`} className="underline">{t('conversation_ui.preflight.open_handoff')}</Link>
            </div>
          ) : null}
          {pinned.summary_artifact_id ? (
            <div className="pl-26 text-muted-foreground">
              {t('conversation_ui.preflight.summary_written', { tokens: formatTokens(pinned.context_tokens) })}<Link to={`/artifacts/${pinned.summary_artifact_id}`} className="underline">{t('conversation_ui.preflight.open_summary')}</Link>
            </div>
          ) : null}

        </div>
      )) : <SummaryRow label={t('conversation_ui.preflight.agent_cli')} value={t('conversation_ui.preflight.unavailable_value')} />}
    </details>
    {!runtime && <p className="text-muted-foreground">{t('conversation_ui.preflight.runtime_gone')}</p>}
  </div>
}

type PinnedRuntime = ConversationExecutionSummary['runtimes'][number]

function formatTokens(tokens: number | null | undefined): string {
  if (tokens == null) return i18n.t('conversation_ui.preflight.unknown_tokens')
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens)
}

/** How full this Agent's vendor session is, as its runtime last reported it. */
function sessionOccupancy(pinned: PinnedRuntime): string {
  if (pinned.context_tokens == null || !pinned.context_window_tokens) return ''
  return i18n.t('conversation_ui.preflight.context_full', { percent: Math.round((pinned.context_tokens / pinned.context_window_tokens) * 100) })
}

function SummaryRow({ label, value, tone }: { label: string; value: string; tone?: 'danger' }) {
  return <div className="flex gap-2"><span className="w-24 shrink-0 text-muted-foreground">{label}</span><span title={value} aria-label={value} className={`min-w-0 truncate ${tone === 'danger' ? 'text-destructive' : ''}`}>{value}</span></div>
}


export function localizedWorkspaceReason(reason:string|null|undefined,t:(key:string)=>string){
 if(reason==='waiting_for_baseline')return t('workspace_ui.execution.baseline_required');
 if(reason==='execution_workspace_host_upgrade_required')return t('workspace_ui.execution.host_upgrade_required');
 return reason;
}
