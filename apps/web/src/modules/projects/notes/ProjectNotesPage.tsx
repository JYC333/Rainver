import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useParams } from 'react-router-dom'
import { notesCollectionsApi, providersApi, type ModelProviderOut } from '../../../api/client'
import { useSpace } from '../../../contexts/SpaceContext'
import { EmptyState } from '../../../components/ui/empty-state'
import { Skeleton } from '../../../components/ui/skeleton'
import { errMsg } from '../../../lib/utils'
import NotesPage from '../../knowledge/NotesPage'
import type { NotesSurfaceScope } from '../../knowledge/notesPageModel'
import { NotebookChatPanel } from './NotebookChatPanel'
import { ThreadOriginBar } from '../inquiryArea/ThreadOriginBar'

/**
 * The Project's notes (U1). Notes are a Project-level surface, reachable from
 * every Area — doing an experiment, weighing a decision or finishing a Task,
 * there is somewhere in the Project to write it down.
 *
 * It is the *same* page as `/knowledge/notes`, hoisted to the Project's folder
 * (U3). Not a second implementation: the Project's previous notebook was a
 * weaker copy of the note editor, and everything the shared editor grew —
 * promote to knowledge, raise as a question, link to evidence — never reached
 * it. One component, two scopes, is the structural answer to that.
 *
 * Membership is by **placement**: the surface shows what is in the hoisted
 * subtree, not what matches `primary_project_id` (U6).
 */
export default function ProjectNotesPage() {
  const { projectId = '' } = useParams()
  const { activeSpaceId } = useSpace()
  const [rootCollectionId, setRootCollectionId] = useState<string | null>(null)
  const [providers, setProviders] = useState<ModelProviderOut[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!projectId) return
    let cancelled = false
    setLoading(true)
    setRootCollectionId(null)
    setProviders([])
    setError(null)
    // The folder is created on first visit rather than at project creation, so
    // a Project made before this surface existed still has one when opened.
    void Promise.all([
      notesCollectionsApi.ensureForProject(projectId),
      providersApi.list().catch(() => [] as ModelProviderOut[]),
    ])
      .then(([collection, nextProviders]) => {
        if (cancelled) return
        setRootCollectionId(collection.id)
        setProviders(nextProviders.filter(provider => provider.enabled))
      })
      .catch(caught => { if (!cancelled) setError(errMsg(caught)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [activeSpaceId, projectId])

  const scope = useMemo<NotesSurfaceScope | null>(() => {
    if (!rootCollectionId) return null
    return {
      basePath: `/projects/${projectId}/notes`,
      // Space and Project both, so one Project's open tabs never appear in
      // another's, and a space switch does not carry them either.
      tabsScopeKey: `${activeSpaceId ?? 'none'}:project:${projectId}`,
      pinnedRootCollectionId: rootCollectionId,
      renderHeader: (actions: ReactNode) => (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold">Notes</h1>
          </div>
          {actions}
        </div>
      ),
      renderAside: ({ noteTitleById, onNotesChanged }) => (
        <NotebookChatPanel
          projectId={projectId}
          providers={providers}
          noteTitleById={noteTitleById}
          onNotebookChanged={onNotesChanged}
        />
      ),
    }
  }, [activeSpaceId, projectId, providers, rootCollectionId])

  if (loading) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  if (!scope) {
    return (
      <div className="p-6">
        <EmptyState
          title="Project notes unavailable"
          description={error ?? 'A project writer opens this page once to create the notes folder.'}
        />
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ThreadOriginBar projectId={projectId} kinds={['synthesize']} className="px-6 pt-4" />
      <div className="min-h-0 flex-1">
        <NotesPage scope={scope} />
      </div>
    </div>
  )
}
