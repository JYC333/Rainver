import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

interface ProjectFolderConversationContextValue {
  /** The Folder currently selected in Files & Code, if that Area is mounted. */
  selectedFolderId: string | null
  setSelectedFolderId: (id: string | null) => void
  /** Null means that the current conversation has not exposed an initialized execution context yet. */
  conversationFolderIds: string[] | null
  setConversationFolderIds: (ids: readonly string[] | null) => void
}

const ProjectFolderConversationContext = createContext<ProjectFolderConversationContextValue>({
  selectedFolderId: null,
  setSelectedFolderId: () => undefined,
  conversationFolderIds: null,
  setConversationFolderIds: () => undefined,
})

export function ProjectFolderConversationProvider({ projectId, children }: { projectId: string; children: ReactNode }) {
  const [selectedFolderId, setSelectedFolderIdState] = useState<string | null>(null)
  const [conversationFolderIds, setConversationFolderIdsState] = useState<string[] | null>(null)
  const previousProjectId = useRef(projectId)

  const setSelectedFolderId = useCallback((id: string | null) => {
    setSelectedFolderIdState(current => current === id ? current : id)
  }, [])

  const setConversationFolderIds = useCallback((ids: readonly string[] | null) => {
    const next = ids === null ? null : Array.from(new Set(ids))
    setConversationFolderIdsState(current => {
      if (current === null || next === null) return current === next ? current : next
      return current.length === next.length && current.every((id, index) => id === next[index]) ? current : next
    })
  }, [])

  useEffect(() => {
    if (previousProjectId.current === projectId) return
    previousProjectId.current = projectId
    setSelectedFolderIdState(null)
    setConversationFolderIdsState(null)
  }, [projectId])

  const value = useMemo(() => ({ selectedFolderId, setSelectedFolderId, conversationFolderIds, setConversationFolderIds }), [conversationFolderIds, selectedFolderId, setConversationFolderIds, setSelectedFolderId])
  return <ProjectFolderConversationContext.Provider value={value}>{children}</ProjectFolderConversationContext.Provider>
}

export function useProjectFolderConversation(): ProjectFolderConversationContextValue {
  return useContext(ProjectFolderConversationContext)
}
