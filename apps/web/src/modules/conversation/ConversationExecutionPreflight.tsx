import { ConversationScope, useConversationScope } from './ConversationScope'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Loader2, RefreshCw, Shield, Unplug } from 'lucide-react'
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
import { Card } from '../../components/ui/card'
import { Label } from '../../components/ui/label'
import { Select } from '../../components/ui/select'
import { ConversationCacheNotice } from './ConversationCacheNotice'
import { ConversationGitContext } from './ConversationGitContext'

interface ConversationExecutionPreflightProps {
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
  return <ConversationScope key={`${props.spaceId ?? ''}:${props.roomId}:${props.sessionId ?? 'new'}`} spaceId={props.spaceId}><ConversationExecutionPreflightContent key={`${props.spaceId ?? ''}:${props.roomId}:${props.sessionId ?? 'new'}`} {...props} /></ConversationScope>
}

function ConversationExecutionPreflightContent({
  projectId,
  roomId,
  sessionId,
  preferredProjectFolderId = null,
  detail: suppliedDetail,
  onConversationCreated,
  onNewConversation,
  onReadyChange,
  onSummaryChange,
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
  const [attachLocationId, setAttachLocationId] = useState('')
  const [attachMode, setAttachMode] = useState<ConversationAttachmentAccessMode>('write')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [executionDetailsOpen, setExecutionDetailsOpen] = useState(false)
  const requestSequence = useRef(0)
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
    setAttachLocationId('')
    setError(null)
    setExecutionDetailsOpen(false)
    hostSelectionTouched.current = false
    primarySelectionTouched.current = false
    onReadyChange?.(false)
    onSummaryChange?.(null)
  }, [onReadyChange, onSummaryChange, sessionId, scope])

  useEffect(() => {
    if (suppliedDetail !== undefined) setDetail(suppliedDetail)
  }, [suppliedDetail, scope])

  useEffect(() => {
    if (!sessionId || suppliedDetail?.agent_members.some(member => member.role === 'manager')) return
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
      if (scope.signal?.aborted || sequence !== requestSequence.current) return
      setPreflight(next)
      setProfiles(next.available_runtime_profiles ?? [])
      onSummaryChange?.(next.summary)
      // Said again here, not only when `ready` changes: a failed refresh
      // reported false while `ready` (from the kept preflight) stayed true, so
      // the next good refresh changed nothing and sending stayed disabled.
      onReadyChange?.(Boolean(next.summary.state === 'initialized' && next.summary.can_send))
    } catch (cause) {
      if (scope.signal?.aborted || sequence !== requestSequence.current) return
      const message = errMsg(cause)
      setError(message)
      onReadyChange?.(false)
      onSummaryChange?.(null)
    } finally {
      setLoading(false)
    }
  }, [onReadyChange, onSummaryChange, sessionId, scope])

  useEffect(() => { void reload() }, [reload, scope])

  useEffect(() => {
    if (!sessionId) return
    const refresh = () => { if (document.visibilityState === 'visible') void reload() }
    const interval = window.setInterval(refresh, 30_000)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [reload, sessionId, scope])

  const summary = preflight?.summary ?? null
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
  const participantChoices = participantMembers.map(member => {
    const options = candidateProfilesByAgent.get(member.agent_id) ?? []
    const selectedId = member.role === 'manager' ? runtimeProfileId : participantRuntimeProfileIds[member.agent_id] ?? ''
    return {
      member,
      options,
      selectedId,
      selected: options.find(profile => runtimeCandidateKey(profile) === selectedId) ?? null,
    }
  })
  const participantBlockReason = participantChoices.length === 0
    ? t('conversation_ui.preflight.agent_setup_pending')
    : participantChoices.find(choice => choice.options.length === 0)
      ? t('conversation_ui.preflight.no_cli_for_agent', { agent: participantChoices.find(choice => choice.options.length === 0)!.member.agent_name })
      : participantChoices.find(choice => !choice.selected)
        ? t('conversation_ui.preflight.choose_cli_for_agent', { agent: participantChoices.find(choice => !choice.selected)!.member.agent_name })
        : null
  const draftBlockedReason = initialized ? summary?.blocked_reason ?? null : draftReason({
    host: selectedHost,
    primary: selectedPrimary,
    location: selectedLocation,
    profile: selectedProfile,
    candidateProfileCount: candidateProfiles.length,
    participantBlockReason,
  })
  const ready = Boolean(sessionId && initialized && summary?.can_send)

  useEffect(() => {
    if (initialized && (summary?.blocked_reason || error)) setExecutionDetailsOpen(true)
  }, [error, initialized, summary?.blocked_reason, scope])

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
    setBusy(true)
    setError(null)
    try {
      const conversation = await roomsApi.createConversation(roomId, scope)
      // The Room response can be older than the provisioning transaction that
      // just completed. Refresh the authoritative roster before rendering the
      // draft so a newly-created Project Agent is immediately selectable.
      const nextDetail = await roomsApi.get(roomId, scope).catch(() => null)
      if (nextDetail) setDetail(nextDetail)
      if (!scope.signal?.aborted) onConversationCreated?.(conversation)
    } catch (cause) {
      const message = errMsg(cause)
      setError(message)
      toast.error(message)
    } finally {
      setBusy(false)
    }
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
      await sessionsApi.initializeExecution(sessionId, additional_runtimes.length > 0
        ? { selection, runtime, additional_runtimes }
        : { selection, runtime }, scope)
      await reload()
      toast.success(t('conversation_ui.preflight.initialized_toast'))
    } catch (cause) {
      const message = errMsg(cause)
      setError(message)
      toast.error(message)
    } finally {
      setBusy(false)
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
      setAttachLocationId('')
      await reload()
    } catch (cause) {
      const message = errMsg(cause)
      setError(message)
      toast.error(message)
    } finally {
      setBusy(false)
    }
  }

  if (!sessionId) {
    return (
      <Card className="m-3 space-y-2 border-dashed p-3" data-testid="execution-preflight-draft">
        <div className="flex items-center gap-2 text-sm font-medium"><Shield className="size-4" />{t('conversation_ui.preflight.setup_title')}</div>
        <p className="text-xs text-muted-foreground">{t('conversation_ui.preflight.setup_description')}</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={busy} onClick={() => void openDraft()}>{busy ? <Loader2 className="mr-1 size-3.5 animate-spin" /> : null}{t('conversation_ui.preflight.configure')}</Button>
          <Link to="/command-center" className="inline-flex items-center text-xs underline">{t('conversation_ui.preflight.configure_host')}</Link>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </Card>
    )
  }

  if (loading && !preflight) return <Card className="m-3 p-3 text-xs text-muted-foreground"><Loader2 className="mr-1 inline size-3.5 animate-spin" />{t('conversation_ui.preflight.loading')}</Card>
  if (!preflight) return <Card className="m-3 space-y-2 p-3 text-xs"><p className="text-destructive">{error ?? t('conversation_ui.preflight.unavailable')}</p><Button size="sm" variant="outline" onClick={() => void reload()}><RefreshCw className="mr-1 size-3.5" />{t('conversation_ui.preflight.retry')}</Button></Card>

  const cacheNotice = initialized && summary ? <ConversationCacheNotice
    runtimes={summary.runtimes ?? []}
    nameForAgent={id => participantMembers.find(member => member.agent_id === id)?.agent_name
      ?? profiles.find(profile => profile.agent_id === id)?.agent_name ?? t('conversation_ui.preflight.unknown_agent')}
    disabled={busy || loading || summary.dispatch_locked || !detail?.viewer_can_write}
    onReset={async agentId => {
      if (!sessionId) return
      await roomsApi.resetAgentContext(roomId, agentId, sessionId, scope)
      await reload()
    }}
  /> : null

  if (initialized && !executionDetailsOpen) {
    return (
      <Card className="m-3 p-0" data-testid="execution-preflight-collapsed">
        <button
          type="button"
          className="flex w-full items-center gap-2 p-2.5 text-left text-xs text-muted-foreground hover:text-foreground"
          aria-expanded="false"
          onClick={() => setExecutionDetailsOpen(true)}
        >
          <Shield className="size-3.5" />
          <span className="flex-1">{t('conversation_ui.preflight.configured')}</span>
          <ChevronRight className="size-3.5" />
        </button>
        {cacheNotice && <div className="px-2.5 pb-2.5">{cacheNotice}</div>}
      </Card>
    )
  }

  return (
    <Card className="m-3 space-y-3 p-3" data-testid="execution-preflight">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2 text-sm font-medium"><Shield className="size-4" />{t('conversation_ui.preflight.title')}</div>
          <p className="text-xs text-muted-foreground">{initialized ? t('conversation_ui.preflight.pinned') : t('conversation_ui.preflight.review_first')}</p>
        </div>
        <div className="flex items-center gap-1">
          {initialized && <Button size="sm" variant="ghost" aria-label={t('conversation_ui.preflight.collapse')} aria-expanded="true" onClick={() => setExecutionDetailsOpen(false)}><ChevronDown className="size-3.5" /></Button>}
          <Button size="sm" variant="ghost" aria-label={t('conversation_ui.preflight.refresh')} onClick={() => void reload()} disabled={loading || busy}><RefreshCw className={`size-3.5 ${loading || busy ? 'animate-spin' : ''}`} /></Button>
        </div>
      </div>

      {cacheNotice}
      {initialized ? (
        <InitializedSummary summary={summary!} profiles={profiles} participants={participantMembers} />
      ) : (
        <div className="space-y-2">
          <div className="rounded border border-border bg-muted/20 px-2 py-1.5 text-xs">
            <span className="font-medium">{t('conversation_ui.preflight.agents')}</span>
            <div className="mt-1 space-y-1">
              {participantChoices.map(({ member, options, selected }) => (
                <div key={member.agent_id} className="flex items-center justify-between gap-2">
                  <span className="min-w-0 flex-1">{member.agent_name}{member.role === 'manager' ? t('conversation_ui.preflight.manager_suffix') : ''}</span>
                  <span className={selected ? 'text-muted-foreground' : 'text-destructive'}>
                    {selected ? t('conversation_ui.preflight.runtime_ready') : options.length === 0 ? t('conversation_ui.preflight.runtime_unavailable') : t('conversation_ui.preflight.choose_runtime')}
                  </span>
                </div>
              ))}
              {participantChoices.length === 0 && (
                <span className="text-destructive">{t('conversation_ui.preflight.agent_setup_pending')}</span>
              )}
            </div>
          </div>
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
          {participantChoices.map(({ member, options, selectedId }) => (
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
          {draftBlockedReason && <p className="text-xs text-destructive">{draftBlockedReason}</p>}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy || draftBlockedReason !== null} onClick={() => void initialize()}>{busy ? <Loader2 className="mr-1 size-3.5 animate-spin" /> : null}{t('conversation_ui.preflight.confirm')}</Button>
            {!manager && <Button size="sm" variant="outline" disabled={busy} onClick={() => void openDraft()}>{t('conversation_ui.preflight.retry_agent')}</Button>}
            <Link to="/command-center" className="inline-flex items-center text-xs underline">{t('conversation_ui.preflight.configure_host')}</Link>
          </div>
        </div>
      )}

      {initialized && <AttachmentControls
        summary={summary!}
        locations={locations}
        selectedLocationId={attachLocationId}
        onLocationChange={setAttachLocationId}
        mode={attachMode}
        onModeChange={setAttachMode}
        onMutate={mutateAttachment}
        disabled={busy}
      />}
      {onNewConversation && initialized && <Button size="sm" variant="outline" onClick={onNewConversation}>{t('conversation_ui.preflight.new_conversation')}</Button>}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </Card>
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

function InitializedSummary({ summary, profiles, participants }: {
  summary: ConversationExecutionSummary
  profiles: ConversationExecutionRuntimeProfile[]
  participants: RoomDetail['agent_members']
}) {
  const { t } = useAppTranslation()
  const host = summary.host
  const primary = summary.primary
  const runtime = summary.runtime
  const pinnedRuntimes = summary.runtimes ?? []
  const runtimes: PinnedRuntime[] = pinnedRuntimes.length > 0 ? pinnedRuntimes : runtime ? [runtime] : []
  return <div className="space-y-1.5 text-xs">
    <div className="space-y-1">
      <span className="font-medium">{t('conversation_ui.preflight.agents_cli')}</span>
      {runtimes.length > 0 ? runtimes.map(pinned => (
        <div key={pinned.agent_id}>
          <SummaryRow
            label={participants.find(participant => participant.agent_id === pinned.agent_id)?.agent_name
              ?? profiles.find(profile => profile.runtime_profile_id === pinned.runtime_profile_id)?.agent_name
              ?? t('conversation_ui.preflight.unknown_agent')}
            value={`${pinned.runtime_key} · ${pinned.runtime_installation}${sessionOccupancy(pinned)}`}
          />
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
    </div>
    <SummaryRow label={t('conversation_ui.preflight.host_label')} value={host ? `${host.host_name}${host.online ? t('conversation_ui.preflight.daemon_online_suffix') : t('conversation_ui.preflight.daemon_offline_suffix')}` : t('conversation_ui.preflight.unavailable_value')} tone={host?.online === false ? 'danger' : undefined} />
    <SummaryRow label={t('conversation_ui.preflight.primary_cwd')} value={primary?.display_path ?? (primary?.kind === 'managed' ? t('conversation_ui.preflight.managed_workspace') : t('conversation_ui.preflight.unavailable_value'))} />
    <ConversationGitContext snapshot={summary.git ?? null} />
    {summary.blocked_reason && <p className="rounded bg-destructive/10 px-2 py-1 text-destructive">{summary.blocked_reason}</p>}
    {host?.online === false && <div className="flex items-center gap-1 text-muted-foreground"><Unplug className="size-3.5" />{t('conversation_ui.preflight.offline_note')}<Link to="/command-center" className="underline">{t('conversation_ui.preflight.reconnect_host')}</Link></div>}
    {!runtime && <p className="text-muted-foreground">{t('conversation_ui.preflight.runtime_gone')}</p>}
  </div>
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
  const hostId = summary.host?.host_id
  const attached = new Set(summary.attachments.filter(item => item.status === 'active').map(item => item.workspace_location_id))
  const candidates = locations.filter(location => {
    if (!location.execution_ready || location.execution_host_id !== hostId || attached.has(location.workspace_location_id)) return false
    return summary.primary?.kind !== 'location' || location.workspace_location_id !== summary.primary.workspace_location_id
  })
  return <div className="space-y-2 border-t border-border pt-2">
      <div className="text-xs font-medium">{t('conversation_ui.preflight.attached_folders')}</div>
    {summary.attachments.length === 0 && <p className="text-xs text-muted-foreground">{t('conversation_ui.preflight.no_attachments')}</p>}
    {summary.attachments.map(attachment => {
      return <div key={attachment.id} className="flex flex-wrap items-center gap-2 rounded border border-border px-2 py-1 text-xs">
      <span className="min-w-0 flex-1 truncate">{attachment.folder_name}{attachment.display_path ? ` · ${attachment.display_path}` : ''} · {attachment.access_mode === 'write' ? t('conversation_ui.preflight.access_write') : t('conversation_ui.preflight.access_read')}</span>
      {attachment.status === 'active' && <>
        <Button size="sm" variant="ghost" disabled={disabled || attachment.access_mode === 'write'} onClick={() => void onMutate('set_access', attachment.id, 'write')}>{t('conversation_ui.preflight.grant_write')}</Button>
        <Button size="sm" variant="ghost" disabled={disabled || attachment.access_mode === 'read'} onClick={() => void onMutate('set_access', attachment.id, 'read')}>{t('conversation_ui.preflight.read_only')}</Button>
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => void onMutate('revoke', attachment.id)}>{t('conversation_ui.preflight.revoke')}</Button>
      </>}
    </div>
    })}
    {candidates.length > 0 && <div className="flex flex-wrap items-end gap-2">
      <div className="min-w-0 flex-1"><SelectionField label={t('conversation_ui.preflight.folder')} value={selectedLocationId} onChange={onLocationChange} options={candidates.map(location => ({ value: location.workspace_location_id, label: `${location.folder_name}${location.display_path ? ` · ${location.display_path}` : ''}` }))} placeholder={t('conversation_ui.preflight.choose_attach')} disabled={disabled} /></div>
      <div className="w-24"><SelectionField label={t('conversation_ui.preflight.access')} value={mode} onChange={value => onModeChange(value as ConversationAttachmentAccessMode)} options={[{ value: 'read', label: t('conversation_ui.preflight.read') }, { value: 'write', label: t('conversation_ui.preflight.write') }]} placeholder={t('conversation_ui.preflight.access')} disabled={disabled} /></div>
      <Button size="sm" disabled={disabled || !selectedLocationId} onClick={() => void onMutate('attach')}>{t('conversation_ui.preflight.attach')}</Button>
    </div>}
    <p className="text-xs text-muted-foreground">{t('conversation_ui.preflight.attach_note')}</p>
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
  return <div className="flex gap-2"><span className="w-24 shrink-0 text-muted-foreground">{label}</span><span className={tone === 'danger' ? 'text-destructive' : ''}>{value}</span></div>
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
  const candidate = preferred.length === 1
    ? preferred[0]
    : persisted.length === 1
      ? persisted[0]
      : profiles.length === 1
        ? profiles[0]
        : null
  return candidate ? runtimeCandidateKey(candidate) : ''
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
