import {TopicCheckButton} from './TopicCheckButton'
import {useState} from 'react'
import type {SourceGoalDetail,SourceGoalFeedbackRequest} from '@rainver/protocol'
import {sourceGoalsApi} from '../../../api/client'
import {Button} from '../../../components/ui/button'
import {Input} from '../../../components/ui/input'
import {Select} from '../../../components/ui/select'
import {useAppTranslation} from '../../../i18n'
import {SourceGoalDeleteButton} from '../SourceGoalDeleteButton'
import {feedbackKey,FREQUENCIES,lifecycleAction} from './followOptions'

/** Pause/resume/delete and tightening-only feedback (slower checks, excluded
 * words). Faster checks or a larger budget go through a new follow confirmation. */
export function TopicManage({goal,spaceId,canManage,busy,act,onDeleted}:{goal:SourceGoalDetail['goal'];spaceId:string;canManage:boolean;busy:boolean;act:(action:()=>Promise<unknown>)=>Promise<void>;onDeleted:()=>void}){
 const {t}=useAppTranslation()
 const state=goal.follow_state
 const manual=goal.compatibility_json?.execution_mode==='manual'
 const interval=goal.budget_json.interval_seconds
 const slower=FREQUENCIES.filter(s=>s>interval)
 const [slowTo,setSlowTo]=useState<number|null>(null)
 const [term,setTerm]=useState('')
 const rules=goal.follow_json?.rules
 const feedback=(body:SourceGoalFeedbackRequest)=>act(()=>sourceGoalsApi.feedback(goal.id,body,{spaceId}))
 const lifecycle=lifecycleAction(goal)
 return <section aria-labelledby="topic-manage" className="space-y-3">
  <h2 id="topic-manage" className="text-sm font-semibold">{t('topics.manage')}</h2>
  {canManage&&<TopicCheckButton key={`${spaceId}:${goal.id}:${goal.active_version_id}`} goal={goal} spaceId={spaceId} busy={busy} act={act}/>}
  {manual&&<p className="text-xs text-muted-foreground">{t('topics.manualOnly')}</p>}
  <div className="flex flex-wrap gap-2">
   {lifecycle&&<Button size="sm" variant="outline" disabled={!canManage||busy} onClick={()=>void act(()=>sourceGoalsApi.action(goal.id,lifecycle,{version_id:goal.active_version_id},{spaceId}))}>{t(`sourceGoals.${lifecycle}`)}</Button>}
   <SourceGoalDeleteButton goalId={goal.id} spaceId={spaceId} disabled={!canManage||busy} onDeleted={onDeleted}/>
  </div>
  {state?.intent==='following'&&slower.length>0&&<div className="flex flex-wrap items-end gap-2"><div className="min-w-0 flex-1 space-y-1"><p className="text-xs text-muted-foreground">{t('topics.slowDown')}</p><Select size="sm" ariaLabel={t('topics.slowDown')} disabled={!canManage||busy} value={String(slowTo??slower[0])} onChange={v=>setSlowTo(Number(v))} options={slower.map(s=>({value:String(s),label:t(`topics.frequencyOption.${s}`)}))}/></div><Button size="sm" variant="outline" disabled={!canManage||busy} onClick={()=>{const seconds=slowTo??slower[0];void feedback({kind:'slow_down',interval_seconds:seconds,idempotency_key:feedbackKey('slow_down',String(seconds))})}}>{t('topics.slowDownApply')}</Button></div>}
  {state?.intent==='following'&&<form className="flex flex-wrap items-end gap-2" onSubmit={e=>{e.preventDefault();const value=term.trim();if(!value)return;void feedback({kind:'exclude_term',term:value,idempotency_key:feedbackKey('exclude_term',value)}).then(()=>setTerm(''))}}><div className="min-w-0 flex-1 space-y-1"><label htmlFor="topic-exclude-term" className="text-xs text-muted-foreground">{t('topics.excludeTerm')}</label><Input id="topic-exclude-term" maxLength={200} value={term} disabled={!canManage||busy} onChange={e=>setTerm(e.target.value)}/></div><Button size="sm" variant="outline" type="submit" disabled={!canManage||busy||!term.trim()}>{t('topics.excludeTermApply')}</Button></form>}
  {rules&&(rules.excluded_origins.length>0||rules.excluded_terms.length>0)&&<div className="space-y-1 text-xs text-muted-foreground"><p className="font-medium">{t('topics.exclusions')}</p><ul className="space-y-0.5 break-words">{[...rules.excluded_origins,...rules.excluded_terms].map(v=><li key={v}>{v}</li>)}</ul></div>}
 </section>
}
