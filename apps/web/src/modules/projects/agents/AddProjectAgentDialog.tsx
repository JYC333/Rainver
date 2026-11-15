import { useState } from 'react'
import { Loader2, Plus, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { projectsApi } from '../../../api/client'
import { Badge } from '../../../components/ui/badge'
import { Button } from '../../../components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../../components/ui/dialog'
import { Input } from '../../../components/ui/input'
import { SpaceLink as Link } from '../../../core/spaceNav'
import { useAppTranslation } from '../../../i18n'
import { errMsg } from '../../../lib/utils'
import type { ProjectAgentCandidate } from '../../../types/api'
import { PAGE_SIZE, usePagedSearch } from './usePagedSearch'

/**
 * Add an Agent the person already has to this Project.
 *
 * A reference, not a copy, and it joins no Room: adding to a Room is a separate
 * choice on the Agent's card or in the Room's members.
 */
export function AddProjectAgentDialog({ open, projectId, createHref, onClose, onAdded }: {
  open: boolean
  projectId: string
  createHref: string
  onClose: () => void
  onAdded: (candidate: ProjectAgentCandidate) => Promise<void> | void
}) {
  const { t } = useAppTranslation()
  const [adding, setAdding] = useState<string | null>(null)
  const search = usePagedSearch<ProjectAgentCandidate>(open, (q, offset) =>
    projectsApi.agentCandidates(projectId, { q: q || undefined, limit: PAGE_SIZE, offset }), projectId)

  async function add(candidate: ProjectAgentCandidate) {
    setAdding(candidate.agent_id)
    try {
      await projectsApi.addAgent(projectId, candidate.agent_id)
      toast.success(t('collab_ui.agents.added', { name: candidate.name }))
      await onAdded(candidate)
      await search.reload()
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setAdding(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={next => { if (!next) onClose() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('collab_ui.add_agent.title')}</DialogTitle>
          <DialogDescription>{t('collab_ui.add_agent.description')}</DialogDescription>
        </DialogHeader>
        <Input
          aria-label={t('collab_ui.add_agent.search')}
          placeholder={t('collab_ui.add_agent.search')}
          value={search.query}
          onChange={event => search.setQuery(event.target.value)}
        />
        <div className="mt-1 max-h-[50vh] min-h-[8rem] space-y-2 overflow-y-auto pt-2" aria-busy={search.loading}>
          {search.failed && search.items.length === 0 ? (
            <div className="flex items-center justify-between gap-2 rounded-md border border-border p-3 text-sm text-muted-foreground">
              <span>{t('collab_ui.add_agent.load_failed')}</span>
              <Button size="sm" variant="outline" onClick={() => void search.reload()}><RefreshCw className="size-3.5" />{t('collab_ui.common.retry')}</Button>
            </div>
          ) : search.loading && search.items.length === 0 ? (
            <p className="flex items-center gap-2 p-3 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t('collab_ui.common.loading')}</p>
          ) : search.items.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">
              {search.query.trim() ? t('collab_ui.add_agent.no_match', { q: search.query.trim() }) : t('collab_ui.add_agent.empty')}
            </p>
          ) : (
            search.items.map(candidate => (
              <div key={candidate.agent_id} className="flex items-center justify-between gap-3 rounded-md border border-border p-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium">{candidate.name}</span>
                    {candidate.private && <Badge variant="outline">{t('collab_ui.common.private')}</Badge>}
                  </div>
                  {candidate.description && <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{candidate.description}</p>}
                  {candidate.private && <p className="mt-0.5 text-xs text-muted-foreground">{t('collab_ui.add_agent.private_note')}</p>}
                </div>
                {candidate.linked ? (
                  <Badge variant="secondary" className="shrink-0">{t('collab_ui.add_agent.already')}</Badge>
                ) : (
                  <Button size="sm" className="shrink-0" disabled={adding !== null} onClick={() => void add(candidate)}>
                    {adding === candidate.agent_id ? t('collab_ui.add_agent.adding') : t('collab_ui.add_agent.add')}
                  </Button>
                )}
              </div>
            ))
          )}
          {search.hasMore && (
            <Button size="sm" variant="ghost" className="w-full" disabled={search.loading} onClick={() => void search.loadMore()}>
              {search.loading ? <Loader2 className="size-3.5 animate-spin" /> : null}{t('collab_ui.common.load_more')}
            </Button>
          )}
          {search.failed && search.items.length > 0 && (
            <p className="text-xs text-destructive">{t('collab_ui.add_agent.load_failed')}</p>
          )}
        </div>
        <div className="flex justify-between gap-2 border-t border-border pt-3">
          <Button asChild size="sm" variant="ghost">
            <Link to={createHref}><Plus className="size-3.5" />{t('collab_ui.add_agent.create_instead')}</Link>
          </Button>
          <Button size="sm" variant="outline" onClick={onClose}>{t('collab_ui.common.close')}</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
