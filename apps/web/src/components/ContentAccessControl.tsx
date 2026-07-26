import { useEffect, useMemo, useState } from 'react'
import { Save, Share2, Shield } from 'lucide-react'
import { toast } from 'sonner'
import type { PublicationResourceType } from '@agent-space/protocol'
import { contentAccessApi, publicationsApi, spacesApi } from '../api/client'
import { useSpace } from '../contexts/SpaceContext'
import { errMsg } from '../lib/utils'
import type {
  ContentAccessLevel,
  ContentAccessPolicy,
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

const VISIBILITY_OPTIONS: Array<{ value: ContentVisibility; label: string }> = [
  { value: 'private', label: 'Private' },
  { value: 'space_shared', label: 'Space members' },
  { value: 'selected_users', label: 'Selected members' },
]

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
  const [accessLevel, setAccessLevel] = useState<ContentAccessLevel>('full')
  const [selectedUsers, setSelectedUsers] = useState<Set<string>>(new Set())
  const [grantLevels, setGrantLevels] = useState<Record<string, ContentAccessLevel>>({})
  const [targetSpaces, setTargetSpaces] = useState<Set<string>>(new Set())

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
      setAccessLevel(nextPolicy.access_level)
      setSelectedUsers(new Set(nextPolicy.grants.map(grant => grant.user_id)))
      setGrantLevels(Object.fromEntries(nextPolicy.grants.map(grant => [grant.user_id, grant.access_level])))
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
      const updated = await contentAccessApi.update(resourceType, resourceId, {
        visibility,
        access_level: accessLevel,
        grants: visibility === 'selected_users' || visibility === 'space_shared'
          ? [...selectedUsers].map(memberId => ({
            user_id: memberId,
            access_level: grantLevels[memberId] ?? 'full',
          }))
          : [],
      })
      setPolicy(updated)
      toast.success('Access updated')
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setSaving(false)
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
              <Label>Visibility</Label>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3" role="group" aria-label="Visibility">
                {VISIBILITY_OPTIONS.map(option => (
                  <Button
                    key={option.value}
                    type="button"
                    variant={visibility === option.value ? 'secondary' : 'outline'}
                    onClick={() => setVisibility(option.value)}
                  >
                    {option.label}
                  </Button>
                ))}
              </div>
              {oversightMode !== 'none' && visibility !== 'space_shared' && (
                <p className="text-xs text-muted-foreground">
                  Space admins can view this content (oversight: {oversightMode}).
                </p>
              )}
            </section>

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
            <Save className="size-4" />{saving ? 'Saving...' : 'Save access'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
