import type {ReadingTopicLink} from '@rainver/protocol'
import {Badge} from '../../../components/ui/badge'
import {SpaceLink} from '../../../core/spaceNav'
import {useAppTranslation} from '../../../i18n'
import {safeHttpUrl} from '../../../lib/safeHttpUrl'
import {readingGoalPath} from '../sourceGoalNavigation'

/** Why a material is in a topic: freshness, judgment and its stated reason.
 * The reason is a relevance judgment, never a claim the content was verified. */
export function TopicLinkSummary({link,showTopic=false,compact=false}:{link:ReadingTopicLink;showTopic?:boolean;compact?:boolean}){
 const {t}=useAppTranslation()
 const evidence=safeHttpUrl(link.change_evidence_url)
 if(compact)return <SpaceLink className="max-w-56 truncate rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground" title={link.title||t('topics.untitled')} to={readingGoalPath(link.project_id,link.goal_id)}>{link.title||t('topics.untitled')}</SpaceLink>
 return <div className="space-y-1 text-sm">
  <div className="flex flex-wrap items-center gap-2">
   {showTopic&&<SpaceLink className="font-medium hover:underline" to={readingGoalPath(link.project_id,link.goal_id)}>{link.title||t('topics.untitled')}</SpaceLink>}
   <Badge variant={link.delivery_kind==='new_publication'||link.delivery_kind==='evidenced_change'?'default':'outline'} title={t(`topics.deliveryHint.${link.delivery_kind}`)}>{t(`topics.delivery.${link.delivery_kind}`)}</Badge>
   <Badge variant={link.selection_status==='important'?'success':link.selection_status==='judgment_failed'?'warning':'muted'}>{t(`topics.judgment.${link.selection_status}`)}</Badge>
  </div>
  {link.selection_reason&&<p className="break-words text-muted-foreground">{link.selection_reason}{link.judged_by&&<span className="text-xs"> · {t(`topics.judgedBy.${link.judged_by}`)}</span>}</p>}
  {!link.selection_reason&&link.judged_by&&<p className="text-xs text-muted-foreground">{t(`topics.judgedBy.${link.judged_by}`)}</p>}
  {evidence&&<a className="text-xs underline" href={evidence} target="_blank" rel="noreferrer noopener">{t('topics.evidence')}</a>}
 </div>
}
