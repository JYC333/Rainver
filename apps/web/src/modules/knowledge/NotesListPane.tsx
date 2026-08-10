import { Plus } from 'lucide-react'
import type { NoteCollection, NoteSummary } from '../../types/api'
import { Button } from '../../components/ui/button'
import { Skeleton } from '../../components/ui/skeleton'
import { EmptyState } from '../../components/ui/empty-state'
import { fmt } from './notesPageModel'

export function NotesListPane({
  loading, hasSpace, hasCollections, collection, notes, searching, creating, canCreateNote,
  onOpen, onNew, titleFor, folderNamesFor,
}: {
  loading: boolean
  hasSpace: boolean
  hasCollections: boolean
  collection: NoteCollection | null
  notes: NoteSummary[]
  /** True while the list is a search result over the whole surface rather than
   * one folder's contents. */
  searching: boolean
  creating: boolean
  canCreateNote: boolean
  onOpen: (id: string) => void
  onNew: () => void
  titleFor: (id: string) => string
  /** Which folders a note lives in — shown on search results, which span them. */
  folderNamesFor: (note: NoteSummary) => string[]
}) {
  if (loading) return <div className="p-6"><Skeleton className="h-32 w-full" /></div>

  if (!hasSpace) {
    return (
      <div className="p-6">
        <EmptyState title="Select an operational space" description="Choose a space to browse and create notes." />
      </div>
    )
  }

  if (!hasCollections || (!collection && !searching)) {
    return (
      <div className="p-6">
        <EmptyState title="No note folders" description="Create a folder to start organizing notes." />
      </div>
    )
  }

  if (notes.length === 0) {
    return (
      <div className="p-6">
        <EmptyState
          title={searching ? 'No matching notes' : `${collection?.name ?? 'This folder'} is empty`}
          description={searching ? 'Try a different search term.' : canCreateNote ? 'Create a note in this folder.' : 'Archived notes appear here after you archive them.'}
          action={!searching && canCreateNote ? (
            <Button size="sm" onClick={onNew} disabled={creating}>
              <Plus className="size-4 mr-1" /> {creating ? 'Creating...' : 'New note'}
            </Button>
          ) : undefined}
        />
      </div>
    )
  }

  return (
    <div className="divide-y divide-border">
      {notes.map(note => (
        <button
          key={note.id}
          type="button"
          onClick={() => onOpen(note.id)}
          className="block w-full text-left px-6 py-4 hover:bg-accent/30"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5 mb-1">
                <h2 className="font-medium text-sm">{titleFor(note.id)}</h2>
                {searching && folderNamesFor(note).map(name => (
                  <span key={name} className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                    {name}
                  </span>
                ))}
              </div>
              {note.excerpt && <p className="text-sm text-muted-foreground line-clamp-2">{note.excerpt}</p>}
            </div>
            <p className="text-xs text-muted-foreground shrink-0">{fmt(note.updated_at)}</p>
          </div>
        </button>
      ))}
    </div>
  )
}
