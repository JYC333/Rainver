import { Inbox } from 'lucide-react'
import { useSpace } from '../../contexts/SpaceContext'
import { ActivityQueue } from './ActivityQueue'

/**
 * The Space's raw-review queue. The queue itself lives in {@link ActivityQueue}
 * — this page is its Space-wide mounting, and a Project's Raw material page is
 * the same queue pinned to one Project.
 */
export default function ActivityInboxPage() {
  const { activeSpaceId, activeSpaceName } = useSpace()

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between pb-4 border-b border-border">
        <div className="flex items-center gap-4">
          <div
            className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
            style={{
              background: 'color-mix(in oklch, var(--primary) 12%, transparent)',
              border: '1px solid color-mix(in oklch, var(--primary) 35%, transparent)',
            }}
          >
            <Inbox className="size-5 text-accent-foreground" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Activity Inbox</h1>
            <p className="text-sm text-muted-foreground">Saved as activity first. Nothing becomes memory or changes files without review.</p>
            <p className="text-xs text-muted-foreground">Viewing: {activeSpaceName ?? activeSpaceId ?? 'No operational space selected'}</p>
          </div>
        </div>
      </div>

      <ActivityQueue />
    </div>
  )
}
