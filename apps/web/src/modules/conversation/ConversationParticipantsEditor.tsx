import { useEffect, useRef, useState, type ReactNode } from 'react'
import { sessionsApi } from '../../api/client'
import type { ConversationExecutionSummary, ConversationExecutionRuntimeProfile, ConversationExecutionPreflightResponse, RoomDetail } from '../../types/api'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Select } from '../../components/ui/select'
import { useAppTranslation } from '../../i18n'
import { errMsg } from '../../lib/utils'
import { commandCenterHostPath } from '../command_center/hostLinks'
import { ConversationLink } from './ConversationScope'
import { useConversationScope } from './ConversationScope'
import { runtimeChoice } from './runtimeChoice'

type Edit = { id: string; participating: boolean; revision?: string }

/** Each explicit delta retains its read revision, including after a refused write. */
export function ConversationParticipantsEditor({ summary, profiles, availableAgents, detail, onSaved, renderAgent, disabled = false }: {
  summary: ConversationExecutionSummary
  profiles: ConversationExecutionRuntimeProfile[]
  availableAgents?: ConversationExecutionPreflightResponse['available_participant_agents']
  detail: RoomDetail
  onSaved: (saved?: boolean) => Promise<unknown>
  renderAgent?: (id: string, actions: ReactNode) => ReactNode
  disabled?: boolean
}) {
  const { t } = useAppTranslation()
  const scope = useConversationScope()
  const activeScope = useRef(scope)
  activeScope.current = scope
  const [adding, setAdding] = useState(false)
  const [query, setQuery] = useState('')
  const [edit, setEdit] = useState<Edit | null>(null)
  const [choice, setChoice] = useState('')
  const [busy, setBusy] = useState(false)
  const [refreshRequired, setRefreshRequired] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { setEdit(null); setAdding(false); setError(null); setBusy(false); setRefreshRequired(false) }, [scope, summary.session_id])
  const pinned = summary.runtimes?.length ? summary.runtimes : summary.runtime ? [summary.runtime] : []
  const ids = summary.participant_agent_ids ?? pinned.map(pin => pin.agent_id)
  const managerId = detail.agent_members.find(member => member.role === 'manager')?.agent_id
  const managerRuntime = pinned.find(pin => pin.agent_id === managerId)
    ?? (summary.runtime?.agent_id === managerId ? summary.runtime : null)
  const locked = scope.actionRole === 'worker' || scope.actionRole === 'viewer' || disabled || busy || summary.dispatch_locked || !detail.viewer_can_write
  const optionsFor = (id: string) => profiles.filter(profile => profile.agent_id === id && profile.usable
    && profile.runtime_installation && profile.execution_host_id === summary.host?.host_id)
  const retained = (id: string) => availableAgents ? availableAgents.some(agent => agent.agent_id === id && agent.retained_thread) : pinned.some(pin => pin.agent_id === id)
    || profiles.some(profile => profile.agent_id === id && profile.retained_binding)
  // Use authority is separate from profile usability, including an empty catalog.
  const canEdit = (id: string) => availableAgents ? availableAgents.some(agent => agent.agent_id === id)
    : pinned.some(pin => pin.agent_id === id) || profiles.some(profile => profile.agent_id === id)
  function begin(id: string, participating: boolean) {
    setEdit({ id, participating, revision: summary.participants_revision })
    const options = optionsFor(id)
    const preferred = options.filter(profile => profile.preferred)
    const persisted = options.filter(profile => profile.runtime_profile_id !== null)
    const suggested = preferred.length === 1 ? preferred[0] : persisted.length === 1 ? persisted[0] : options.length === 1 ? options[0] : null
    setChoice(suggested ? key(suggested) : '')
    setError(null)
  }
  async function save() {
    if (!edit || locked || refreshRequired || !canEdit(edit.id)) return
    if (!managerRuntime || !summary.host || !summary.primary) { setError(t('conversation_ui.participants.reload_runtime')); return }
    setBusy(true); setError(null)
    let written = false
    try {
      const profile = optionsFor(edit.id).find(profile => key(profile) === choice)
      if (edit.participating && !retained(edit.id) && !profile) throw new Error(t('conversation_ui.participants.choose_runtime'))
      await sessionsApi.initializeExecution(summary.session_id, {
        selection: { execution_host_id: summary.host.host_id, primary: summary.primary.kind === 'managed' ? { kind: 'managed' } : { kind: 'location', workspace_location_id: summary.primary.workspace_location_id } },
        runtime: runtimeChoice(managerRuntime),
        additional_runtimes: edit.participating && !retained(edit.id) && profile ? [runtimeChoice({ ...profile, runtime_installation: profile.runtime_installation! })] : [],
        participants_revision: edit.revision,
        participant_changes: [{ agent_id: edit.id, participating: edit.participating }],
      }, scope)
      if (scope.signal?.aborted || activeScope.current !== scope) return
      written = true
      // A successful write consumes its CAS revision, even if the read fails.
      setEdit(null); setAdding(false); setRefreshRequired(true)
      const refreshed = await onSaved(true)
      if (scope.signal?.aborted || activeScope.current !== scope) return
      if (refreshed === false) { setError(t('conversation_ui.participants.saved_refresh_failed')); return }
      setRefreshRequired(false)
      window.dispatchEvent(new CustomEvent('conversation-settings-saved', { detail: { sessionId: summary.session_id, spaceId: scope.spaceId } }))
    } catch (cause) {
      if (!scope.signal?.aborted && activeScope.current === scope) {
        setError(written ? t('conversation_ui.participants.saved_refresh_failed') : errMsg(cause))
        if ((cause as { status?: number }).status === 409) { setEdit(null); setRefreshRequired(true) }
      }
    } finally { if (!scope.signal?.aborted && activeScope.current === scope) setBusy(false) }
  }
  const candidates = detail.agent_members.filter(member => !ids.includes(member.agent_id)
    && member.agent_name.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
  return <div className="flex h-full min-h-0 flex-col gap-3">
    <div className="shrink-0 space-y-2">
      <Button size="sm" variant="outline" disabled={locked || refreshRequired} onClick={() => { setAdding(!adding); setEdit(null); setQuery(''); setError(null) }}>
        {t(adding ? 'conversation_ui.settings.back' : 'conversation_ui.settings.add')}
      </Button>
      {adding && <Input aria-label={t('conversation_ui.settings.search')} placeholder={t('conversation_ui.settings.search')} value={query} onChange={event => setQuery(event.target.value)} />}
      {summary.dispatch_locked && <p className="text-xs text-muted-foreground">{t('conversation_ui.settings.frozen')}</p>}
    </div>
    <div className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain">
      {detail.agent_members.filter(member => ids.includes(member.agent_id)).map(member => {
        const actions = <ParticipantRemoval manager={member.role === 'manager'} name={member.agent_name}
          pending={edit?.id === member.agent_id && !edit.participating}
          disabled={locked || refreshRequired || !canEdit(member.agent_id)} busy={busy}
          onBegin={() => begin(member.agent_id, false)} onConfirm={() => void save()} onCancel={() => setEdit(null)} />
        return <div key={member.agent_id}>{renderAgent?.(member.agent_id, actions) ?? <div className="flex items-center justify-between gap-2 text-sm"><span>{member.agent_name}</span>{actions}</div>}</div>
      })}
      {adding && <>
        <p className="text-xs text-muted-foreground">{t('conversation_ui.settings.inherit')}</p>
        {candidates.map(member => <div key={member.agent_id} className="space-y-1">
          <Button className="w-full justify-start" size="sm" variant={edit?.id === member.agent_id ? 'secondary' : 'ghost'} disabled={locked || refreshRequired}
            onClick={() => begin(member.agent_id, true)}>{member.agent_name}</Button>
          {!canEdit(member.agent_id) && <p className="px-2 text-xs text-muted-foreground">{profiles.find(profile => profile.agent_id === member.agent_id)?.reason ?? t('conversation_ui.settings.unavailable')}</p>}
        </div>)}
        {candidates.length === 0 && <p className="text-xs text-muted-foreground">{t('conversation_ui.settings.empty')}</p>}
      </>}
    </div>
    {edit?.participating && <div className="shrink-0 space-y-2 border-t border-border pt-2">
      <p className="text-sm font-medium">{detail.agent_members.find(member => member.agent_id === edit.id)?.agent_name} · {t(edit.participating ? 'conversation_ui.settings.join' : 'conversation_ui.settings.remove')}</p>
      {edit.participating && !retained(edit.id) && optionsFor(edit.id).length > 0 && <label className="block space-y-1 text-xs"><span>{t('conversation_ui.participants.choose_runtime')}</span><Select ariaLabel={t('conversation_ui.participants.choose_runtime')} value={choice} onChange={setChoice}
        options={optionsFor(edit.id).map(profile => ({ value: key(profile), label: `${profile.runtime_key} · ${profile.runtime_installation}` }))} disabled={locked} /></label>}
      {edit.participating && !retained(edit.id) && optionsFor(edit.id).length === 0 && <p className="text-xs text-destructive">{profiles.find(profile => profile.agent_id === edit.id)?.reason ?? t('conversation_ui.settings.unavailable')}</p>}
      {edit.participating && !retained(edit.id) && summary.host && <ConversationLink className="block text-xs underline" to={commandCenterHostPath(summary.host.host_id, 'runtime')}>{t('conversation_ui.preflight.configure_host')}</ConversationLink>}
      <div className="flex gap-2">
        <Button size="sm" disabled={locked || !canEdit(edit.id) || (edit.participating && !retained(edit.id) && !choice)} onClick={() => void save()}>{t('conversation_ui.settings.join')}</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setEdit(null); setError(null) }}>{t('conversation_ui.participants.cancel')}</Button>
      </div>
    </div>}
    {refreshRequired && <Button size="sm" variant="outline" disabled={busy} onClick={async () => {
      setBusy(true)
      try { if (await onSaved() !== false && !scope.signal?.aborted && activeScope.current === scope) { setRefreshRequired(false); setError(null) } }
      catch (cause) { if (!scope.signal?.aborted && activeScope.current === scope) setError(errMsg(cause)) }
      finally { if (!scope.signal?.aborted && activeScope.current === scope) setBusy(false) }
    }}>{t('conversation_ui.preflight.retry')}</Button>}
    {error && <p role="alert" className="shrink-0 text-xs text-destructive">{error}</p>}
  </div>
}
function key(profile: ConversationExecutionRuntimeProfile) {
  return JSON.stringify([profile.runtime_profile_id, profile.runtime_key, profile.runtime_installation])
}

export function ConversationDraftParticipants({ members, ids, onChange, renderAgent, disabled }: {
  members: RoomDetail['agent_members']
  ids: string[]
  onChange: (id: string, participating: boolean) => void
  renderAgent: (id: string, actions: ReactNode) => ReactNode
  disabled: boolean
}) {
  const { t } = useAppTranslation()
  const [adding, setAdding] = useState(false)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const scope = useConversationScope()
  useEffect(() => { setSelected(null); setRemoving(null); setAdding(false); setQuery('') }, [scope, disabled])
  const visible = members.filter(member => ids.includes(member.agent_id) || (adding && member.agent_name.toLocaleLowerCase().includes(query.toLocaleLowerCase())))
  return <div className="flex h-full min-h-0 flex-col gap-3">
    <div className="shrink-0 space-y-2">
      <Button size="sm" variant="outline" disabled={disabled} onClick={() => { setAdding(!adding); setQuery(''); setSelected(null) }}>{t(adding ? 'conversation_ui.settings.back' : 'conversation_ui.settings.add')}</Button>
      {adding && <Input aria-label={t('conversation_ui.settings.search')} placeholder={t('conversation_ui.settings.search')} value={query} onChange={event => setQuery(event.target.value)} />}
    </div>
    <div className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain">
      <p className="text-xs text-muted-foreground">{t('conversation_ui.settings.draft_hint')}</p>
      {visible.map(member => <div key={member.agent_id}>{!ids.includes(member.agent_id)
        ? <Button size="sm" variant="ghost" className="w-full justify-start" disabled={disabled} onClick={() => setSelected(member.agent_id)}>{member.agent_name}</Button>
        : renderAgent(member.agent_id, <ParticipantRemoval manager={member.role === 'manager'} name={member.agent_name}
          pending={removing === member.agent_id} disabled={disabled}
          onBegin={() => setRemoving(member.agent_id)}
          onConfirm={() => { onChange(member.agent_id, false); setRemoving(null) }} onCancel={() => setRemoving(null)} />)}</div>)}

      {visible.length === 0 && <p className="text-xs text-muted-foreground">{t('conversation_ui.settings.empty')}</p>}
    </div>
      {selected && <div className="flex flex-wrap items-center gap-2"><span className="text-sm">{members.find(member => member.agent_id === selected)?.agent_name}</span><Button size="sm" disabled={disabled} onClick={() => { onChange(selected, true); setSelected(null); setAdding(false) }}>{t('conversation_ui.settings.join')}</Button><Button size="sm" variant="ghost" onClick={() => setSelected(null)}>{t('conversation_ui.participants.cancel')}</Button></div>}
  </div>
}


/** Confirmation stays with the Agent it affects, above its model parameters. */
function ParticipantRemoval({ manager, name, pending, disabled, busy, onBegin, onConfirm, onCancel }: {
  manager: boolean
  name: string
  pending: boolean
  disabled: boolean
  busy?: boolean
  onBegin: () => void
  onConfirm: () => void
  onCancel: () => void
}) {
  const { t } = useAppTranslation()
  if (manager) return <span title={t('conversation_ui.settings.manager_required')} className="relative inline-flex h-7 items-center justify-center px-2.5 text-xs font-medium text-muted-foreground"><span aria-hidden="true" className="invisible">{t('conversation_ui.settings.remove')}</span><span className="absolute inset-0 flex items-center justify-center">{t('conversation_ui.settings.manager')}</span></span>
  if (!pending) return <Button size="sm" variant="ghost" disabled={disabled} onClick={onBegin}>{t('conversation_ui.settings.remove')}</Button>
  return <div className="space-y-2">
    <p className="text-xs">{t('conversation_ui.settings.remove')} · {name}?</p>
    <div className="flex gap-2">
      <Button size="sm" disabled={disabled} onClick={onConfirm}>{t('conversation_ui.settings.confirm_remove')}</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>{t('conversation_ui.participants.cancel')}</Button>
    </div>
  </div>
}
