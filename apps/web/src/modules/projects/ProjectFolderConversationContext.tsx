import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ConversationInputResourcePart, InputResourceSelection } from '@rainver/protocol'

export type CurrentFileAttachmentStatus = 'clean' | 'draft' | 'saving' | 'conflict' | 'offline' | 'unsupported'

/** The mounted Files editor's acknowledged, sendable state. */
export interface CurrentFileAttachment {
  sourceKey: string
  projectFolderId: string
  workspaceLocationId: string | null
  relativePath: string
  displayName: string
  mediaType: string
  sourceState: 'saved' | 'draft'
  byteSize: number
  sha256: string | null
  draftId: string | null
  draftVersion: number | null
  contentSha256: string | null
  selection?: InputResourceSelection
  status: CurrentFileAttachmentStatus
  /** Flushes the editor, then returns the exact acknowledged resource part. */
  flushForSend: () => Promise<ConversationInputResourcePart | null>
}

interface ProjectFolderConversationContextValue {
  /** The Folder currently selected in Files & Code, if that Area is mounted. */
  selectedFolderId: string | null
  setSelectedFolderId: (id: string | null) => void
  /** Null means that the current conversation has not exposed an initialized execution context yet. */
  conversationFolderIds: string[] | null
  setConversationFolderIds: (ids: readonly string[] | null) => void
  /** Only the mounted Files & Code editor may publish this; it is not a global file picker. */
  currentFileAttachment: CurrentFileAttachment | null
  setCurrentFileAttachment: (attachment: CurrentFileAttachment | null) => void
}

const ProjectFolderConversationContext = createContext<ProjectFolderConversationContextValue>({
  selectedFolderId: null,
  setSelectedFolderId: () => undefined,
  conversationFolderIds: null,
  setConversationFolderIds: () => undefined,
  currentFileAttachment: null,
  setCurrentFileAttachment: () => undefined,
})

export function ProjectFolderConversationProvider({ projectId, children }: { projectId: string; children: ReactNode }) {
  const [selectedFolderId, setSelectedFolderIdState] = useState<string | null>(null)
  const [conversationFolderIds, setConversationFolderIdsState] = useState<string[] | null>(null)
  const [currentFileAttachment, setCurrentFileAttachmentState] = useState<CurrentFileAttachment | null>(null)
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
    setCurrentFileAttachmentState(null)
  }, [projectId])

  const setCurrentFileAttachment = useCallback((attachment: CurrentFileAttachment | null) => {
    setCurrentFileAttachmentState(attachment)
  }, [])

  const value = useMemo(() => ({
    selectedFolderId,
    setSelectedFolderId,
    conversationFolderIds,
    setConversationFolderIds,
    currentFileAttachment,
    setCurrentFileAttachment,
  }), [conversationFolderIds, currentFileAttachment, selectedFolderId, setConversationFolderIds, setCurrentFileAttachment, setSelectedFolderId])
  return <ProjectFolderConversationContext.Provider value={value}>{children}</ProjectFolderConversationContext.Provider>
}

export function useProjectFolderConversation(): ProjectFolderConversationContextValue {
  return useContext(ProjectFolderConversationContext)
}
