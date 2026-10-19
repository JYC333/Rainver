import { useCallback, useEffect, useMemo, useState } from 'react'
import { Eye, History, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { personalMemoryGrantsApi } from '../../api/client'
import { errMsg } from '../../lib/utils'
import type {
  PersonalMemoryGrantAuditResponse,
  PersonalMemoryGrantPreviewResponse,
  PersonalMemoryGrantResponse,
  PersonalMemoryGrantSafeMemoryFilter,
  Run,
  SpaceWithMembership,
} from '../../types/api'
import { Badge, StatusBadge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Card } from '../../components/ui/card'
import {
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { Skeleton } from '../../components/ui/skeleton'

function fmt(dt: string | null | undefined) {
  return dt ? new Date(dt).toLocaleString() : '-'
}

function clampInt(value: string, fallback: number, min: number, max: number) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

function buildSafeMemoryFilter(maxItems: number): PersonalMemoryGrantSafeMemoryFilter {
  return { max_items: Math.max(1, Math.min(50, Math.trunc(maxItems))) }
}

function safeMetadataValue(meta: Record<string, unknown> | null | undefined, key: string): string {
  if (!meta || !(key in meta)) return '-'
  const value = meta[key]
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  return '-'
}

function safeMetadataBoolean(meta: Record<string, unknown> | null | undefined, key: string): string {
  if (!meta || !(key in meta)) return 'false'
  return meta[key] === true ? 'true' : 'false'
}

function latestGrantForRun(grants: PersonalMemoryGrantResponse[], runId: string) {
  return grants
    .filter(g => g.target_run_id === runId)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0] ?? null
}

interface PersonalContextPanelProps {
  run: Run
  currentUserId: string
  personalSpaceId: string | null
  spaces: SpaceWithMembership[]
}

export function PersonalContextPanel({ run, currentUserId, personalSpaceId, spaces }: PersonalContextPanelProps) {
  const [grants, setGrants] = useState<PersonalMemoryGrantResponse[]>([])
  const [loading, setLoading] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [creating, setCreating] = useState(false)
  const [revoking, setRevoking] = useState(false)
  const [preview, setPreview] = useState<PersonalMemoryGrantPreviewResponse | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [auditOpen, setAuditOpen] = useState(false)
  const [auditLoading, setAuditLoading] = useState(false)
  const [audit, setAudit] = useState<PersonalMemoryGrantAuditResponse | null>(null)
  const [revokeOpen, setRevokeOpen] = useState(false)
  const [maxItems, setMaxItems] = useState('20')
  const [expiresSeconds, setExpiresSeconds] = useState('3600')

  const executionSpace = spaces.find(s => s.id === run.space_id) ?? null
  const targetSpaceName = executionSpace?.name ?? run.space_id
  const isPersonalRun = Boolean(personalSpaceId && run.space_id === personalSpaceId) || executionSpace?.type === 'personal'
  const isInstructingUser = Boolean(run.instructed_by_user_id && run.instructed_by_user_id === currentUserId)
  const grant = useMemo(() => latestGrantForRun(grants, run.id), [grants, run.id])
  const canRevoke = Boolean(grant && grant.granting_user_id === currentUserId && ['active', 'consuming'].includes(grant.status))

  const loadGrants = useCallback(async () => {
    if (!run.id || !run.space_id) return
    setLoading(true)
    try {
      const list = await personalMemoryGrantsApi.listPersonalMemoryGrants({ target_space_id: run.space_id })
      setGrants(list.filter(g => g.target_run_id === run.id))
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setLoading(false)
    }
  }, [run.id, run.space_id])

  useEffect(() => {
    void loadGrants()
  }, [loadGrants])

  async function previewGrant() {
    setPreviewing(true)
    setPreview(null)
    setPreviewError(null)
    try {
      const safeMaxItems = clampInt(maxItems, 20, 1, 50)
      const safeExpires = clampInt(expiresSeconds, 3600, 60, 86400)
      setMaxItems(String(safeMaxItems))
      setExpiresSeconds(String(safeExpires))
      const result = await personalMemoryGrantsApi.previewPersonalMemoryGrant({
        target_space_id: run.space_id,
        target_run_id: run.id,
        access_mode: 'summary_only',
        read_expires_in_seconds: safeExpires,
        memory_filter: buildSafeMemoryFilter(safeMaxItems),
      })
      setPreview(result)
    } catch (e) {
      setPreviewError(errMsg(e))
    } finally {
      setPreviewing(false)
    }
  }

  /** A preview answers one set of parameters; editing them withdraws it, so Allow never acts on parameters nobody previewed. */
  function changeParameter(set: (value: string) => void, value: string) {
    set(value)
    setPreview(null)
  }

  async function createGrant() {
    if (!preview?.eligible) return
    setCreating(true)
    try {
      const safeMaxItems = clampInt(maxItems, 20, 1, 50)
      const safeExpires = clampInt(expiresSeconds, 3600, 60, 86400)
      await personalMemoryGrantsApi.createPersonalMemoryGrant({
        target_space_id: run.space_id,
        target_run_id: run.id,
        access_mode: 'summary_only',
        read_expires_in_seconds: safeExpires,
        memory_filter: buildSafeMemoryFilter(safeMaxItems),
      })
      toast.success('Personal context access is active for this run')
      setPreview(null)
      await loadGrants()
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setCreating(false)
    }
  }

  async function revokeGrant() {
    if (!grant) return
    setRevoking(true)
    try {
      await personalMemoryGrantsApi.revokePersonalMemoryGrant(grant.id)
      toast.success('Personal context access revoked')
      await loadGrants()
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setRevoking(false)
    }
  }

  async function openAudit() {
    if (!grant) return
    setAuditOpen(true)
    setAuditLoading(true)
    try {
      setAudit(await personalMemoryGrantsApi.getPersonalMemoryGrantAudit(grant.id))
    } catch (e) {
      toast.error(errMsg(e))
      setAudit(null)
    } finally {
      setAuditLoading(false)
    }
  }

  return (
    <Card className="p-4 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <ShieldCheck className="size-4 text-accent-foreground" />
            Personal context
          </h2>
          <p className="text-xs text-muted-foreground mt-1">
            Personal context can be used for reasoning only. Separate approval is required before anything is written to the shared space.
          </p>
        </div>
        {grant && <StatusBadge status={grant.status} />}
      </div>

      {!run.id ? (
        <p className="text-sm text-muted-foreground">Create the run first before attaching personal context.</p>
      ) : isPersonalRun ? (
        <p className="text-sm text-muted-foreground">Personal context grants are only needed for shared-space runs.</p>
      ) : loading ? (
        <Skeleton className="h-24 w-full" />
      ) : grant ? (
        <div className="space-y-3">
          <div className="grid gap-2 text-sm sm:grid-cols-2">
            <p><span className="text-muted-foreground">Access mode</span><br /><span>{grant.access_mode}</span></p>
            <p><span className="text-muted-foreground">Read expires</span><br /><span>{fmt(grant.read_expires_at)}</span></p>
            <p><span className="text-muted-foreground">Target space</span><br /><span>{targetSpaceName}</span></p>
            <p><span className="text-muted-foreground">Target run</span><br /><span className="font-mono text-xs">{grant.target_run_id}</span></p>
            <p><span className="text-muted-foreground">Grant id</span><br /><span className="font-mono text-xs">{grant.id}</span></p>
            <p><span className="text-muted-foreground">Created</span><br /><span>{fmt(grant.created_at)}</span></p>
            {grant.revoked_at && <p><span className="text-muted-foreground">Revoked</span><br /><span>{fmt(grant.revoked_at)}</span></p>}
            {grant.used_at && <p><span className="text-muted-foreground">Used</span><br /><span>{fmt(grant.used_at)}</span></p>}
          </div>
          <div className="flex flex-wrap gap-2">
            {canRevoke && (
              <Button type="button" size="sm" variant="destructive" disabled={revoking} onClick={() => setRevokeOpen(true)}>
                Revoke personal context access
              </Button>
            )}
            <Button type="button" size="sm" variant="outline" onClick={openAudit}>
              <History className="size-3.5" />
              View audit
            </Button>
          </div>
        </div>
      ) : !isInstructingUser ? (
        <p className="text-sm text-muted-foreground">Only the user who instructed this run can attach their personal context.</p>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            This lets this run use a limited personal-memory summary for reasoning only. It will not share raw personal memory with this space.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label className="text-xs">Max items</Label>
              <Input
                type="number"
                min={1}
                max={50}
                value={maxItems}
                onChange={e => changeParameter(setMaxItems, e.target.value)}
              />
            </div>
            <div>
              <Label className="text-xs">Read expiry seconds</Label>
              <Input
                type="number"
                min={60}
                max={86400}
                value={expiresSeconds}
                onChange={e => changeParameter(setExpiresSeconds, e.target.value)}
              />
            </div>
          </div>
          <Button type="button" variant="secondary" disabled={previewing} onClick={previewGrant}>
            <Eye className="size-4" />
            {previewing ? 'Previewing...' : 'Preview personal context attachment'}
          </Button>
          {previewError && (
            <div className="rounded-md border border-destructive/25 bg-destructive/5 p-3 text-sm text-destructive">
              {previewError}
            </div>
          )}
          {preview && (
            <div className="rounded-md border border-border bg-muted/20 p-3 space-y-3">
              <p className="text-xs text-muted-foreground">
                This preview does not show raw personal memory. The run will receive only a limited reasoning summary.
              </p>
              <div className="flex flex-wrap gap-1.5 items-center">
                <Badge variant={preview.eligible ? 'success' : 'destructive'}>
                  {preview.eligible ? 'eligible' : 'not eligible'}
                </Badge>
                <Badge variant="secondary">{preview.access_mode}</Badge>
              </div>
              <div className="grid gap-2 text-sm sm:grid-cols-2">
                <p><span className="text-muted-foreground">Target space</span><br /><span>{targetSpaceName}</span></p>
                <p><span className="text-muted-foreground">Target run</span><br /><span className="font-mono text-xs">{preview.target_run_id}</span></p>
                <p><span className="text-muted-foreground">Read expiry</span><br /><span>{fmt(preview.proposed_read_expires_at)}</span></p>
                <p><span className="text-muted-foreground">Max items</span><br /><span>{preview.max_items ?? maxItems}</span></p>
                <p className="sm:col-span-2">
                  <span className="text-muted-foreground">Excluded sensitivity levels</span><br />
                  <span>{preview.excluded_sensitivity_levels.join(', ') || '-'}</span>
                </p>
              </div>
              {preview.warnings.length > 0 && (
                <div className="text-xs text-warning space-y-1">
                  {preview.warnings.map(w => <p key={w}>{w}</p>)}
                </div>
              )}
              <div className="rounded-md border border-warning/25 bg-warning/5 p-3 text-xs text-muted-foreground">
                This allows this run to use a limited personal-memory summary for reasoning only. It does not share raw personal memory with the target space. Any attempt to persist grant-derived output into the shared space requires separate egress approval.
              </div>
              <Button type="button" disabled={!preview.eligible || creating} onClick={createGrant}>
                {creating ? 'Allowing...' : 'Allow personal context for this run'}
              </Button>
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={revokeOpen}
        onOpenChange={setRevokeOpen}
        title="Revoke personal context access"
        description="Revoking stops future use of this grant. It does not delete the run."
        confirmLabel="Revoke personal context access"
        onConfirm={revokeGrant}
      />

      <Dialog open={auditOpen} onOpenChange={setAuditOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Personal context audit</DialogTitle>
            <DialogDescription>
              Audit entries show grant lifecycle metadata only. Raw memory and generated summaries are not displayed.
            </DialogDescription>
          </DialogHeader>
          {auditLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : !audit ? (
            <p className="text-sm text-muted-foreground">No audit events loaded.</p>
          ) : (
            <div className="max-h-[420px] overflow-y-auto space-y-3 pr-1">
              {audit.events.length === 0 ? (
                <p className="text-sm text-muted-foreground">No audit events.</p>
              ) : audit.events.map(event => (
                <div key={event.id} className="rounded-md border border-border p-3 space-y-2">
                  <div className="flex flex-wrap gap-2 items-center justify-between">
                    <Badge variant="secondary">{event.event_type}</Badge>
                    <span className="text-xs text-muted-foreground">{fmt(event.created_at)}</span>
                  </div>
                  <div className="grid gap-2 text-xs sm:grid-cols-2">
                    <p><span className="text-muted-foreground">target_space_id</span><br />{audit.grant.target_space_id}</p>
                    <p><span className="text-muted-foreground">run_id</span><br />{event.run_id ?? audit.grant.target_run_id}</p>
                    <p><span className="text-muted-foreground">reason</span><br />{safeMetadataValue(event.metadata_json, 'reason')}</p>
                    <p><span className="text-muted-foreground">raw_private_memory_included</span><br />{safeMetadataBoolean(event.metadata_json, 'raw_private_memory_included')}</p>
                    <p><span className="text-muted-foreground">personal_summary_persisted</span><br />{safeMetadataBoolean(event.metadata_json, 'personal_summary_persisted')}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setAuditOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
