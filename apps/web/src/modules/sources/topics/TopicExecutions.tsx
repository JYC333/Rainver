import type {SourceGoalDetail} from '@rainver/protocol'
import {StatusBadge} from '../../../components/ui/badge'
import {SpaceLink} from '../../../core/spaceNav'
import {useAppTranslation} from '../../../i18n'
import {formatDateTime} from '../../../i18n/format'

/** Use the authorized collection audits, not planning turns or assumed results. */
export function TopicExecutions({detail}:{detail:SourceGoalDetail}){
 const {t}=useAppTranslation()
 const entry=(r:SourceGoalDetail['runs'][number],i:number)=>{
   const binding=detail.bindings.find(b=>b.id===r.binding_id)
   const readable=binding&&!('unavailable'in binding)
   const result=readable&&r.result_json&&typeof r.result_json==='object'&&!Array.isArray(r.result_json)?r.result_json as Record<string,unknown>:null
   const native=detail.native_runs?.find(n=>n.id===result?.native_run_id)
   const time=typeof r.started_at==='string'?r.started_at:null
   return <li key={String(r.id??i)} className="min-w-0 space-y-2 rounded-md border border-border p-3 text-sm">
    <div className="flex flex-wrap items-center justify-between gap-2"><span>{time?formatDateTime(time):t('topics.never')}</span><StatusBadge status={String(r.status??'unknown')} label={t(`topics.auditStatus.${r.status}`,{defaultValue:t('topics.auditUnknown')})}/></div>
    <p className="break-words">{readable?binding.spec_json.reason:t('topics.unavailableSource')}</p>
    {typeof result?.goal_items_new==='number'&&<p className="text-xs text-muted-foreground">{t('topics.collectedNew',{count:result.goal_items_new})}</p>}
    {native&&<details><summary className="cursor-pointer text-xs text-muted-foreground">{t('topics.runDetails')}</summary><SpaceLink className="mt-2 inline-block underline" to={`/runs/${native.id}`}>{t('topics.openExecution')}</SpaceLink></details>}
   </li>
 }
 return <section aria-labelledby="topic-executions" className="space-y-3"><h2 id="topic-executions" className="text-sm font-semibold">{t('topics.executions')}</h2>
  {!detail.runs.length?<p className="text-sm text-muted-foreground">{t('topics.noExecutions')}</p>:<ul className="space-y-2">{detail.runs.slice(0,5).map(entry)}</ul>}
  {detail.runs.length>5&&<details><summary className="cursor-pointer text-sm text-muted-foreground">{t('topics.olderChecks',{count:detail.runs.length-5})}</summary><ul className="mt-3 space-y-2">{detail.runs.slice(5).map(entry)}</ul></details>}

 </section>
}
