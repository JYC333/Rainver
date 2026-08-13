import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { SpaceLink as Link } from '../../core/spaceNav'
import { ArrowLeft } from 'lucide-react'
import { toast } from 'sonner'
import { activityApi } from '../../api/client'
import { useSpace } from '../../contexts/SpaceContext'
import { errMsg, isNotFoundError } from '../../lib/utils'
import type { ActivityInboxRecord, Proposal } from '../../types/api'
import { Card } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { Badge } from '../../components/ui/badge'
import { CaptureRelocationDialog } from '../../components/CaptureRelocationDialog'
import { Skeleton } from '../../components/ui/skeleton'
import { EmptyState } from '../../components/ui/empty-state'
import { ContentAccessControl } from '../../components/ContentAccessControl'

function fmt(dt: string) {
  return new Date(dt).toLocaleString()
}

export default function ActivityDetailPage() {
  const { activityId = '' } = useParams()
  const { activeSpaceId, activeSpaceName } = useSpace()
  const [row, setRow] = useState<ActivityInboxRecord | null>(null)
  const [loading, setLoading] = useState(true)
  const [consolidating, setConsolidating] = useState(false)
  const [generatedProposals, setGeneratedProposals] = useState<Proposal[] | null>(null)
  const [relocating, setRelocating] = useState(false)

  const load = useCallback(async () => {
    if (!activityId) return
    if (!activeSpaceId) {
      setRow(null)
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      setRow(await activityApi.get(activityId))
    } catch (e) {
      if (!isNotFoundError(e)) toast.error(errMsg(e))
      setRow(null)
    } finally {
      setLoading(false)
    }
  }, [activityId, activeSpaceId])

  useEffect(() => { void load() }, [load])

  async function doConsolidate() {
    if (!activityId) return
    setConsolidating(true)
    setGeneratedProposals(null)
    try {
      const proposals = await activityApi.consolidate(activityId)
      setGeneratedProposals(proposals)
      if (proposals.length > 0) {
        toast.success(`${proposals.length} proposal${proposals.length === 1 ? '' : 's'} generated`)
        // Refresh the record so its status updates to proposals_generated
        const updated = await activityApi.get(activityId).catch(() => null)
        if (updated) setRow(updated)
      } else {
        toast.info('No proposals could be generated from this activity.')
      }
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setConsolidating(false)
    }
  }

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      <Button variant="ghost" size="sm" asChild>
        <Link to="/activity"><ArrowLeft className="size-4 mr-1" />Activity Inbox</Link>
      </Button>

      {loading && <Skeleton className="h-40 w-full" />}

      {!loading && !row && (
        <EmptyState
          title={activeSpaceId ? 'Activity not found or not accessible' : 'No space selected'}
          description={activeSpaceId
            ? 'This activity may not exist, or it may not be visible in your current space.'
            : 'Select an operational space to inspect this activity.'}
          action={
            <Button variant="ghost" asChild>
              <Link to="/activity">Back to Activity Inbox</Link>
            </Button>
          }
        />
      )}

      {!loading && row && (
        <>
        <Card className="p-5 space-y-4">
          <div className="flex flex-wrap justify-between gap-2">
            <h1 className="text-lg font-semibold tracking-tight">{row.title ?? row.source_type}</h1>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">{fmt(row.created_at)}</span>
              <ContentAccessControl resourceType="activity" resourceId={row.id} ownerUserId={row.owner_user_id ?? row.user_id} />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">Viewing: {activeSpaceName ?? activeSpaceId ?? 'No operational space selected'}</p>
          <div className="flex flex-wrap gap-1.5 items-center">
            <Badge variant="secondary">{row.source_type.replace('_', ' ')}</Badge>
            <Badge variant="outline">{row.status.replace('_', ' ')}</Badge>
            {row.source_run_id && (
              <Link to={`/runs/${row.source_run_id}`} className="text-xs text-accent-foreground hover:underline">
                Open run
              </Link>
            )}
          </div>
          <p className="text-sm whitespace-pre-wrap">{row.content}</p>
          {row.metadata_json && Object.keys(row.metadata_json).length > 0 && (
            <pre className="text-xs bg-muted/50 rounded-md p-3 overflow-auto max-h-64">
              {JSON.stringify(row.metadata_json, null, 2)}
            </pre>
          )}
          {/* Only a capture that was projected into a note has an anchor to
              relocate by; anything else has nothing to extract. */}
          {Boolean((row.metadata_json as { marginalia?: { block_id?: string } } | null)?.marginalia?.block_id) && (
            <div className="pt-2 border-t border-border">
              <Button size="sm" variant="outline" onClick={() => setRelocating(true)}>
                Relocate…
              </Button>
              <p className="text-xs text-muted-foreground mt-1">
                Send this capture somewhere else — or promote it from your private notes to the
                project's material.
              </p>
              <CaptureRelocationDialog
                activityId={row.id}
                projectId={row.project_id ?? null}
                open={relocating}
                onOpenChange={setRelocating}
                onRelocated={load}
              />
            </div>
          )}
          {(row.status === 'raw' || row.status === 'processed') && (
            <div className="pt-2 border-t border-border">
              <Button
                size="sm"
                variant="secondary"
                disabled={consolidating}
                onClick={doConsolidate}
              >
                {consolidating ? 'Generating…' : 'Generate proposals'}
              </Button>
              <p className="text-xs text-muted-foreground mt-1">
                Analyse this activity and create memory proposals for review.
              </p>
            </div>
          )}
        </Card>

        {generatedProposals !== null && (
          generatedProposals.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No proposals were generated. The content may be too sparse or already captured in memory.
            </p>
          ) : (
            <div className="space-y-2">
              <p className="text-sm font-medium">Generated proposals</p>
              {generatedProposals.map(p => (
                <div key={p.id} className="flex items-center gap-2 text-sm">
                  <Badge variant="secondary" className="shrink-0">{p.proposal_type}</Badge>
                  <Link to={`/proposals/${p.id}`} className="text-accent-foreground hover:underline truncate">
                    {p.proposed_title}
                  </Link>
                </div>
              ))}
              <Link
                to="/proposals?status=pending"
                className="text-xs text-accent-foreground hover:underline block mt-1"
              >
                View all pending proposals →
              </Link>
            </div>
          )
        )}
        </>
      )}
    </div>
  )
}
