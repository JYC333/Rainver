import { useEffect, useMemo, useState } from 'react'
import { ExternalLink, Save, Share2, Shield } from 'lucide-react'
import { SpaceLink as Link } from '../core/spaceNav'
import { toast } from 'sonner'
import type { PublicationResourceType } from '@rainver/protocol'
import { contentAccessApi, publicationsApi, spacesApi } from '../api/client'
import { useSpace } from '../contexts/SpaceContext'
import { errMsg } from '../lib/utils'
import type {
  ContentAccessLevel,
  ContentAccessLogEntry,
  ContentAccessPolicy,
  ContentDemotionDisclosure,
  ContentVisibility,
  SpaceMember,
} from '../types/api'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from './ui/dialog'
import { Label } from './ui/label'
import { Skeleton } from './ui/skeleton'

interface ContentAccessControlProps {
  resourceType: string
  resourceId: string
  ownerUserId: string | null
}

const ACCESS_OPTIONS: Array<{ value: ContentAccessLevel; label: string }> = [
  { value: 'full', label: 'Full' },
  { value: 'summary', label: 'Summary' },
]

const PUBLICATION_RESOURCE_TYPES = new Set<string>(['artifact', 'memory', 'space_object', 'task'])

function publicationResourceType(value: string): PublicationResourceType | null {
  return PUBLICATION_RESOURCE_TYPES.has(value) ? value as PublicationResourceType : null
}

export function ContentAccessControl({
  resourceType,
  resourceId,
  ownerUserId,
}: ContentAccessControlProps) {
  const { activeSpaceId, spaces = [], userId = '' } = useSpace()
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [policy, setPolicy] = useState<ContentAccessPolicy | null>(null)
  const [members, setMembers] = useState<SpaceMember[]>([])
  const [visibility, setVisibility] = useState<ContentVisibility>('private')
  const [projectId, setProjectId] = useState<string | null>(null)
  const [accessLevel, setAccessLevel] = useState<ContentAccessLevel>('full')
  const [selectedUsers, setSelectedUsers] = useState<Set<string>>(new Set())
  const [grantLevels, setGrantLevels] = useState<Record<string, ContentAccessLevel>>({})
  const [targetSpaces, setTargetSpaces] = useState<Set<string>>(new Set())
  const [demotionDisclosure, setDemotionDisclosure] = useState<ContentDemotionDisclosure | null>(null)
  const [accessLogs, setAccessLogs] = useState<ContentAccessLogEntry[] | null>(null)

  const activeSpace = spaces.find(space => space.id === activeSpaceId)
  const role = activeSpace?.role
  const oversightMode = activeSpace?.oversight_mode ?? 'none'
  const canManage = ownerUserId === userId || role === 'owner' || role === 'admin'
  const publishableType = publicationResourceType(resourceType)
  const canPublish = ownerUserId === userId && publishableType !== null
  const availableTargets = useMemo(
    () => spaces.filter(space => space.id !== activeSpaceId),
    [spaces, activeSpaceId],
  )

  useEffect(() => {
    if (!open || !activeSpaceId || !canManage) return
    let cancelled = false
    setLoading(true)
    Promise.all([
      contentAccessApi.get(resourceType, resourceId),
      spacesApi.members(activeSpaceId),
    ]).then(([nextPolicy, nextMembers]) => {
      if (cancelled) return
      setPolicy(nextPolicy)
      setMembers(nextMembers)
      setVisibility(nextPolicy.visibility)
      setProjectId(nextPolicy.project_id)
      setAccessLevel(nextPolicy.access_level)
      setSelectedUsers(new Set(nextPolicy.grants.map(grant => grant.user_id)))
      setGrantLevels(Object.fromEntries(nextPolicy.grants.map(grant => [grant.user_id, grant.access_level])))
      setDemotionDisclosure(null)
      setAccessLogs(null)
    }).catch(error => {
      if (!cancelled) toast.error(errMsg(error))
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [open, activeSpaceId, canManage, resourceType, resourceId])

  if (!canManage || !activeSpaceId) return null

  function toggleUser(memberId: string) {
    setSelectedUsers(current => {
      const next = new Set(current)
      if (next.has(memberId)) next.delete(memberId)
      else next.add(memberId)
      return next
    })
    setGrantLevels(current => ({ ...current, [memberId]: current[memberId] ?? 'full' }))
  }

  function toggleTarget(spaceId: string) {
    setTargetSpaces(current => {
      const next = new Set(current)
      if (next.has(spaceId)) next.delete(spaceId)
      else next.add(spaceId)
      return next
    })
  }

  async function savePolicy() {
    setSaving(true)
    try {
      const demoting = policy ? narrowsVisibility(policy.visibility, visibility) : false
      if (demoting && demotionDisclosure?.target_visibility !== visibility) {
        const disclosure = await contentAccessApi.discloseDemotion(
          resourceType,
          resourceId,
          visibility as Exclude<ContentVisibility, 'space_shared'>,
        )
        setDemotionDisclosure(disclosure)
        toast.info('Review the exposure summary before confirming')
        return
      }
      const updated = await contentAccessApi.update(resourceType, resourceId, {
        visibility,
        access_level: accessLevel,
        project_id: projectId,
        grants: visibility === 'selected_users' || visibility === 'space_shared'
          ? [...selectedUsers].map(memberId => ({
            user_id: memberId,
            access_level: grantLevels[memberId] ?? 'full',
          }))
          : [],
        ...(demoting && demotionDisclosure
          ? { demotion_confirmation_id: demotionDisclosure.confirmation_id }
          : {}),
      })
      setPolicy(updated)
      setDemotionDisclosure(null)
      toast.success('Access updated')
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setSaving(false)
    }
  }

  async function loadAccessLogs() {
    try {
      const page = await contentAccessApi.accessLogs(resourceType, resourceId)
      setAccessLogs(page.items)
    } catch (error) {
      toast.error(errMsg(error))
    }
  }

  async function publish() {
    if (targetSpaces.size === 0 || !publishableType) return
    setPublishing(true)
    try {
      await publicationsApi.create({
        resource_type: publishableType,
        resource_id: resourceId,
        target_space_ids: [...targetSpaces],
      })
      setTargetSpaces(new Set())
      toast.success('Snapshot published')
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setPublishing(false)
    }
  }

  const grantableMembers = members.filter(member => member.user_id !== policy?.owner_user_id)
  const invalidPolicy = visibility === 'selected_users' && selectedUsers.size === 0
  const hasProjectScope = Boolean(policy?.project_id)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Shield className="size-3.5" /> Access
        </Button>
      </DialogTrigger>
      <DialogContent aria-describedby={undefined} className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Content access</DialogTitle>
        </DialogHeader>

        {loading || !policy ? (
          <div className="space-y-3">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : (
          <div className="space-y-6">
            <section className="space-y-3">
              <Label>Sharing</Label>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3" role="group" aria-label="Sharing scope">
                <Button type="button" variant={visibility === 'private' ? 'secondary' : 'outline'} onClick={() => setVisibility('private')}>
                  Only me
                </Button>
                <Button type="button" disabled={!hasProjectScope} variant={visibility === 'space_shared' && projectId !== null ? 'secondary' : 'outline'} onClick={() => { setVisibility('space_shared'); setProjectId(policy?.project_id ?? null) }}>
                  In this project
                </Button>
                <Button type="button" variant={visibility === 'space_shared' && projectId === null ? 'secondary' : 'outline'} onClick={() => { setVisibility('space_shared'); setProjectId(null) }}>
                  Whole Space
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Creation context determines Project scope. Publishing to the whole Space is an explicit boundary change.
              </p>
              {oversightMode !== 'none' && visibility !== 'space_shared' && (
                <p className="text-xs text-muted-foreground">
                  Space admins can view this content (oversight: {oversightMode}).
                </p>
              )}
            </section>

            <section className="space-y-2">
              <Label>Explicit share</Label>
              <Button type="button" variant={visibility === 'selected_users' ? 'secondary' : 'outline'} onClick={() => setVisibility('selected_users')}>
                Selected people
              </Button>
            </section>

            {ownerUserId === userId && (
              <section className="space-y-3 border-t border-border pt-5">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <Label>Cross-person access history</Label>
                    <p className="mt-1 text-xs text-muted-foreground">Only reads by another person are recorded. This history is visible only to you.</p>
                  </div>
                  <Button type="button" size="sm" variant="outline" onClick={() => void loadAccessLogs()}>Load</Button>
                </div>
                {accessLogs && (
                  <div className="space-y-2 rounded-md border border-border p-3">
                    {accessLogs.length === 0 && <p className="text-sm text-muted-foreground">No cross-person reads recorded.</p>}
                    {accessLogs.map(log => (
                      <div key={log.id} className="flex flex-wrap justify-between gap-2 text-sm">
                        <span>{log.viewer_display_name} · {log.access_type}</span>
                        <span className="text-xs text-muted-foreground">{new Date(log.accessed_at).toLocaleString()}</span>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )}

            {demotionDisclosure && demotionDisclosure.target_visibility === visibility && (
              <section className="space-y-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-4">
                <div>
                  <Label>Exposure cannot be retracted</Label>
                  <p className="mt-1 text-xs text-muted-foreground">Making this content private only changes future access. Review everything that may retain information from it.</p>
                </div>
                <ExposureList title="Readers" empty="No cross-person reads recorded." items={demotionDisclosure.exposure.readers.map(reader => ({
                  key: reader.user_id,
                  label: `${reader.display_name} (${reader.access_count} read${reader.access_count === 1 ? '' : 's'})`,
                  link: reader.link,
                }))} />
                <ExposureList title="Runs that consumed it" empty="No consuming Runs recorded." items={demotionDisclosure.exposure.consuming_runs.map(run => ({
                  key: run.run_id,
                  label: `${run.title} (${run.status})`,
                  link: run.link,
                }))} />
                <ExposureList title="Derived outputs still shared" empty="No shared derived outputs found." items={demotionDisclosure.exposure.shared_derived_outputs.map(output => ({
                  key: `${output.resource_type}:${output.id}`,
                  label: `${output.title} (${output.visibility})`,
                  link: output.link,
                }))} />
              </section>
            )}

            <section className="space-y-3">
              <Label>Disclosure</Label>
              <div className="inline-grid grid-cols-2 gap-2" role="group" aria-label="Disclosure level">
                {ACCESS_OPTIONS.map(option => (
                  <Button
                    key={option.value}
                    type="button"
                    variant={accessLevel === option.value ? 'secondary' : 'outline'}
                    onClick={() => setAccessLevel(option.value)}
                  >
                    {option.label}
                  </Button>
                ))}
              </div>
            </section>

            <section className="space-y-2">
              <Label>Scope</Label>
              <div className="flex flex-wrap gap-2">
                <Badge variant="outline">Space</Badge>
                {policy.project_folder_id && <Badge variant="outline">Project Folder {policy.project_folder_id}</Badge>}
                {policy.project_id && <Badge variant="outline">Project {policy.project_id}</Badge>}
              </div>
            </section>

            {(visibility === 'selected_users' || (visibility === 'space_shared' && accessLevel === 'summary')) && (
              <section className="space-y-2">
                <Label>Members</Label>
                {visibility === 'space_shared' && (
                  <p className="text-xs text-muted-foreground">
                    Disclosure upgrades — everyone sees summary; grant full to specific members below.
                  </p>
                )}
                <div className="max-h-56 divide-y divide-border overflow-y-auto border border-border rounded-md">
                  {grantableMembers.map(member => {
                    const selected = selectedUsers.has(member.user_id)
                    return (
                      <div key={member.user_id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                        <label className="flex min-w-0 flex-1 items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={selected}
                            onChange={() => toggleUser(member.user_id)}
                            className="size-4"
                          />
                          <span className="truncate">{member.display_name || member.email}</span>
                        </label>
                        {selected && (
                          <div className="flex gap-1" role="group" aria-label={`${member.display_name} access level`}>
                            {ACCESS_OPTIONS.map(option => (
                              <Button
                                key={option.value}
                                type="button"
                                size="sm"
                                variant={(grantLevels[member.user_id] ?? 'full') === option.value ? 'secondary' : 'ghost'}
                                onClick={() => setGrantLevels(current => ({ ...current, [member.user_id]: option.value }))}
                              >
                                {option.label}
                              </Button>
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })}
                  {grantableMembers.length === 0 && (
                    <p className="px-3 py-4 text-sm text-muted-foreground">No other active members.</p>
                  )}
                </div>
              </section>
            )}

            {canPublish && (
              <section className="space-y-3 border-t border-border pt-5">
                <Label>Publish snapshot to</Label>
                <div className="grid gap-2 sm:grid-cols-2">
                  {availableTargets.map(space => (
                    <label key={space.id} className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
                      <input
                        type="checkbox"
                        checked={targetSpaces.has(space.id)}
                        onChange={() => toggleTarget(space.id)}
                        className="size-4"
                      />
                      <span className="truncate">{space.name}</span>
                    </label>
                  ))}
                  {availableTargets.length === 0 && (
                    <p className="text-sm text-muted-foreground">No other member spaces.</p>
                  )}
                </div>
                <Button type="button" variant="outline" disabled={publishing || targetSpaces.size === 0} onClick={publish}>
                  <Share2 className="size-4" />{publishing ? 'Publishing...' : 'Publish snapshot'}
                </Button>
              </section>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>Close</Button>
          <Button disabled={loading || !policy || saving || invalidPolicy} onClick={savePolicy}>
            <Save className="size-4" />{saving ? 'Saving...' : demotionDisclosure?.target_visibility === visibility ? 'Confirm demotion' : 'Save access'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ExposureList({ title, empty, items }: {
  title: string
  empty: string
  items: Array<{ key: string; label: string; link: string }>
}) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium">{title}</p>
      {items.length === 0 ? <p className="text-xs text-muted-foreground">{empty}</p> : items.map(item => (
        <Link key={item.key} to={item.link} className="flex items-center gap-1 text-xs text-accent-foreground hover:underline">
          {item.label}<ExternalLink className="size-3" />
        </Link>
      ))}
    </div>
  )
}

function narrowsVisibility(current: ContentVisibility, requested: ContentVisibility) {
  const rank: Record<ContentVisibility, number> = { private: 0, selected_users: 1, space_shared: 2 }
  return rank[requested] < rank[current]
}
