import { Server } from 'lucide-react'
import { useSpace } from '../../contexts/SpaceContext'
import HostsPanel from './HostsPanel'

/**
 * The machines you have paired, and what runs on them.
 *
 * This page used to be two things: a dispatch composer with a work stream —
 * a third conversation surface, with its own message queue and its own
 * account of what an Agent was doing — and the host list. Work is started
 * from a Task or from a Room now, and a turn is read where the conversation
 * is (`modules/conversation`), so what remains is host management: pairing,
 * provider bindings, the login terminal, host Agents and their directories.
 */
export default function CommandCenterPage() {
  const { activeSpaceId, activeSpaceName, preferredSpaceId, spaces } = useSpace()
  const browsingSpaceId = activeSpaceId ?? preferredSpaceId
  const browsingSpaceName = activeSpaceName ?? spaces.find(s => s.id === browsingSpaceId)?.name ?? null

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-4 pb-4 border-b border-border">
        <div
          className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
          style={{
            background: 'color-mix(in oklch, var(--primary) 12%, transparent)',
            border: '1px solid color-mix(in oklch, var(--primary) 35%, transparent)',
          }}
        >
          <Server className="size-5 text-accent-foreground" />
        </div>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Command Center</h1>
          <p className="text-sm text-muted-foreground">Pair machines, bind their providers, and manage what runs on them.</p>
          <p className="text-xs text-muted-foreground">Viewing: {browsingSpaceName ?? browsingSpaceId ?? 'No operational space selected'}</p>
        </div>
      </div>

      <HostsPanel />
    </div>
  )
}
