import CommandCenterPage from './CommandCenterPage'

/**
 * The Command Center is one page: the machines you have paired. Conversations
 * live on the Room and the chat panels (`modules/conversation`). Do not add a
 * thread, a dispatch composer, or a work-stream list here.
 */
export default function CommandCenterModule() {
  return <CommandCenterPage />
}
