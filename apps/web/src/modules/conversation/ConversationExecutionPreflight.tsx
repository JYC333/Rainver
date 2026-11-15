import { InitializedSummary, localizedWorkspaceReason } from './ConversationEnvironmentSummary'
import { runtimeChoice } from './runtimeChoice'
import type {ConversationPinnedRuntime} from '@rainver/protocol'
import { ConversationAgentSessionConfigs, ConversationAgentConfiguration, type AgentSessionConfiguration } from './ConversationSessionConfig'
import { ConversationParticipantsEditor, ConversationDraftParticipants } from './ConversationParticipantsEditor'
import { ConversationScope, useConversationScope } from './ConversationScope'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Info, Loader2, RefreshCw, Shield } from 'lucide-react'
import { toast } from 'sonner'
import { roomsApi, sessionsApi } from '../../api/client'
import { ConversationLink as Link } from './ConversationScope'
import { errMsg } from '../../lib/utils'
import i18n, { useAppTranslation } from '../../i18n'
import type {
  ConversationAttachmentAccessMode,
  ConversationExecutionHostSummary,
  ConversationExecutionPreflightResponse,
  ConversationExecutionRuntimeProfile,
  ConversationExecutionSelection,
  ConversationExecutionSummary,
  ConversationRuntimeChoice,
  RoomConversation as RoomConversationRecord,
  RoomDetail,
} from '../../types/api'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Popover, PopoverTrigger, PopoverContent } from '../../components/ui/popover'
import { Label } from '../../components/ui/label'
import { Select } from '../../components/ui/select'
import { ConversationCacheNotice, isPromptCacheExpired } from './ConversationCacheNotice'
import { ConversationGitContext } from './ConversationGitContext'
import { commandCenterHostPath } from '../command_center/hostLinks'

export interface ConversationExecutionPreflightProps {
  settingsOpen?: boolean
  onSettingsOpenChange?: (open: boolean) => void
  agentConfigurations?: AgentSessionConfiguration[]
  disabled?: boolean
  spaceId?: string
  projectId: string
  roomId: string
  sessionId: string | null
  /** Current Files & Code selection used only as the draft's initial Primary. */
  preferredProjectFolderId?: string | null
  detail?: RoomDetail | null
  onConversationCreated?: (conversation: RoomConversationRecord) => void
  onNewConversation?: () => void
  onReadyChange?: (ready: boolean) => void
  onSummaryChange?: (summary: ConversationExecutionSummary | null) => void
}

/**
 * The execution contract shown next to every Room composer. It is deliberately
 * a small client of the session execution-context API: server preflight owns
 * authorization and readiness, while this component owns only the visible
 * selection and the explicit actions that the user requested.
 */
export function ConversationExecutionPreflight(props: ConversationExecutionPreflightProps) {
  const [settingsOpen, setSettingsOpen] = useState(false)
  useEffect(() => { setSettingsOpen(false) }, [props.spaceId, props.roomId])
  return <ConversationScope key={`${props.spaceId ?? ''}:${props.roomId}:${props.sessionId ?? 'new'}`} spaceId={props.spaceId}><ConversationExecutionPreflightContent key={`${props.spaceId ?? ''}:${props.roomId}:${props.sessionId ?? 'new'}`} {...props} settingsOpen={props.settingsOpen ?? settingsOpen} onSettingsOpenChange={props.onSettingsOpenChange ?? setSettingsOpen} /></ConversationScope>
}

export function ConversationExecutionPreflightContent({
  settingsOpen,
  onSettingsOpenChange,
  projectId,
  roomId,
  sessionId,
  preferredProjectFolderId = null,
  detail: suppliedDetail,
  onConversationCreated,
  onNewConversation,
  onReadyChange,
  onSummaryChange,
  agentConfigurations = [],
  disabled = false,
}: ConversationExecutionPreflightProps) {
  const scope = useConversationScope()
  const { t } = useAppTranslation()
  const [detail, setDetail] = useState<RoomDetail | null>(suppliedDetail ?? null)
  const [preflight, setPreflight] = useState<ConversationExecutionPreflightResponse | null>(null)
  const [profiles, setProfiles] = useState<ConversationExecutionRuntimeProfile[]>([])
  const [hostId, setHostId] = useState('')
  const [primaryKey, setPrimaryKey] = useState('')
  const [runtimeProfileId, setRuntimeProfileId] = useState('')
  const [participantRuntimeProfileIds, setParticipantRuntimeProfileIds] = useState<Record<string, string>>({})
  const [draftParticipants,setDraftParticipants]=useState<Record<string,boolean>>({})
  const [attachLocationId, setAttachLocationId] = useState('')
  const [attachMode, setAttachMode] = useState<ConversationAttachmentAccessMode>('write')
  const [loading, setLoading] = useState(false)
  const [baselineMode,setBaselineMode]=useState<'committed'|'snapshot'|''>('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestSequence = useRef(0)
  const executionScope = useMemo(() => ({ scope, roomId, sessionId }), [scope, roomId, sessionId])
  const activeScope = useRef(executionScope)
  activeScope.current = executionScope
  const hostSelectionTouched = useRef(false)
  const primarySelectionTouched = useRef(false)

  useEffect(() => {
    requestSequence.current += 1
    setPreflight(null)
    setProfiles([])
    setHostId('')
    setPrimaryKey('')
    setRuntimeProfileId('')
    setParticipantRuntimeProfileIds({})
    setDraftParticipants({})
    setAttachLocationId('')
    setBaselineMode('')
    setBusy(false)
    setError(null)
    hostSelectionTouched.current = false
    primarySelectionTouched.current = false
    onReadyChange?.(false)
    onSummaryChange?.(null)
    return () => { requestSequence.current += 1 }
  }, [onReadyChange, onSummaryChange, roomId, sessionId, scope])

  useEffect(() => {
    if (suppliedDetail !== undefined) setDetail(suppliedDetail)
  }, [suppliedDetail, scope])

  useEffect(() => {
    if (suppliedDetail?.agent_members.some(member => member.role === 'manager')) return
    let active = true
    roomsApi.get(roomId, scope)
      .then(next => { if (active) setDetail(next) })
      .catch(() => undefined)
    return () => { active = false }
  }, [roomId, sessionId, suppliedDetail, scope])

  const reload = useCallback(async () => {
    const sequence = ++requestSequence.current
    if (!sessionId) {
      setPreflight(null)
      setProfiles([])
      onReadyChange?.(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const next = await sessionsApi.executionContext(sessionId, scope)
      if (activeScope.current !== executionScope || scope.signal?.aborted || sequence !== requestSequence.current) return
      setPreflight(next)
      setBaselineMode(previous=>next.summary.workspace_baseline??(next.summary.state==='initialized'?'':previous))
      setProfiles(next.available_runtime_profiles ?? [])
      onSummaryChange?.(next.summary)
      // Said again here, not only when `ready` changes: a failed refresh
      // reported false while `ready` (from the kept preflight) stayed true, so
      // the next good refresh changed nothing and sending stayed disabled.
      onReadyChange?.(Boolean(next.summary.state === 'initialized' && next.summary.can_send))
      return true
    } catch (cause) {
      if (activeScope.current !== executionScope || scope.signal?.aborted || sequence !== requestSequence.current) return
      const message = errMsg(cause)
      setError(message)
      setPreflight(null)
      setProfiles([])
      onReadyChange?.(false)
      onSummaryChange?.(null)
      return false
    } finally {
      if (activeScope.current === executionScope && !scope.signal?.aborted && sequence === requestSequence.current) setLoading(false)
    }
  }, [onReadyChange, onSummaryChange, sessionId, scope, executionScope])

  useEffect(() => { void reload() }, [reload, scope])

  useEffect(() => {
    if (!sessionId) return
    const settingsSaved=(event:Event)=>{const value=(event as CustomEvent).detail;if(value?.sessionId===sessionId&&value?.spaceId===scope.spaceId)void reload()}
    window.addEventListener('conversation-settings-saved',settingsSaved)
    const refresh = () => { if (document.visibilityState === 'visible') void reload() }
    const interval = window.setInterval(refresh, 30_000)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('conversation-settings-saved',settingsSaved)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [reload, sessionId, scope])

  const summary = preflight?.summary ?? null
  const summaryRuntimes: ConversationPinnedRuntime[] = summary?.runtimes?.length ? summary.runtimes : (summary?.runtime ? [summary.runtime] : [])
  const initialized = summary?.state === 'initialized'
  const locations = preflight?.available_primary_locations ?? []
  const executableLocations = locations.filter(location => location.execution_ready)
  const selectedPrimary = useMemo<ConversationExecutionSelection['primary'] | null>(() => {
    if (primaryKey === 'managed') return { kind: 'managed' }
    if (primaryKey.startsWith('location:')) return {
      kind: 'location',
      workspace_location_id: primaryKey.slice('location:'.length),
    }
    return null
  }, [primaryKey, scope])
  const selectedHost = preflight?.available_hosts.find(host => host.host_id === hostId) ?? null
  const selectedLocation = selectedPrimary?.kind === 'location'
    ? locations.find(location => location.workspace_location_id === selectedPrimary.workspace_location_id) ?? null
    : null
  const participantMembers = useMemo(
    () => (detail ?? suppliedDetail)?.agent_members ?? [],
    [detail, suppliedDetail, scope],
  )
  const manager = participantMembers.find(member => member.role === 'manager')
  const candidateProfilesByAgent = useMemo(() => {
    const candidates = new Map<string, ConversationExecutionRuntimeProfile[]>()
    for (const member of participantMembers) {
      candidates.set(member.agent_id, profiles.filter(profile => (
        profile.agent_id === member.agent_id
        && profile.usable
        && Boolean(profile.execution_host_id)
        && Boolean(profile.runtime_installation)
        && profile.execution_host_id === hostId
        && profile.workspace_mode === selectedPrimary?.kind
        && (selectedPrimary?.kind !== 'location' || profile.workspace_location_id === selectedPrimary.workspace_location_id)
      )))
    }
    return candidates
  }, [hostId, participantMembers, profiles, selectedPrimary, scope])
  const candidateProfiles = manager ? candidateProfilesByAgent.get(manager.agent_id) ?? [] : []
  const selectedProfile = candidateProfiles.find(profile => runtimeCandidateKey(profile) === runtimeProfileId) ?? null
  const participantChoices = participantMembers.filter(member=>member.role==='manager'||(draftParticipants[member.agent_id]??((detail??suppliedDetail)?.room.conversation_defaults_json?.find(item=>item.agent_id===member.agent_id)?.participating!==false))).map(member => {
    const options = candidateProfilesByAgent.get(member.agent_id) ?? []
    const selectedId = member.role === 'manager' ? runtimeProfileId : participantRuntimeProfileIds[member.agent_id] ?? ''
    return {
      member,
      options,
      selectedId,
      selected: options.find(profile => runtimeCandidateKey(profile) === selectedId) ?? null,
    }
  })
  const draftParticipantIds = participantChoices.map(choice => choice.member.agent_id).join(',')
  useEffect(() => {
    if (summary?.state === 'draft') onSummaryChange?.({...summary, participant_agent_ids: draftParticipantIds ? draftParticipantIds.split(',') : []})
  }, [summary, draftParticipantIds, onSummaryChange])
  const participantBlockReason = participantChoices.length === 0
    ? t('conversation_ui.preflight.agent_setup_pending')
    : participantChoices.find(choice => choice.options.length === 0)
      ? t('conversation_ui.preflight.no_cli_for_agent', { agent: participantChoices.find(choice => choice.options.length === 0)!.member.agent_name })
      : participantChoices.find(choice => !choice.selected)
        ? t('conversation_ui.preflight.choose_cli_for_agent', { agent: participantChoices.find(choice => !choice.selected)!.member.agent_name })
        : null
  const draftBlockedReason = initialized ? localizedWorkspaceReason(summary?.blocked_reason,t) ?? null : draftReason({
    host: selectedHost,
    primary: selectedPrimary,
    location: selectedLocation,
    profile: selectedProfile,
    candidateProfileCount: candidateProfiles.length,
    participantBlockReason,
  })
  const ready = Boolean(sessionId && initialized && summary?.can_send)
  useEffect(()=>{if(!initialized)setBaselineMode('')},[primaryKey,hostId,initialized])
  const baselineRequired=Boolean(!initialized&&selectedLocation?.git?.dirty&&!baselineMode)
  const effectiveDraftBlockedReason=(selectedPrimary?.kind==='location'&&selectedHost?.isolated_workspaces_available===false?t('workspace_ui.execution.host_upgrade_required'):null)??draftBlockedReason??(baselineRequired?t('workspace_ui.execution.baseline_required'):null)

  useEffect(() => {
    if (!preflight || initialized) return
    const preferredLocation = preferredProjectFolderId
      ? executableLocations.find(location => location.project_folder_id === preferredProjectFolderId) ?? null
      : null
    const serverHost = preferredLocation?.execution_host_id
      ?? summary?.host?.host_id
      ?? (preflight.available_hosts.filter(host => host.online).length === 1
        ? preflight.available_hosts.find(host => host.online)?.host_id
        : executableLocations.length === 1 ? executableLocations[0]!.execution_host_id : '')
    const serverPrimary = preferredLocation
      ? `location:${preferredLocation.workspace_location_id}`
      : preferredProjectFolderId
        ? 'managed'
        : summary?.primary
          ? summary.primary.kind === 'managed' ? 'managed' : `location:${summary.primary.workspace_location_id}`
          : executableLocations.length === 1 ? `location:${executableLocations[0]!.workspace_location_id}`
            : executableLocations.length === 0 ? 'managed' : ''
    setHostId(current => hostSelectionTouched.current ? current : serverHost || current || '')
    setPrimaryKey(current => {
      if (primarySelectionTouched.current) return current
      // Files & Code may finish loading after this preflight request. Once its
      // current Folder is known, it should still win over an earlier managed
      // fallback while the draft remains untouched.
      if (preferredProjectFolderId) return serverPrimary
      return current || serverPrimary
    })
    if (summary?.runtime?.runtime_profile_id) {
      const pinned = profiles.find(profile => profile.runtime_profile_id === summary.runtime!.runtime_profile_id)
      if (pinned) setRuntimeProfileId(current => current || runtimeCandidateKey(pinned))
    }
  }, [executableLocations, initialized, onReadyChange, preflight, preferredProjectFolderId, ready, summary, scope])

  useEffect(() => {
    if (initialized || !hostId || !selectedPrimary) return
    setRuntimeProfileId(current => (
      current && candidateProfiles.some(profile => runtimeCandidateKey(profile) === current)
        ? current
        : suggestedRuntimeCandidateKey(candidateProfiles)
    ))
    setParticipantRuntimeProfileIds(current => {
      let changed = false
      const next = { ...current }
      for (const choice of participantChoices) {
        if (choice.member.role === 'manager') continue
        const currentId = next[choice.member.agent_id] ?? ''
        const nextId = currentId && choice.options.some(profile => runtimeCandidateKey(profile) === currentId)
          ? currentId
          : suggestedRuntimeCandidateKey(choice.options)
        if (nextId !== currentId) {
          changed = true
          if (nextId) next[choice.member.agent_id] = nextId
          else delete next[choice.member.agent_id]
        }
      }
      return changed ? next : current
    })
  }, [candidateProfiles, hostId, initialized, participantChoices, selectedPrimary, scope])

  useEffect(() => { onReadyChange?.(ready) }, [onReadyChange, ready, scope])

  async function openDraft(): Promise<void> {
    const sequence = requestSequence.current
    setBusy(true)
    setError(null)
    try {
      const conversation = await roomsApi.createConversation(roomId, scope)
      if (activeScope.current !== executionScope || scope.signal?.aborted || sequence !== requestSequence.current) return
      // The Room response can be older than the provisioning transaction that
      // just completed. Refresh the authoritative roster before rendering the
      // draft so a newly-created Project Agent is immediately selectable.
      const nextDetail = await roomsApi.get(roomId, scope).catch(() => null)
      if (activeScope.current !== executionScope || scope.signal?.aborted || sequence !== requestSequence.current) return
      if (nextDetail) setDetail(nextDetail)
      if (activeScope.current === executionScope && !scope.signal?.aborted) onConversationCreated?.(conversation)
    } catch (cause) {
      if (activeScope.current !== executionScope || scope.signal?.aborted || sequence !== requestSequence.current) return
      const message = errMsg(cause)
      setError(message)
      toast.error(message)
    } finally {
      if (activeScope.current === executionScope && !scope.signal?.aborted && sequence === requestSequence.current) setBusy(false)
    }
  }

  async function chooseBaseline(mode:'committed'|'snapshot'){
    if(!initialized){setBaselineMode(mode);return;}
    const managerRuntime = summaryRuntimes.find(pin => pin.agent_id === manager?.agent_id)
      ?? (summary?.runtime?.agent_id === manager?.agent_id ? summary.runtime : null)
    if(!sessionId||!summary?.host||!summary.primary||!managerRuntime)return;
    setBusy(true);setError(null)
    try{
      const primary=summary.primary.kind==='managed'?{kind:'managed' as const}:{kind:'location' as const,workspace_location_id:summary.primary.workspace_location_id}
      await sessionsApi.initializeExecution(sessionId,{selection:{execution_host_id:summary.host.host_id,primary},runtime:runtimeChoice(managerRuntime),workspace_baseline:mode},scope)
      if(activeScope.current !== executionScope || scope.signal?.aborted)return;
      setBaselineMode(mode);await reload()
    }catch(e){if(activeScope.current === executionScope && !scope.signal?.aborted)setError(errMsg(e))}
    finally{if(activeScope.current === executionScope && !scope.signal?.aborted)setBusy(false)}
  }

  async function initialize(): Promise<void> {
    if (!sessionId || !selectedPrimary || !selectedProfile || !hostId) return
    setBusy(true)
    setError(null)
    try {
      const selection: ConversationExecutionSelection = {
        execution_host_id: hostId,
        primary: selectedPrimary,
      }
      const runtime: ConversationRuntimeChoice = {
        agent_id: selectedProfile.agent_id,
        runtime_profile_id: selectedProfile.runtime_profile_id,
        runtime_key: selectedProfile.runtime_key,
        runtime_installation: selectedProfile.runtime_installation!,
      }
      const additional_runtimes = participantChoices
        .filter(choice => choice.member.role !== 'manager' && choice.selected)
        .map(choice => ({
          agent_id: choice.selected!.agent_id,
          runtime_profile_id: choice.selected!.runtime_profile_id,
          runtime_key: choice.selected!.runtime_key,
          runtime_installation: choice.selected!.runtime_installation!,
        }))
      const workspaceBaseline = baselineMode && (selectedLocation?.git?.dirty
        || summary?.attachments.some(attachment => attachment.status === 'active' && attachment.git_dirty))
        ? { workspace_baseline: baselineMode }
        : {}
      await sessionsApi.initializeExecution(sessionId, additional_runtimes.length > 0
        ? { selection, runtime, participant_agent_ids:participantChoices.map(choice=>choice.member.agent_id), additional_runtimes,...workspaceBaseline }
        : { selection, runtime,participant_agent_ids:participantChoices.map(choice=>choice.member.agent_id),...workspaceBaseline }, scope)
      if (activeScope.current !== executionScope || scope.signal?.aborted) return
      if (!await reload()) return
      if (activeScope.current !== executionScope || scope.signal?.aborted) return
      toast.success(t('conversation_ui.preflight.initialized_toast'))
    } catch (cause) {
      if (activeScope.current !== executionScope || scope.signal?.aborted) return
      const message = errMsg(cause)
      setError(message)
      toast.error(message)
    } finally {
      if (activeScope.current === executionScope && !scope.signal?.aborted) setBusy(false)
    }
  }


  async function mutateAttachment(action: 'attach' | 'set_access' | 'revoke', attachmentId?: string, mode?: ConversationAttachmentAccessMode): Promise<void> {
    if (!sessionId) return
    setBusy(true)
    setError(null)
    try {
      if (action === 'attach') {
        const location = locations.find(candidate => candidate.workspace_location_id === attachLocationId)
        if (!location) return
        await sessionsApi.mutateExecutionAttachments(sessionId, {
          action: 'attach',
          mutation_id: crypto.randomUUID(),
          project_folder_id: location.project_folder_id,
          workspace_location_id: location.workspace_location_id,
          access_mode: attachMode,
        }, scope)
      } else if (action === 'set_access' && attachmentId && mode) {
        await sessionsApi.mutateExecutionAttachments(sessionId, {
          action: 'set_access', mutation_id: crypto.randomUUID(), attachment_id: attachmentId, access_mode: mode,
        }, scope)
      } else if (action === 'revoke' && attachmentId) {
        await sessionsApi.mutateExecutionAttachments(sessionId, {
          action: 'revoke', mutation_id: crypto.randomUUID(), attachment_id: attachmentId,
        }, scope)
      }
      if (activeScope.current !== executionScope || scope.signal?.aborted) return
      setAttachLocationId('')
      await reload()
    } catch (cause) {
      if (activeScope.current !== executionScope || scope.signal?.aborted) return
      const message = errMsg(cause)
      setError(message)
      toast.error(message)
    } finally {
      if (activeScope.current === executionScope && !scope.signal?.aborted) setBusy(false)
    }
  }

  function settings(environment: React.ReactNode) {
    const ids = initialized
      ? summary?.participant_agent_ids ?? summaryRuntimes.map(pin => pin.agent_id)
      : participantChoices.map(choice => choice.member.agent_id)
    const locked = !sessionId || !preflight || loading || Boolean(error) || scope.actionRole === 'worker' || scope.actionRole === 'viewer' || disabled || busy || Boolean(summary?.dispatch_locked) || !detail?.viewer_can_write
    const renderAgent = (id: string, actions: React.ReactNode) => {
      const config = agentConfigurations.find(agent => agent.id === id)
      const member = participantMembers.find(member => member.agent_id === id)
      const pin = summaryRuntimes.find(pin => pin.agent_id === id)
      return <ConversationAgentConfiguration agent={config ?? {
        id, name: member?.agent_name ?? t('conversation_ui.preflight.unknown_agent'),
        options: [], value: [], persistedValue: pin?.session_config ?? [], onChange: () => undefined,
        unavailableReason: profiles.some(profile => profile.agent_id === id && profile.usable) ? undefined : t('conversation_ui.settings.unavailable'),
      }} disabled={locked} actions={actions} defaultExpanded={ids.length === 1} />
    }
    const unavailable = sessionId && !preflight
    const recovery = <div className="space-y-2 text-xs" role="status">
      <p>{loading ? t('conversation_ui.preflight.loading') : error ?? t('conversation_ui.preflight.unavailable')}</p>
      {!loading && <Button size="sm" variant="outline" onClick={() => void reload()}>{t('conversation_ui.preflight.retry')}</Button>}
    </div>
    const participants = unavailable ? recovery : initialized && summary && detail
      ? <ConversationParticipantsEditor summary={summary} profiles={profiles} availableAgents={preflight?.available_participant_agents} detail={detail} onSaved={async saved => { const result = await reload(); if (saved && result === false && activeScope.current === executionScope && !scope.signal?.aborted) setError(t('conversation_ui.participants.saved_refresh_failed')); return result }} disabled={locked}
          renderAgent={renderAgent} />
      : <ConversationDraftParticipants members={participantMembers} ids={ids}
          onChange={(id, participating) => setDraftParticipants(current => ({ ...current, [id]: participating }))}
          disabled={locked} renderAgent={renderAgent} />
    return <ConversationAgentSessionConfigs agents={agentConfigurations} open={settingsOpen} onOpenChange={onSettingsOpenChange} participantCount={unavailable ? null : ids.length}
      participants={participants} environment={environment} environmentIssue={unavailable ? null : !ready ? error ?? effectiveDraftBlockedReason ?? t('conversation_ui.preflight.review_first') : null} disabled={locked} />
  }

  if (!sessionId) {
    return settings(
      <div className="space-y-2" data-testid="execution-preflight-draft">
        <div className="flex items-center gap-2 text-sm font-medium"><Shield className="size-4" />{t('conversation_ui.preflight.setup_title')}</div>
        <p className="text-xs text-muted-foreground">{t('conversation_ui.preflight.setup_description')}</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={busy || disabled || scope.actionRole === 'worker' || scope.actionRole === 'viewer' || !detail?.viewer_can_write} onClick={() => void openDraft()}>{busy ? <Loader2 className="mr-1 size-3.5 animate-spin" /> : null}{t('conversation_ui.preflight.configure')}</Button>
          <Link to="/command-center" className="inline-flex items-center text-xs underline">{t('conversation_ui.preflight.configure_host')}</Link>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    )
  }

  if (loading && !preflight) return settings(<div className="text-xs text-muted-foreground"><Loader2 className="mr-1 inline size-3.5 animate-spin" />{t('conversation_ui.preflight.loading')}</div>)
  if (!preflight) return settings(<div className="space-y-2 text-xs"><p className="text-destructive">{error ?? t('conversation_ui.preflight.unavailable')}</p><Button size="sm" variant="outline" onClick={() => void reload()}><RefreshCw className="mr-1 size-3.5" />{t('conversation_ui.preflight.retry')}</Button></div>)

  const cacheNotice = initialized && summary?.runtimes?.some(isPromptCacheExpired) ? <ConversationCacheNotice expanded
    runtimes={summary.runtimes ?? []}
    nameForAgent={id => participantMembers.find(member => member.agent_id === id)?.agent_name
      ?? profiles.find(profile => profile.agent_id === id)?.agent_name ?? t('conversation_ui.preflight.unknown_agent')}
    disabled={disabled || busy || loading || summary.dispatch_locked || !detail?.viewer_can_write}
    onReset={async agentId => {
      if (!sessionId) return
      await roomsApi.resetAgentContext(roomId, agentId, sessionId, scope)
      if (activeScope.current !== executionScope || scope.signal?.aborted) return
      await reload()
    }}
  /> : null

  return settings(
    <fieldset disabled={scope.actionRole === 'worker' || scope.actionRole === 'viewer' || !detail?.viewer_can_write} className="min-w-0 space-y-3" data-testid="execution-preflight">
      <div className="flex flex-wrap items-center gap-2 text-sm"><Badge variant={ready ? 'success' : 'warning'}>{t(ready ? 'conversation_ui.settings.ready' : 'conversation_ui.settings.blocked')}</Badge><Button asChild size="sm" variant="outline"><Link to={`/projects/${projectId}/files`}>{t('conversation_ui.changes.files')}</Link></Button>
        <Button size="sm" variant="ghost" className="ml-auto" aria-label={t('conversation_ui.preflight.refresh')} onClick={() => void reload()} disabled={loading || busy}><RefreshCw className={`size-3.5 ${loading || busy ? 'animate-spin' : ''}`} /></Button>
      </div>
      {!initialized && <p className="text-xs text-muted-foreground">{t('conversation_ui.preflight.review_first')}</p>}
      {((initialized?summary?.git?.dirty:selectedLocation?.git?.dirty)||summary?.attachments.some(a=>a.status==='active'&&a.git_dirty))&&<div className="space-y-2 rounded-md border border-border bg-muted/20 p-3">
        <p className="text-sm font-medium">{t('workspace_ui.execution.baseline_title')}</p>
        <p className="text-xs text-muted-foreground">{t('workspace_ui.execution.baseline_description')}</p>
        <div className="flex flex-wrap gap-2"><Button size="sm" variant={baselineMode==='committed'?'default':'outline'} disabled={busy || disabled || loading || Boolean(summary?.dispatch_locked)} onClick={()=>void chooseBaseline('committed')}>{t('workspace_ui.execution.baseline_committed')}</Button><Button size="sm" variant={baselineMode==='snapshot'?'default':'outline'} disabled={busy || disabled || loading || Boolean(summary?.dispatch_locked)} onClick={()=>void chooseBaseline('snapshot')}>{t('workspace_ui.execution.baseline_snapshot')}</Button></div>
        {baselineMode&&<p className="text-xs text-muted-foreground">{t(`workspace_ui.execution.baseline_selected_${baselineMode}`)}</p>}
      </div>}
      {initialized ? (
        <InitializedSummary summary={summary!} profiles={profiles} participants={participantMembers} cacheNotice={cacheNotice} />
      ) : (
        <fieldset disabled={disabled || busy || loading || Boolean(summary?.dispatch_locked)} className="space-y-2">
          <SelectionField label={t('conversation_ui.preflight.host')} value={hostId} onChange={value => { hostSelectionTouched.current = true; setHostId(value) }} options={preflight.available_hosts.map(host => ({ value: host.host_id, label: hostLabel(host) }))} placeholder={t('conversation_ui.preflight.choose_host')} />
          <SelectionField label={t('conversation_ui.preflight.primary')} value={primaryKey} onChange={value => { primarySelectionTouched.current = true; setPrimaryKey(value) }} options={[
            { value: 'managed', label: t('conversation_ui.preflight.managed_workspace') },
            ...locations.map(location => ({ value: `location:${location.workspace_location_id}`, label: `${location.folder_name}${location.display_path ? ` · ${location.display_path}` : ''}${location.execution_ready ? '' : t('conversation_ui.preflight.not_ready_suffix')}` })),
          ]} placeholder={t('conversation_ui.preflight.choose_primary')} />
          <ConversationGitContext snapshot={selectedPrimary?.kind === 'location' ? selectedLocation?.git ?? null : selectedPrimary?.kind === 'managed' ? managedGitSnapshot() : null} />
          {/* The fallback said out loud: with no Folder the Agent works in a
              managed workspace on the Host, not in this Project's code, and
              the only place to change that is Files & Code. */}
          {locations.length === 0 && (
            <div className="text-xs text-muted-foreground" data-testid="preflight-no-folder">
              {t('conversation_ui.preflight.no_folder')}{' '}
              <Link to={`/projects/${projectId}/files?setup=folder`} className="underline">{t('conversation_ui.preflight.connect_folder')}</Link>
            </div>
          )}
          {participantChoices.filter(choice => choice.options.length > 0 && (!choice.selected || choice.options.length > 1)).map(({ member, options, selectedId }) => (
            <SelectionField
              key={member.agent_id}
              label={member.role === 'manager' ? t('conversation_ui.preflight.cli_installation') : t('conversation_ui.preflight.cli_installation_for', { agent: member.agent_name })}
              value={selectedId}
              onChange={value => member.role === 'manager'
                ? setRuntimeProfileId(value)
                : setParticipantRuntimeProfileIds(current => ({ ...current, [member.agent_id]: value }))}
              options={options.map(profile => ({ value: runtimeCandidateKey(profile), label: `${profile.agent_name} · ${profile.runtime_key} · ${profile.runtime_installation}${profile.runtime_profile_id ? '' : t('conversation_ui.preflight.detected_suffix')}` }))}
              placeholder={t('conversation_ui.preflight.choose_cli')}
              disabled={!hostId || !selectedPrimary}
            />
          ))}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {selectedHost && <Badge variant={selectedHost.online ? 'success' : 'destructive'}>{selectedHost.online ? t('conversation_ui.preflight.daemon_online') : t('conversation_ui.preflight.daemon_offline')}</Badge>}
            {selectedHost && !selectedHost.online && <span className="text-muted-foreground">{t('conversation_ui.preflight.browser_note')}</span>}
          </div>
          {effectiveDraftBlockedReason && <p className="text-xs text-destructive">{effectiveDraftBlockedReason}</p>}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy || effectiveDraftBlockedReason !== null} onClick={() => void initialize()}>{busy ? <Loader2 className="mr-1 size-3.5 animate-spin" /> : null}{t('conversation_ui.preflight.confirm')}</Button>
            {!manager && <Button size="sm" variant="outline" disabled={busy || disabled || scope.actionRole === 'worker' || scope.actionRole === 'viewer' || !detail?.viewer_can_write} onClick={() => void openDraft()}>{t('conversation_ui.preflight.retry_agent')}</Button>}
            {/* The Host chosen above, when there is one; otherwise the overview. */}
            <Link to={hostId ? commandCenterHostPath(hostId, 'runtime') : '/command-center'} className="inline-flex items-center text-xs underline">{t('conversation_ui.preflight.configure_host')}</Link>
          </div>
        </fieldset>
      )}

      {initialized && <AttachmentControls
        summary={summary!}
        locations={locations}
        selectedLocationId={attachLocationId}
        onLocationChange={setAttachLocationId}
        mode={attachMode}
        onModeChange={setAttachMode}
        onMutate={mutateAttachment}
        disabled={busy || disabled || loading || Boolean(error) || Boolean(summary?.dispatch_locked)}
      />}
      {onNewConversation && initialized && <div className="flex flex-wrap items-center gap-2"><Button size="sm" variant="outline" onClick={onNewConversation}>{t('conversation_ui.preflight.new_conversation')}</Button><Popover><PopoverTrigger asChild><Button type="button" size="sm" variant="ghost" aria-label={t('conversation_ui.settings.environment_help')}><Info className="size-3.5" /></Button></PopoverTrigger><PopoverContent className="text-xs">{t('conversation_ui.settings.locked')}</PopoverContent></Popover></div>}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </fieldset>
  )
}

function SelectionField({ label, value, onChange, options, placeholder, disabled = false }: {
  label: string
  value: string
  onChange: (value: string) => void
  options: Array<{ value: string; label: string; disabled?: boolean }>
  placeholder: string
  disabled?: boolean
}) {
  return <div className="space-y-1"><Label className="text-xs">{label}</Label><Select ariaLabel={label} value={value} onChange={onChange} options={[{ value: '', label: placeholder, disabled: true }, ...options]} disabled={disabled} /></div>
}

function managedGitSnapshot(): NonNullable<ConversationExecutionSummary['git']> {
  return {
    source: 'managed_workspace',
    workspace_location_id: null,
    branch: null,
    commit_sha: null,
    dirty: null,
    execution_ready: true,
    observed_at: new Date().toISOString(),
  }
}

function AttachmentControls({ summary, locations, selectedLocationId, onLocationChange, mode, onModeChange, onMutate, disabled }: {
  summary: ConversationExecutionSummary
  locations: ConversationExecutionPreflightResponse['available_primary_locations']
  selectedLocationId: string
  onLocationChange: (value: string) => void
  mode: ConversationAttachmentAccessMode
  onModeChange: (value: ConversationAttachmentAccessMode) => void
  onMutate: (action: 'attach' | 'set_access' | 'revoke', attachmentId?: string, mode?: ConversationAttachmentAccessMode) => Promise<void>
  disabled: boolean
}) {
  const { t } = useAppTranslation()
  const [adding, setAdding] = useState(false)
  const hostId = summary.host?.host_id
  const attached = new Set(summary.attachments.filter(item => item.status === 'active').map(item => item.workspace_location_id))
  const candidates = locations.filter(location => {
    if (!location.execution_ready || location.execution_host_id !== hostId || attached.has(location.workspace_location_id)) return false
    return summary.primary?.kind !== 'location' || location.workspace_location_id !== summary.primary.workspace_location_id
  })
  return <div className="space-y-2 border-t border-border pt-2">
      {summary.attachments.some(item => item.status === 'active') && <div className="text-xs font-medium">{t('conversation_ui.preflight.attached_folders')}</div>}

    {summary.attachments.filter(item => item.status === 'active').map(attachment => {
      return <div key={attachment.id} className="flex flex-wrap items-center gap-2 rounded border border-border px-2 py-1 text-xs">
      <div className="flex min-w-0 basis-full items-center gap-2"><span title={attachment.display_path ?? attachment.folder_name} className="min-w-0 flex-1 truncate">{attachment.folder_name}{attachment.display_path ? ` · ${attachment.display_path}` : ''}</span><Badge variant="outline" className="shrink-0">{t(attachment.access_mode === 'write' ? 'conversation_ui.preflight.access_write' : 'conversation_ui.preflight.access_read')}</Badge></div>
      {attachment.status === 'active' && <>
        <Button size="sm" variant="ghost" disabled={disabled || attachment.access_mode === 'write'} onClick={() => void onMutate('set_access', attachment.id, 'write')}>{t('conversation_ui.preflight.grant_write')}</Button>
        <Button size="sm" variant="ghost" disabled={disabled || attachment.access_mode === 'read'} onClick={() => void onMutate('set_access', attachment.id, 'read')}>{t('conversation_ui.preflight.read_only')}</Button>
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => void onMutate('revoke', attachment.id)}>{t('conversation_ui.preflight.revoke')}</Button>
      </>}
    </div>
    })}
    <Button size="sm" variant="outline" disabled={disabled} onClick={() => setAdding(!adding)}>{t('conversation_ui.settings.add_folder')}</Button>
    {adding && candidates.length === 0 && <p className="text-xs text-muted-foreground">{t('conversation_ui.settings.no_folders')}</p>}
    {adding && candidates.length > 0 && <div className="flex flex-wrap items-end gap-2">
      <div className="min-w-0 flex-1"><SelectionField label={t('conversation_ui.preflight.folder')} value={selectedLocationId} onChange={onLocationChange} options={candidates.map(location => ({ value: location.workspace_location_id, label: `${location.folder_name}${location.display_path ? ` · ${location.display_path}` : ''}` }))} placeholder={t('conversation_ui.preflight.choose_attach')} disabled={disabled} /></div>
      <div className="w-24"><SelectionField label={t('conversation_ui.preflight.access')} value={mode} onChange={value => onModeChange(value as ConversationAttachmentAccessMode)} options={[{ value: 'read', label: t('conversation_ui.preflight.read') }, { value: 'write', label: t('conversation_ui.preflight.write') }]} placeholder={t('conversation_ui.preflight.access')} disabled={disabled} /></div>
      <Button size="sm" disabled={disabled || !selectedLocationId} onClick={() => void onMutate('attach')}>{t('conversation_ui.preflight.attach')}</Button>
    </div>}
    {(adding || summary.attachments.some(item => item.status === 'active')) && <p className="text-xs text-muted-foreground">{t('conversation_ui.preflight.attach_note')}</p>}
  </div>
}

function hostLabel(host: ConversationExecutionHostSummary): string {
  return `${host.host_name} · ${host.online ? i18n.t('conversation_ui.preflight.host_online') : i18n.t('conversation_ui.preflight.host_offline')}${host.host_kind === 'server' ? i18n.t('conversation_ui.preflight.host_server_suffix') : ''}`
}

function runtimeCandidateKey(profile: ConversationExecutionRuntimeProfile): string {
  return JSON.stringify([
    profile.runtime_profile_id ?? 'detected',
    profile.agent_id,
    profile.execution_host_id ?? '',
    profile.workspace_mode ?? '',
    profile.workspace_location_id ?? '',
    profile.runtime_key,
    profile.runtime_installation ?? '',
  ])
}

function suggestedRuntimeCandidateKey(profiles: ConversationExecutionRuntimeProfile[]): string {
  const preferred = profiles.filter(profile => profile.preferred)
  const persisted = profiles.filter(profile => profile.runtime_profile_id !== null)
  const suggested = preferred.length === 1 ? preferred[0] : persisted.length === 1 ? persisted[0] : profiles.length === 1 ? profiles[0] : null
  return suggested ? runtimeCandidateKey(suggested) : ''
}

function draftReason(input: {
  host: ConversationExecutionHostSummary | null
  primary: ConversationExecutionSelection['primary'] | null
  location: ConversationExecutionPreflightResponse['available_primary_locations'][number] | null
  profile: ConversationExecutionRuntimeProfile | null
  candidateProfileCount: number
  participantBlockReason: string | null
}): string | null {
  if (!input.host) return i18n.t('conversation_ui.preflight.reason.choose_host')
  if (!input.host.online) return i18n.t('conversation_ui.preflight.reason.host_offline')
  if (input.primary === null) return i18n.t('conversation_ui.preflight.reason.choose_primary')
  if (input.primary.kind === 'location' && (!input.location || !input.location.execution_ready)) return i18n.t('conversation_ui.preflight.reason.primary_not_ready')
  if (input.location && input.location.execution_host_id !== input.host.host_id) return i18n.t('conversation_ui.preflight.reason.host_mismatch')
  if (input.primary.kind === 'managed' && !input.host.managed_workspace_available) return i18n.t('conversation_ui.preflight.reason.no_managed')
  if (!input.profile) return input.candidateProfileCount > 1 ? i18n.t('conversation_ui.preflight.reason.choose_cli') : i18n.t('conversation_ui.preflight.reason.no_cli')
  if (input.participantBlockReason) return input.participantBlockReason
  return null
}
