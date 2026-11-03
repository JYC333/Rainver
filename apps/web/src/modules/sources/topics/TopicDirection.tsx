import type {SourceGoalDetail} from '@rainver/protocol'
import {useAppTranslation} from '../../../i18n'

/** Live direction is always read from the active version, never a newer draft. */
export function TopicDirection({detail,draft=false}:{detail:SourceGoalDetail;draft?:boolean}){
 const {t}=useAppTranslation(),goal=detail.goal
 const version=detail.versions.find(v=>v.id===(draft?goal.current_version_id:goal.active_version_id??goal.current_version_id))
 const plan=version?.plan_json
 const intent=plan?.intent_snapshot??(!goal.active_version_id?goal.intent_json:null)
 const includes=plan?.filters?.includes??intent?.includes as string[]|undefined
 const excludes=plan?.filters?.excludes??intent?.excludes as string[]|undefined
 const active=detail.versions.find(v=>v.id===goal.active_version_id)?.plan_json
 const changed=draft&&active&&plan?[
  ['editTitle',active.title,plan.title],
  ['editSummary',active.summary,plan.summary],
  ['editIncludes',active.filters?.includes??active.intent_snapshot?.includes,plan.filters?.includes??plan.intent_snapshot?.includes],
  ['editExcludes',active.filters?.excludes??active.intent_snapshot?.excludes,plan.filters?.excludes??plan.intent_snapshot?.excludes],
  ['editAnalysis',active.analysis_brief,plan.analysis_brief],
  ['searchDirections',active.sources.map(s=>s.implementation.kind==='agent_search'?s.implementation.query:null),plan.sources.map(s=>s.implementation.kind==='agent_search'?s.implementation.query:null)],
 ].filter(([,before,after])=>JSON.stringify(before)!==JSON.stringify(after)).map(([key])=>t(`topics.${key}`)):[]
 return <section aria-label={t(draft?'topics.proposedDirection':'topics.direction')} className="min-w-0 space-y-3 break-words text-sm">
  <h2 className="font-semibold">{t(draft?'topics.proposedDirection':'topics.direction')}</h2>
  {changed.length>0&&<p className="text-xs text-muted-foreground">{t('topics.changedFields',{fields:changed.join(' · ')})}</p>}
  {draft&&plan?.title&&<p className="font-medium">{plan.title}</p>}
  <p className="whitespace-pre-wrap">{plan?.summary??t('topics.directionUnavailable')}</p>
  {!!includes?.length&&<div><p className="text-xs font-medium text-muted-foreground">{t('sourceGoals.includes')}</p><p>{includes.join(' · ')}</p></div>}
  {!!excludes?.length&&<div><p className="text-xs font-medium text-muted-foreground">{t('sourceGoals.excludes')}</p><p>{excludes.join(' · ')}</p></div>}
  {!!plan?.sources.length&&<div className="space-y-2"><h3 className="text-xs font-medium text-muted-foreground">{t('topics.collectionScope')}</h3><ul className="list-disc space-y-1 pl-5">{Array.from(new Set(plan.sources.map(s=>s.reason))).map(reason=><li key={reason}>{reason}</li>)}</ul></div>}
  {plan?.analysis_brief&&<div className="space-y-2"><h3 className="text-xs font-medium text-muted-foreground">{t('topics.editAnalysis')}</h3><p className="whitespace-pre-wrap">{plan.analysis_brief}</p></div>}
  {plan?.sources.some(s=>s.implementation.kind==='agent_search')&&<details><summary className="cursor-pointer text-xs text-muted-foreground">{t('topics.searchDirections')}</summary><ul className="mt-2 space-y-2 text-muted-foreground">{plan.sources.map(s=>s.implementation.kind==='agent_search'&&<li key={s.source_channel_id} className="whitespace-pre-wrap">{s.implementation.query}</li>)}</ul></details>}
 </section>
}
