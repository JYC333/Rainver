import { useEffect } from 'react'
import { Archive, FolderMinus, Trash2 } from 'lucide-react'
import { useAppTranslation } from '../../../i18n'

export interface TreeContextMenuPosition {
  x: number
  y: number
}

interface TreeContextMenuProps {
  label: string
  archiveLabel?: string
  deleteLabel?: string
  position: TreeContextMenuPosition | null
  onClose: () => void
  onArchive?: () => void
  onDelete: () => void
  /**
   * Take the note out of this one folder. Absent when the note has only one
   * placement: removing that is deleting the note, which is its own action and
   * its own confirmation.
   */
  onRemovePlacement?: () => void
  removePlacementLabel?: string
}

export function TreeContextMenu({
  label, archiveLabel, deleteLabel, position, onClose, onArchive, onDelete,
  onRemovePlacement, removePlacementLabel,
}: TreeContextMenuProps) {
  const { t } = useAppTranslation()
  useEffect(() => {
    if (!position) return

    function onPointerDown() {
      onClose()
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }

    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose, position])

  if (!position) return null

  function archiveFromMenu() {
    onClose()
    onArchive?.()
  }

  function deleteFromMenu() {
    onClose()
    onDelete()
  }

  return (
    <div
      role="menu"
      aria-label={t('knowledge_ui.tree.menu_actions', { label })}
      onMouseDown={event => event.stopPropagation()}
      className="fixed z-50 min-w-[9rem] rounded-lg border border-border bg-card p-1 shadow-lg"
      style={{ left: position.x, top: position.y }}
    >
      {onArchive && (
        <button
          type="button"
          role="menuitem"
          onClick={archiveFromMenu}
          className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-accent focus:bg-accent focus:outline-none"
        >
          <Archive className="size-4" /> {archiveLabel ?? t('knowledge_ui.tree.archive')}
        </button>
      )}
      {onRemovePlacement && (
        <button
          type="button"
          role="menuitem"
          onClick={() => { onClose(); onRemovePlacement() }}
          className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-accent focus:bg-accent focus:outline-none"
        >
          <FolderMinus className="size-4" /> {removePlacementLabel ?? t('knowledge_ui.tree.remove_from_folder')}
        </button>
      )}
      <button
        type="button"
        role="menuitem"
        onClick={deleteFromMenu}
        className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm text-destructive transition-colors hover:bg-accent focus:bg-accent focus:outline-none"
      >
        <Trash2 className="size-4" /> {deleteLabel ?? t('knowledge_ui.tree.delete')}
      </button>
    </div>
  )
}
