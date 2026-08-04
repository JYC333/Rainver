import { useState } from 'react'
import { ChevronDown, ChevronRight, FlaskConical, HelpCircle, Star } from 'lucide-react'
import type { InquiryThread } from '../../../types/api'
import { Badge } from '../../../components/ui/badge'
import { EmptyState } from '../../../components/ui/empty-state'
import { groupThreadsForNavigator, priorityLabel, type ThreadGroupId } from './threadGrouping'

function ThreadRow({ thread, selected, onSelect, showPriority }: {
  thread: InquiryThread
  selected: boolean
  onSelect: () => void
  showPriority?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      className={`w-full rounded-md border p-2 text-left transition-colors ${
        selected ? 'border-primary bg-primary/5' : 'border-transparent hover:bg-muted/50'
      }`}
    >
      <div className="mb-1 flex items-center gap-1.5">
        {thread.kind === 'question'
          ? <HelpCircle className="size-3.5 shrink-0 text-muted-foreground" />
          : <FlaskConical className="size-3.5 shrink-0 text-accent-foreground" />}
        {thread.blocked_reason
          ? <Badge variant="destructive" className="text-[10px]">blocked</Badge>
          : thread.next_focus_kind
            ? <span className="truncate text-[10px] text-muted-foreground">{thread.next_focus_kind.replace(/_/g, ' ')}</span>
            : <span className="text-[10px] text-amber-600">no next step</span>}
        <div className="flex-1" />
        {showPriority && thread.priority !== 1 && (
          <span className="text-[10px] text-muted-foreground">{priorityLabel(thread.priority)}</span>
        )}
      </div>
      <p className="line-clamp-2 text-sm">{thread.statement}</p>
    </button>
  )
}

export function ThreadNavigator({ threads, personalFocus, wipLimit, selectedId, onSelect }: {
  threads: InquiryThread[]
  personalFocus: InquiryThread[]
  wipLimit: number
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  const groups = groupThreadsForNavigator(threads)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(groups.filter(group => group.defaultCollapsed).map(group => [group.id, true])))

  if (threads.length === 0) {
    return (
      <EmptyState
        title="No Questions or Hypotheses yet"
        description="Start by creating a Question or Hypothesis Thread."
      />
    )
  }

  const toggle = (id: ThreadGroupId) => setCollapsed(current => ({ ...current, [id]: !current[id] }))
  const focusedCount = groups.find(group => group.id === 'focused')?.threads.length ?? 0

  return (
    <div className="space-y-4">
      {personalFocus.length > 0 && (
        <section aria-label="My Focus">
          <p className="mb-1.5 flex items-center gap-1.5 px-1 text-xs font-medium text-muted-foreground">
            <Star className="size-3 fill-current" />My Focus ({personalFocus.length})
          </p>
          <div className="space-y-1">
            {personalFocus.map(thread => (
              <ThreadRow key={thread.id} thread={thread} selected={selectedId === thread.id} onSelect={() => onSelect(thread.id)} />
            ))}
          </div>
        </section>
      )}

      {groups.map(group => (
        <section key={group.id} aria-label={group.label}>
          <button
            type="button"
            onClick={() => toggle(group.id)}
            className="mb-1.5 flex w-full items-center gap-1 px-1 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            {collapsed[group.id] ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
            {group.label} ({group.threads.length}
            {group.id === 'focused' ? `/${wipLimit} WIP` : ''})
          </button>
          {!collapsed[group.id] && (
            <div className="space-y-1">
              {group.threads.map(thread => (
                <ThreadRow
                  key={thread.id}
                  thread={thread}
                  selected={selectedId === thread.id}
                  onSelect={() => onSelect(thread.id)}
                  showPriority={group.id === 'backlog'}
                />
              ))}
            </div>
          )}
        </section>
      ))}

      {focusedCount >= wipLimit && (
        <p className="px-1 text-[11px] text-amber-600">
          Shared Focus is at its WIP limit — move a Thread to Monitoring before focusing another.
        </p>
      )}
    </div>
  )
}
