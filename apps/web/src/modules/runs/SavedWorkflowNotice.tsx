import type { SaveWorkflowFromRunResult } from '../../api/client'
import { Button } from '../../components/ui/button'
import { SpaceLink as Link } from '../../core/spaceNav'
import { useAppTranslation } from '../../i18n'
import { evolutionAssetPath } from '../evolution/paths'

/**
 * Where a Run saved as a Workflow goes next: the existing Proposal review
 * page when the save needs review, or the saved draft's version lifecycle
 * and promotion in Evolution. Neither destination is bypassed here.
 */
export function SavedWorkflowNotice({ result }: { result: SaveWorkflowFromRunResult }) {
  const { t } = useAppTranslation()
  const proposal = result.status === 'proposal_required'
  return (
    <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-muted/30 p-3">
      <div className="min-w-0 space-y-0.5">
        <p className="text-sm font-medium">
          {t(proposal ? 'management_ui.run_workflow_save.proposal_created' : 'management_ui.run_workflow_save.draft_saved')}
        </p>
        <p className="text-xs text-muted-foreground">
          {t(proposal ? 'management_ui.run_workflow_save.proposal_created_hint' : 'management_ui.run_workflow_save.draft_saved_hint')}
        </p>
      </div>
      <Button size="sm" variant="outline" asChild>
        {proposal
          ? <Link to={`/proposals/${encodeURIComponent(result.proposal_id)}`}>{t('management_ui.run_workflow_save.review_proposal')}</Link>
          : <Link to={evolutionAssetPath(result.asset_id)}>{t('management_ui.run_workflow_save.open_draft')}</Link>}
      </Button>
    </div>
  )
}
