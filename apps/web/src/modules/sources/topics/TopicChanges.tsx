import type {SourceGoalDetail} from '@rainver/protocol'
import {Badge} from '../../../components/ui/badge'
import {useAppTranslation} from '../../../i18n'
import {formatDateTime} from '../../../i18n/format'
import {safeHttpUrl} from '../../../lib/safeHttpUrl'

/** Recorded cited changes (release/update) with their own judgment. */
export function TopicChanges({changes}:{changes:NonNullable<SourceGoalDetail['changes']>}){
 const {t}=useAppTranslation()
 return <section aria-labelledby="topic-changes" className="space-y-2">
  <h2 id="topic-changes" className="text-sm font-semibold">{t('topics.changes')}</h2>
  {changes.length===0?<p className="text-xs text-muted-foreground">{t('topics.noChanges')}</p>:<ul className="space-y-2">{changes.slice(0,10).map(c=>{const evidence=safeHttpUrl(c.evidence_url);return <li key={c.id} className="space-y-1 text-sm">
   <div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{t(`topics.changeKind.${c.change_kind}`)}</Badge><Badge variant={c.delivery_kind==='evidenced_change'?'default':'muted'}>{t(`topics.delivery.${c.delivery_kind}`)}</Badge><span className="text-xs text-muted-foreground">{formatDateTime(c.detected_at)}</span></div>
   {c.selection_reason&&<p className="break-words text-xs text-muted-foreground">{c.selection_reason}{c.judged_by&&<> · {t(`topics.judgedBy.${c.judged_by}`)}</>}</p>}
   {evidence&&<a className="break-all text-xs underline" href={evidence} target="_blank" rel="noreferrer noopener">{t('topics.evidence')}</a>}
  </li>})}</ul>}
 </section>
}
