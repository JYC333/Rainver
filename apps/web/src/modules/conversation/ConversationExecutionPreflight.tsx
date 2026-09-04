import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Loader2, RefreshCw, Shield, Unplug } from 'lucide-react'
import { toast } from 'sonner'
import { roomsApi, sessionsApi } from '../../api/client'
import { SpaceLink as Link } from '../../core/spaceNav'
import { errMsg } from '../../lib/utils'
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

export interface ConversationExecutionPreflightProps {
  projectId: string
  roomId: string
  sessionId: string | null
  detail?: RoomDetail | null
  onConversationCreated?: (conversation: RoomConversationRecord) => void
  onNewConversation?: () => void
  onReadyChange?: (ready: boolean) => void
}

/**
 * The execution contract shown next to every Room composer. It is deliberately
 * a small client of the session execution-context API: server preflight owns
 * authorization and readiness, while this component owns only the visible
 * selection and the explicit actions that the user requested.
 */
export function ConversationExecutionPreflight({
  projectId,
  roomId,
  sessionId,
  detail: suppliedDetail,
  onConversationCreated,
  onNewConversation,
  onReadyChange,
}: ConversationExecutionPreflightProps) {
  const [detail, setDetail] = useState<RoomDetail | null>(suppliedDetail ?? null)
  const [preflight, setPreflight] = useState<ConversationExecutionPreflightResponse | null>(null)
  const [profiles, setProfiles] = useState<ConversationExecutionRuntimeProfile[]>([])
  const [hostId, setHostId] = useState('')
  const [primaryKey, setPrimaryKey] = useState('')
  const [runtimeProfileId, setRuntimeProfileId] = useState('')
  const [participantRuntimeProfileIds, setParticipantRuntimeProfileIds] = useState<Record<string, string>>({})
  const [attachLocationId, setAttachLocationId] = useState('')
  const [attachMode, setAttachMode] = useState<ConversationAttachmentAccessMode>('read')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [executionDetailsOpen, setExecutionDetailsOpen] = useState(false)
  const requestSequence = useRef(0)

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
    onReadyChange?.(false)
  }, [onReadyChange, sessionId])

  useEffect(() => {
    if (suppliedDetail !== undefined) setDetail(suppliedDetail)
  }, [suppliedDetail])

  useEffect(() => {
    if (!sessionId || suppliedDetail?.agent_members.some(member => member.role === 'manager')) return
    let active = true
    roomsApi.get(roomId)
      .then(next => { if (active) setDetail(next) })
      .catch(() => undefined)
    return () => { active = false }
  }, [roomId, sessionId, suppliedDetail])

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
      const next = await sessionsApi.executionContext(sessionId)
      if (sequence !== requestSequence.current) return
      setPreflight(next)
      setProfiles(next.available_runtime_profiles ?? [])
    } catch (cause) {
      if (sequence !== requestSequence.current) return
      const message = errMsg(cause)
      setError(message)
      onReadyChange?.(false)
    } finally {
      setLoading(false)
    }
  }, [onReadyChange, sessionId])

  useEffect(() => { void reload() }, [reload])

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
  }, [reload, sessionId])

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
  }, [primaryKey])
  const selectedHost = preflight?.available_hosts.find(host => host.host_id === hostId) ?? null
  const selectedLocation = selectedPrimary?.kind === 'location'
    ? locations.find(location => location.workspace_location_id === selectedPrimary.workspace_location_id) ?? null
    : null
  const participantMembers = useMemo(
    () => (detail ?? suppliedDetail)?.agent_members ?? [],
    [detail, suppliedDetail],
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
  }, [hostId, participantMembers, profiles, selectedPrimary])
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
    ? 'Project Agent setup is pending; configure a usable backend and retry.'
    : participantChoices.find(choice => choice.options.length === 0)
      ? `The selected Host reports no usable CLI installation for Agent '${participantChoices.find(choice => choice.options.length === 0)!.member.agent_name}'.`
      : participantChoices.find(choice => !choice.selected)
        ? `Choose a CLI installation for Agent '${participantChoices.find(choice => !choice.selected)!.member.agent_name}'.`
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
  }, [error, initialized, summary?.blocked_reason])

  useEffect(() => {
    if (!preflight || initialized) return
    const serverHost = summary?.host?.host_id
      ?? (preflight.available_hosts.filter(host => host.online).length === 1
        ? preflight.available_hosts.find(host => host.online)?.host_id
        : executableLocations.length === 1 ? executableLocations[0]!.execution_host_id : '')
    const serverPrimary = summary?.primary
      ? summary.primary.kind === 'managed' ? 'managed' : `location:${summary.primary.workspace_location_id}`
      : executableLocations.length === 1 ? `location:${executableLocations[0]!.workspace_location_id}`
        : executableLocations.length === 0 ? 'managed' : ''
    setHostId(current => current || serverHost || '')
    setPrimaryKey(current => current || serverPrimary)
    if (summary?.runtime?.runtime_profile_id) {
      const pinned = profiles.find(profile => profile.runtime_profile_id === summary.runtime!.runtime_profile_id)
      if (pinned) setRuntimeProfileId(current => current || runtimeCandidateKey(pinned))
    }
  }, [executableLocations, initialized, onReadyChange, preflight, ready, summary])

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
  }, [candidateProfiles, hostId, initialized, participantChoices, selectedPrimary])

  useEffect(() => { onReadyChange?.(ready) }, [onReadyChange, ready])

  async function openDraft(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const conversation = await roomsApi.createConversation(roomId)
      // The Room response can be older than the provisioning transaction that
      // just completed. Refresh the authoritative roster before rendering the
      // draft so a newly-created Project Agent is immediately selectable.
      const nextDetail = await roomsApi.get(roomId).catch(() => null)
      if (nextDetail) setDetail(nextDetail)
      onConversationCreated?.(conversation)
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
        credential_profile_id: null,
        adapter_type: selectedProfile.adapter_type,
        runtime_installation: selectedProfile.runtime_installation!,
      }
      const additional_runtimes = participantChoices
        .filter(choice => choice.member.role !== 'manager' && choice.selected)
        .map(choice => ({
          agent_id: choice.selected!.agent_id,
          runtime_profile_id: choice.selected!.runtime_profile_id,
          credential_profile_id: null,
          adapter_type: choice.selected!.adapter_type,
          runtime_installation: choice.selected!.runtime_installation!,
        }))
      await sessionsApi.initializeExecution(sessionId, additional_runtimes.length > 0
        ? { selection, runtime, additional_runtimes }
        : { selection, runtime })
      await reload()
      toast.success('Conversation execution context initialized')
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
        })
      } else if (action === 'set_access' && attachmentId && mode) {
        await sessionsApi.mutateExecutionAttachments(sessionId, {
          action: 'set_access', mutation_id: crypto.randomUUID(), attachment_id: attachmentId, access_mode: mode,
        })
      } else if (action === 'revoke' && attachmentId) {
        await sessionsApi.mutateExecutionAttachments(sessionId, {
          action: 'revoke', mutation_id: crypto.randomUUID(), attachment_id: attachmentId,
        })
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
        <div className="flex items-center gap-2 text-sm font-medium"><Shield className="size-4" />Set up this conversation</div>
        <p className="text-xs text-muted-foreground">Choose the Agent, Host, CLI installation, and workspace before the first message. No location will change without your confirmation.</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={busy} onClick={() => void openDraft()}>{busy ? <Loader2 className="mr-1 size-3.5 animate-spin" /> : null}Configure conversation</Button>
          <Link to="/command-center" className="inline-flex items-center text-xs underline">Configure or reconnect Host</Link>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </Card>
    )
  }

  if (loading && !preflight) return <Card className="m-3 p-3 text-xs text-muted-foreground"><Loader2 className="mr-1 inline size-3.5 animate-spin" />Loading execution context…</Card>
  if (!preflight) return <Card className="m-3 space-y-2 p-3 text-xs"><p className="text-destructive">{error ?? 'Execution context unavailable.'}</p><Button size="sm" variant="outline" onClick={() => void reload()}><RefreshCw className="mr-1 size-3.5" />Retry</Button></Card>

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
          <span className="flex-1">Execution context configured</span>
          <ChevronRight className="size-3.5" />
        </button>
      </Card>
    )
  }

  return (
    <Card className="m-3 space-y-3 p-3" data-testid="execution-preflight">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2 text-sm font-medium"><Shield className="size-4" />Execution context</div>
          <p className="text-xs text-muted-foreground">{initialized ? 'Pinned for this Conversation.' : 'Review before the first Run.'}</p>
        </div>
        <div className="flex items-center gap-1">
          {initialized && <Button size="sm" variant="ghost" aria-label="Collapse execution context" aria-expanded="true" onClick={() => setExecutionDetailsOpen(false)}><ChevronDown className="size-3.5" /></Button>}
          <Button size="sm" variant="ghost" aria-label="Refresh execution context" onClick={() => void reload()} disabled={loading || busy}><RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} /></Button>
        </div>
      </div>

      {initialized ? (
        <InitializedSummary summary={summary!} profiles={profiles} participants={participantMembers} />
      ) : (
        <div className="space-y-2">
          <div className="rounded border border-border bg-muted/20 px-2 py-1.5 text-xs">
            <span className="font-medium">Agents</span>
            <div className="mt-1 space-y-1">
              {participantChoices.map(({ member, options, selectedId }) => {
                const usable = options.filter(profile => profile.usable).length
                return <div key={member.agent_id} className="flex items-center justify-between gap-2">
                  <span className="min-w-0 flex-1">{member.agent_name}{member.role === 'manager' ? ' · manager' : ''}</span>
                  <span className={usable === 1 && Boolean(selectedId) ? 'text-muted-foreground' : 'text-destructive'}>
                    {usable === 1 && selectedId ? 'runtime ready' : usable === 0 ? 'runtime unavailable' : 'choose one runtime'}
                  </span>
                </div>
              })}
              {participantChoices.length === 0 && (
                <span className="text-destructive">Project Agent setup is pending; configure a usable backend and retry.</span>
              )}
            </div>
          </div>
          <SelectionField label="Execution Host" value={hostId} onChange={setHostId} options={preflight.available_hosts.map(host => ({ value: host.host_id, label: hostLabel(host) }))} placeholder="Choose a Host" />
          <SelectionField label="Primary workspace (cwd)" value={primaryKey} onChange={setPrimaryKey} options={[
            { value: 'managed', label: 'Managed workspace' },
            ...locations.map(location => ({ value: `location:${location.workspace_location_id}`, label: `${location.folder_name}${location.display_path ? ` · ${location.display_path}` : ''}${location.execution_ready ? '' : ' · not ready'}` })),
          ]} placeholder="Choose managed or a Folder" />
          {/* The fallback said out loud: with no Folder the Agent works in a
              managed workspace on the Host, not in this Project's code, and
              the only place to change that is Files & Code. */}
          {locations.length === 0 && (
            <div className="text-xs text-muted-foreground" data-testid="preflight-no-folder">
              This Project has no Folder connected, so the Agent will work in a managed workspace on the Host.{' '}
              <Link to={`/projects/${projectId}/files?setup=folder`} className="underline">Connect a Folder</Link>
            </div>
          )}
          {participantChoices.map(({ member, options, selectedId }) => (
            <SelectionField
              key={member.agent_id}
              label={member.role === 'manager' ? 'CLI installation' : `CLI installation for ${member.agent_name}`}
              value={selectedId}
              onChange={value => member.role === 'manager'
                ? setRuntimeProfileId(value)
                : setParticipantRuntimeProfileIds(current => ({ ...current, [member.agent_id]: value }))}
              options={options.map(profile => ({ value: runtimeCandidateKey(profile), label: `${profile.agent_name} · ${profile.adapter_type} · ${profile.runtime_installation}${profile.runtime_profile_id ? '' : ' · detected on Host'}` }))}
              placeholder="Choose a CLI installation"
              disabled={!hostId || !selectedPrimary}
            />
          ))}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {selectedHost && <Badge variant={selectedHost.online ? 'success' : 'destructive'}>{selectedHost.online ? 'Host daemon online' : 'Host daemon offline'}</Badge>}
            {selectedHost && !selectedHost.online && <span className="text-muted-foreground">Browser connectivity does not mean the Host daemon is reachable.</span>}
          </div>
          {draftBlockedReason && <p className="text-xs text-destructive">{draftBlockedReason}</p>}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy || draftBlockedReason !== null} onClick={() => void initialize()}>{busy ? <Loader2 className="mr-1 size-3.5 animate-spin" /> : null}Confirm execution context</Button>
            {!manager && <Button size="sm" variant="outline" disabled={busy} onClick={() => void openDraft()}>Retry Agent setup</Button>}
            <Link to="/command-center" className="inline-flex items-center text-xs underline">Configure or reconnect Host</Link>
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
      {onNewConversation && initialized && <Button size="sm" variant="outline" onClick={onNewConversation}>New Conversation with another workspace</Button>}
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
  const host = summary.host
  const primary = summary.primary
  const runtime = summary.runtime
  const pinnedRuntimes = summary.runtimes ?? []
  const runtimes = pinnedRuntimes.length > 0 ? pinnedRuntimes : runtime ? [runtime] : []
  return <div className="space-y-1.5 text-xs">
    <div className="space-y-1">
      <span className="font-medium">Agents / CLI</span>
      {runtimes.length > 0 ? runtimes.map(pinned => (
        <SummaryRow
          key={pinned.agent_id}
          label={participants.find(participant => participant.agent_id === pinned.agent_id)?.agent_name
            ?? profiles.find(profile => profile.runtime_profile_id === pinned.runtime_profile_id)?.agent_name
            ?? 'Unknown Agent'}
          value={`${pinned.adapter_type} · ${pinned.runtime_installation}`}
        />
      )) : <SummaryRow label="Agent / CLI" value="Unavailable" />}
    </div>
    <SummaryRow label="Host" value={host ? `${host.host_name}${host.online ? ' · daemon online' : ' · daemon offline'}` : 'Unavailable'} tone={host?.online === false ? 'danger' : undefined} />
    <SummaryRow label="Primary cwd" value={primary?.display_path ?? (primary?.kind === 'managed' ? 'Managed workspace' : 'Unavailable')} />
    {summary.blocked_reason && <p className="rounded bg-destructive/10 px-2 py-1 text-destructive">{summary.blocked_reason}</p>}
    {host?.online === false && <div className="flex items-center gap-1 text-muted-foreground"><Unplug className="size-3.5" />Host daemon offline; the browser is still online. <Link to="/command-center" className="underline">Reconnect Host</Link></div>}
    {!runtime && <p className="text-muted-foreground">This pinned runtime is unavailable. Start a new Conversation to choose another Host CLI.</p>}
  </div>
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
  const hostId = summary.host?.host_id
  const serverReadOnly = summary.host?.host_kind === 'server'
  const attached = new Set(summary.attachments.filter(item => item.status === 'active').map(item => item.workspace_location_id))
  const candidates = locations.filter(location => {
    if (!location.execution_ready || location.execution_host_id !== hostId || attached.has(location.workspace_location_id)) return false
    return summary.primary?.kind !== 'location' || location.workspace_location_id !== summary.primary.workspace_location_id
  })
  return <div className="space-y-2 border-t border-border pt-2">
      <div className="text-xs font-medium">Attached Folders</div>
    {summary.attachments.length === 0 && <p className="text-xs text-muted-foreground">None. Attachments expand access but never change cwd.</p>}
    {summary.attachments.map(attachment => {
      return <div key={attachment.id} className="flex flex-wrap items-center gap-2 rounded border border-border px-2 py-1 text-xs">
      <span className="min-w-0 flex-1 truncate">{attachment.folder_name}{attachment.display_path ? ` · ${attachment.display_path}` : ''} · {attachment.access_mode}</span>
      {attachment.status === 'active' && <>
        <Button size="sm" variant="ghost" disabled={disabled || serverReadOnly || attachment.access_mode === 'write'} onClick={() => void onMutate('set_access', attachment.id, 'write')}>Grant write</Button>
        <Button size="sm" variant="ghost" disabled={disabled || attachment.access_mode === 'read'} onClick={() => void onMutate('set_access', attachment.id, 'read')}>Read only</Button>
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => void onMutate('revoke', attachment.id)}>Revoke</Button>
      </>}
    </div>
    })}
    {candidates.length > 0 && <div className="flex flex-wrap items-end gap-2">
      <div className="min-w-0 flex-1"><SelectionField label="Folder" value={selectedLocationId} onChange={onLocationChange} options={candidates.map(location => ({ value: location.workspace_location_id, label: `${location.folder_name}${location.display_path ? ` · ${location.display_path}` : ''}` }))} placeholder="Choose a Folder to attach" disabled={disabled} /></div>
      <div className="w-24"><SelectionField label="Access" value={serverReadOnly ? 'read' : mode} onChange={value => onModeChange(value as ConversationAttachmentAccessMode)} options={serverReadOnly ? [{ value: 'read', label: 'Read' }] : [{ value: 'read', label: 'Read' }, { value: 'write', label: 'Write' }]} placeholder="Access" disabled={disabled} /></div>
      <Button size="sm" disabled={disabled || !selectedLocationId} onClick={() => void onMutate('attach')}>Attach</Button>
    </div>}
    {serverReadOnly && <p className="text-xs text-muted-foreground">Server-host attachments are read-only. Direct attached-Folder writes require a trusted remote Host.</p>}
  </div>
}

function SummaryRow({ label, value, tone }: { label: string; value: string; tone?: 'danger' }) {
  return <div className="flex gap-2"><span className="w-24 shrink-0 text-muted-foreground">{label}</span><span className={tone === 'danger' ? 'text-destructive' : ''}>{value}</span></div>
}

function hostLabel(host: ConversationExecutionHostSummary): string {
  return `${host.host_name} · ${host.online ? 'online' : 'offline'}${host.host_kind === 'server' ? ' · server' : ''}`
}

function runtimeCandidateKey(profile: ConversationExecutionRuntimeProfile): string {
  return JSON.stringify([
    profile.runtime_profile_id ?? 'detected',
    profile.agent_id,
    profile.execution_host_id ?? '',
    profile.workspace_mode ?? '',
    profile.workspace_location_id ?? '',
    profile.adapter_type,
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
  if (!input.host) return 'Choose an execution Host.'
  if (!input.host.online) return 'Execution Host is offline; reconnect it before sending.'
  if (input.primary === null) return 'Choose a Primary Folder or managed workspace.'
  if (input.primary.kind === 'location' && (!input.location || !input.location.execution_ready)) return 'Choose a ready Primary Workspace Location.'
  if (input.location && input.location.execution_host_id !== input.host.host_id) return 'Primary Workspace and Host must be on the same execution Host.'
  if (input.primary.kind === 'managed' && !input.host.managed_workspace_available) return 'This Host cannot provide a managed workspace.'
  if (!input.profile) return input.candidateProfileCount > 1 ? 'Choose a CLI installation.' : 'The selected Host reports no usable CLI installation.'
  if (input.participantBlockReason) return input.participantBlockReason
  return null
}
