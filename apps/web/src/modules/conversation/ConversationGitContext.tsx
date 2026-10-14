import { GitBranch } from 'lucide-react'
import type { ConversationGitSnapshot } from '@rainver/protocol'
import { useAppTranslation } from '../../i18n'

export function ConversationGitContext({ snapshot }: { snapshot?: ConversationGitSnapshot | null }) {
  const { t } = useAppTranslation()
  if (!snapshot) {
    return <div className="flex gap-2 text-xs" data-testid="conversation-git-context">
      <span className="flex w-24 shrink-0 items-center gap-1 text-muted-foreground"><GitBranch className="size-3" />{t('conversation_ui.git.label')}</span>
      <span className="text-destructive">{t('conversation_ui.git.unavailable')}</span>
    </div>
  }
  const state = snapshot.dirty === null ? t('conversation_ui.git.status_unavailable') : snapshot.dirty ? t('conversation_ui.git.dirty') : t('conversation_ui.git.clean')
  const branch = snapshot.branch ?? t('conversation_ui.git.no_branch')
  const commit = snapshot.commit_sha ? snapshot.commit_sha.slice(0, 12) : t('conversation_ui.git.no_commit')
  return <div className="flex gap-2 text-xs" data-testid="conversation-git-context">
    <span className="flex w-24 shrink-0 items-center gap-1 text-muted-foreground"><GitBranch className="size-3" />{t('conversation_ui.git.label')}</span>
    <span className={!snapshot.execution_ready || snapshot.dirty ? 'text-warning' : ''}>
      {branch} · {commit} · {state}{!snapshot.execution_ready ? t('conversation_ui.git.workspace_unavailable') : ''}
    </span>
  </div>
}
