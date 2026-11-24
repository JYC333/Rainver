import type React from 'react'
import type { ConversationExecutionSummary, RoomConversation as RoomConversationRecord } from '../../../types/api'
import { ConversationSurface } from '../../conversation/ConversationSurface'
import { ConversationExecutionPreflight } from '../../conversation/ConversationExecutionPreflight'
import { conversationInputSourcesFromExecutionSummary } from '../../conversation/ConversationInputComposer'
import type { CurrentFileAttachment } from '../ProjectFolderConversationContext'

/**
 * The sidecar's conversation body, split from `ProjectChatSidecar` so the
 * Room conversation stack (composer editor, message rendering, highlighting)
 * loads beside the Project page instead of in front of it. The sidecar
 * prefetches this module as soon as it opens, in parallel with its Room reads,
 * and renders it only once those reads resolve, exactly as before.
 */
export interface ProjectSidecarConversationProps {
  spaceId: string | undefined
  projectId: string
  roomId: string
  sessionId: string
  conversations: RoomConversationRecord[]
  executionReady: boolean
  executionSummary: ConversationExecutionSummary | null
  selectedFolderId: string | null
  implicitInputResource: CurrentFileAttachment | null
  composerAttachments: React.ReactNode
  focusRefs: Array<{ type: 'task'; id: string }>
  onConversationCreated: (conversation: RoomConversationRecord) => void
  onNewConversation: () => void
  onReadyChange: (ready: boolean) => void
  onSummaryChange: (summary: ConversationExecutionSummary | null) => void
  onConversationUpdated: (conversation: RoomConversationRecord) => void
}

export default function ProjectSidecarConversation(props: ProjectSidecarConversationProps) {
  const { executionSummary } = props
  return (
    <ConversationSurface
      spaceId={props.spaceId}
      // Picking works here too: the panel has the Room's other
      // threads, so a pick has somewhere to go. Starting a new thread is
      // not one of this surface's affordances, so that action is not
      // offered and the toolbar hides it.
      siblingConversations={props.conversations}
      roomId={props.roomId}
      conversationId={props.sessionId || null}
      executionReady={props.executionReady}
      participantAgentIds={executionSummary?.state === 'initialized'
        ? (executionSummary.runtimes?.length ? executionSummary.runtimes : (executionSummary.runtime ? [executionSummary.runtime] : [])).map(pin => pin.agent_id)
        : executionSummary?.participant_agent_ids}
      inputFileSources={conversationInputSourcesFromExecutionSummary(executionSummary)}
      implicitInputResource={props.implicitInputResource}
      composerAttachments={props.composerAttachments}
      executionPreflight={(
        <ConversationExecutionPreflight
          projectId={props.projectId}
          roomId={props.roomId}
          sessionId={props.sessionId || null}
          preferredProjectFolderId={props.selectedFolderId}
          onConversationCreated={props.onConversationCreated}
          onNewConversation={props.onNewConversation}
          onReadyChange={props.onReadyChange}
          onSummaryChange={props.onSummaryChange}
        />
      )}
      variant="panel"
      focusRefs={props.focusRefs}
      onConversationUpdated={props.onConversationUpdated}
      emptyHint="Ask the Agent about what you are looking at — it already knows which Task that is."
    />
  )
}
