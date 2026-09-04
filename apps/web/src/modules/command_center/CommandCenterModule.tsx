import CommandCenterPage from './CommandCenterPage'

/**
 * The Command Center is one page: the machines you have paired.
 *
 * It used to carry a second surface — a thread with its own conversation,
 * dispatch composer and work-stream list — which was the third way this
 * product rendered a conversation. Conversations live on the Room and the
 * chat panels now (see `modules/conversation`), so what is left here is
 * host management, and a single page needs no router.
 */
export default function CommandCenterModule() {
  return <CommandCenterPage />
}
