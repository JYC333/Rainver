import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Plus, RefreshCw } from 'lucide-react'
import { roomsApi } from '../../api/client'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { Input } from '../../components/ui/input'
import { SpaceLink as Link } from '../../core/spaceNav'
import { useAppTranslation } from '../../i18n'
import type { RoomAgentPreset } from '@rainver/protocol'
import type { RoomAgentCandidate } from '../../types/api'
import HostExecutionTargetPicker, { type HostExecutionSelection } from '../command_center/HostExecutionTargetPicker'
import { PAGE_SIZE, usePagedSearch } from '../projects/agents/usePagedSearch'

/**
 * Add an Agent to one Room.
 *
 * The server lists the Project's own Agents first; anything below them comes
 * from the person's library and joining the Room also adds it to the Project's
 * Agents. A private Agent is shared only with this Room's current members, and
 * only after the confirmation the caller asks for.
 */
export function AddRoomAgentDialog({
  open, roomId, projectId, busy, createHref, presetExecution, onPresetExecutionChange, onClose, onAdd, onAddPreset,
}: {
  open: boolean
  roomId: string
  projectId: string
  busy: boolean
  createHref: string
  presetExecution: HostExecutionSelection | null
  onPresetExecutionChange: (value: HostExecutionSelection | null) => void
  onClose: () => void
  onAdd: (candidate: RoomAgentCandidate) => Promise<void>
  onAddPreset: (presetId: string) => Promise<void>
}) {
  const { t } = useAppTranslation()
  // Server-defined factories, the same on every page of this Room's candidates.
  const [presets, setPresets] = useState<RoomAgentPreset[]>([])
  const currentRoom = useRef(roomId)
  currentRoom.current = roomId
  useEffect(() => { setPresets([]) }, [roomId])
  const search = usePagedSearch<RoomAgentCandidate>(open, async (q, offset) => {
    const page = await roomsApi.agentCandidates(roomId, { q: q || undefined, limit: PAGE_SIZE, offset })
    // Another Room's late answer never names this Room's factories.
    if (currentRoom.current === roomId) setPresets(page.presets)
    return { items: page.agents, total: page.total }
  }, roomId)
  const addable = useMemo(() => search.items.filter(candidate => !candidate.in_room || candidate.member_status === 'removed'), [search.items])
  const inProject = addable.filter(candidate => candidate.in_project)
  const fromLibrary = addable.filter(candidate => !candidate.in_project)

  const row = (candidate: RoomAgentCandidate) => (
    <div key={candidate.agent_id} className="flex items-center justify-between gap-3 rounded-md border border-border p-2.5">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">{candidate.name}</span>
          {candidate.private && <Badge variant="outline">{t('collab_ui.roster.private_share')}</Badge>}
        </div>
        {!candidate.in_project && <p className="text-xs text-muted-foreground">{t('collab_ui.roster.adds_to_project')}</p>}
      </div>
      <Button size="sm" className="shrink-0" disabled={busy} onClick={() => void onAdd(candidate)}>{t('collab_ui.roster.add')}</Button>
    </div>
  )

  return (
    <Dialog open={open} onOpenChange={next => { if (!next) onClose() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('collab_ui.roster.add_agent_title')}</DialogTitle>
          <DialogDescription>{t('collab_ui.roster.add_agent_description')}</DialogDescription>
        </DialogHeader>
        <Input
          aria-label={t('collab_ui.roster.search')}
          placeholder={t('collab_ui.roster.search')}
          value={search.query}
          onChange={event => search.setQuery(event.target.value)}
        />
        <div className="mt-1 max-h-[45vh] min-h-[6rem] space-y-3 overflow-y-auto pt-2" aria-busy={search.loading}>
          {search.failed && search.items.length === 0 ? (
            <div className="flex items-center justify-between gap-2 rounded-md border border-border p-3 text-sm text-muted-foreground">
              <span>{t('collab_ui.roster.candidates_failed')}</span>
              <Button size="sm" variant="outline" onClick={() => void search.reload()}><RefreshCw className="size-3.5" />{t('collab_ui.common.retry')}</Button>
            </div>
          ) : search.loading && search.items.length === 0 ? (
            <p className="flex items-center gap-2 p-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t('collab_ui.common.loading')}</p>
          ) : addable.length === 0 ? (
            <p className="p-2 text-sm text-muted-foreground">
              {search.query.trim() ? t('collab_ui.roster.no_match', { q: search.query.trim() }) : t('collab_ui.roster.no_candidates')}
            </p>
          ) : (
            <>
              {inProject.length > 0 && (
                <section className="space-y-1.5">
                  <h3 className="text-xs font-medium text-muted-foreground">{t('collab_ui.roster.in_project')}</h3>
                  {inProject.map(row)}
                </section>
              )}
              {fromLibrary.length > 0 && (
                <section className="space-y-1.5">
                  <h3 className="text-xs font-medium text-muted-foreground">{t('collab_ui.roster.from_library')}</h3>
                  {fromLibrary.map(row)}
                </section>
              )}
            </>
          )}
          {search.hasMore && (
            <Button size="sm" variant="ghost" className="w-full" disabled={search.loading} onClick={() => void search.loadMore()}>
              {search.loading ? <Loader2 className="size-3.5 animate-spin" /> : null}{t('collab_ui.common.load_more')}
            </Button>
          )}
        </div>
        {presets.length > 0 && (
          <details className="rounded-md border border-border p-2.5">
            <summary className="cursor-pointer text-xs font-medium">{t('collab_ui.roster.presets')}</summary>
            <div className="mt-2 space-y-2">
              <p className="text-xs text-muted-foreground">{t('collab_ui.roster.preset_hint')}</p>
              <HostExecutionTargetPicker projectId={projectId} value={presetExecution} onChange={onPresetExecutionChange} optionalDefaultFolder disabled={busy} />
              <p className="text-xs text-muted-foreground">
                {presetExecution?.workspace_mode === 'location'
                  ? t('collab_ui.roster.preset_host_location')
                  : presetExecution?.workspace_mode === 'managed'
                    ? t('collab_ui.roster.preset_host_managed')
                    : t('collab_ui.roster.preset_default')}
              </p>
              {presets.map(preset => (
                <Button key={preset.preset_id} variant="outline" size="sm" className="w-full justify-start" disabled={busy} title={preset.description} onClick={() => void onAddPreset(preset.preset_id)}>
                  {preset.name}
                </Button>
              ))}
            </div>
          </details>
        )}
        <div className="flex justify-between gap-2 border-t border-border pt-3">
          <Button asChild size="sm" variant="ghost">
            <Link to={createHref}><Plus className="size-3.5" />{t('collab_ui.roster.create_new')}</Link>
          </Button>
          <Button size="sm" variant="outline" onClick={onClose}>{t('collab_ui.common.close')}</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
