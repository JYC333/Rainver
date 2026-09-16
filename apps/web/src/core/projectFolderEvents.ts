/** Browser-local notification for a conversation changing a Project Folder. */
export const PROJECT_FOLDER_CONTENT_CHANGED_EVENT = 'rainver:project-folder-content-changed'

export interface ProjectFolderContentChangedDetail {
  projectFolderIds: string[]
}

export function notifyProjectFolderContentChanged(projectFolderIds: readonly string[]): void {
  if (typeof window === 'undefined') return
  const ids = Array.from(new Set(projectFolderIds.filter(Boolean)))
  if (ids.length === 0) return
  window.dispatchEvent(new CustomEvent<ProjectFolderContentChangedDetail>(PROJECT_FOLDER_CONTENT_CHANGED_EVENT, {
    detail: { projectFolderIds: ids },
  }))
}

export function subscribeProjectFolderContentChanged(
  handler: (detail: ProjectFolderContentChangedDetail) => void,
): () => void {
  if (typeof window === 'undefined') return () => undefined
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<ProjectFolderContentChangedDetail>).detail
    if (!detail || !Array.isArray(detail.projectFolderIds)) return
    handler(detail)
  }
  window.addEventListener(PROJECT_FOLDER_CONTENT_CHANGED_EVENT, listener)
  return () => window.removeEventListener(PROJECT_FOLDER_CONTENT_CHANGED_EVENT, listener)
}
