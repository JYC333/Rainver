/**
 * Opening the Project chat panel on a Room from elsewhere in the Project —
 * for example after a plugin setup authorized an Agent in that Room. The
 * event only names the Room (and optionally a conversation); the panel reads
 * both as the viewer, so naming a Room the viewer cannot read opens the
 * mainline instead. No Room or conversation is created by opening.
 */
export const PROJECT_CHAT_OPEN_EVENT = 'rainver:project-chat-open'

export interface ProjectChatOpenDetail {
  projectId: string
  roomId: string
  conversationId?: string | null
}

export function openProjectChat(detail: ProjectChatOpenDetail): void {
  window.dispatchEvent(new CustomEvent<ProjectChatOpenDetail>(PROJECT_CHAT_OPEN_EVENT, { detail }))
}
