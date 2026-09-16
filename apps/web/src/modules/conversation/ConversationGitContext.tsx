import { GitBranch } from 'lucide-react'
import type { ConversationGitSnapshot } from '@rainver/protocol'

export function ConversationGitContext({ snapshot }: { snapshot?: ConversationGitSnapshot | null }) {
  if (!snapshot) {
    return <div className="flex gap-2 text-xs" data-testid="conversation-git-context">
      <span className="flex w-24 shrink-0 items-center gap-1 text-muted-foreground"><GitBranch className="size-3" />Git</span>
      <span className="text-destructive">Unavailable</span>
    </div>
  }
  const state = snapshot.dirty === null ? 'status unavailable' : snapshot.dirty ? 'dirty' : 'clean'
  const branch = snapshot.branch ?? 'detached / no branch'
  const commit = snapshot.commit_sha ? snapshot.commit_sha.slice(0, 12) : 'no commit'
  return <div className="flex gap-2 text-xs" data-testid="conversation-git-context">
    <span className="flex w-24 shrink-0 items-center gap-1 text-muted-foreground"><GitBranch className="size-3" />Git</span>
    <span className={!snapshot.execution_ready || snapshot.dirty ? 'text-warning' : ''}>
      {branch} · {commit} · {state}{!snapshot.execution_ready ? ' · workspace unavailable' : ''}
    </span>
  </div>
}
