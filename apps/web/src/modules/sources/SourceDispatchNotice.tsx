import {SpaceLink as Link} from '../../core/spaceNav'
import {useAppTranslation} from '../../i18n'
/** Context beside the existing action; execution history remains in Job Queue. */
export function SourceDispatchNotice(){
 const {t}=useAppTranslation()
 return <p className="text-sm text-muted-foreground" data-testid="source-dispatch-notice">{t('sources_ui.dispatch.queued_help')} <Link className="text-primary underline underline-offset-2" to="/jobs">{t('sources_ui.dispatch.results_link')}</Link> {t('sources_ui.dispatch.unknown_help')}</p>
}
