import {useEffect,useRef,useState} from 'react'
import {SourceGoalEditSchema,type SourceGoalDetail} from '@rainver/protocol'
import {sourceGoalsApi} from '../../../api/client'
import {Button} from '../../../components/ui/button'
import {Input} from '../../../components/ui/input'
import {Textarea} from '../../../components/ui/textarea'
import {DialogFooter} from '../../../components/ui/dialog'
import {useAppTranslation} from '../../../i18n'
import {topicTitle} from './topicTitle'

/** Human-authored plan draft. Saving never calls the Agent or applies the plan. */
export function TopicEditor({detail,spaceId,onClose,onSaved,onSaving}:{detail:SourceGoalDetail;spaceId:string;onClose:()=>void;onSaved:()=>void;onSaving:(saving:boolean)=>void}){
 const {t}=useAppTranslation(),g=detail.goal
 const base=detail.versions.find(v=>v.id===(g.current_version_id??g.active_version_id))?.plan_json
 const initial=base?.intent_snapshot??g.intent_json
 const [title,setTitle]=useState(base?.title??topicTitle(g))
 const [summary,setSummary]=useState(base?.summary??'')
 const [intent,setIntent]=useState(String(initial.intent??''))
 const [brief,setBrief]=useState(base?.analysis_brief??base?.summary??String(initial.intent??''))
 const [includes,setIncludes]=useState((initial.includes as string[]|undefined??[]).join('\n'))
 const [excludes,setExcludes]=useState((initial.excludes as string[]|undefined??[]).join('\n'))
 const [queries,setQueries]=useState(()=>base?.sources.flatMap(s=>s.implementation.kind==='agent_search'?[{source_connection_id:s.source_connection_id,query:s.implementation.query,label:s.reason}]:[])??[])
 const [saving,setSaving]=useState(false),[error,setError]=useState<string|null>(null)
 const key=useRef(crypto.randomUUID()),lock=useRef(false),lifetime=useRef<AbortController|null>(null)
 useEffect(()=>{const c=new AbortController();lifetime.current=c;return()=>c.abort()},[])
 const lines=(text:string)=>text.split('\n').map(s=>s.trim()).filter(Boolean)
 async function save(){
  if(lock.current)return
  const input=SourceGoalEditSchema.safeParse({expected_revision:g.revision,idempotency_key:key.current,title,summary,intent,analysis_brief:brief,includes:lines(includes),excludes:lines(excludes),queries:queries.map(({source_connection_id,query})=>({source_connection_id,query}))})
  if(!input.success){setError(t('topics.editInvalid'));return}
  lock.current=true;setSaving(true);onSaving(true);setError(null)
  try{await sourceGoalsApi.edit(g.id,input.data,{spaceId,signal:lifetime.current?.signal});if(!lifetime.current?.signal.aborted)onSaved()}
  catch(e){if(!lifetime.current?.signal.aborted)setError(t(e&&typeof e==='object'&&'status'in e&&e.status===409?'topics.editConflict':'topics.editFailed'))}
  finally{lock.current=false;setSaving(false);onSaving(false)}
 }
 return <form className="flex min-h-0 flex-1 flex-col" onSubmit={e=>{e.preventDefault();void save()}} onChange={()=>{key.current=crypto.randomUUID()}}>
  <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
   <label className="block space-y-1 text-sm"><span>{t('topics.editTitle')}</span><Input value={title} maxLength={60} required disabled={saving} onChange={e=>setTitle(e.target.value)}/></label>
   <label className="block space-y-1 text-sm"><span>{t('topics.editSummary')}</span><Textarea value={summary} maxLength={400} required disabled={saving} onChange={e=>setSummary(e.target.value)}/></label>
   <label className="block space-y-1 text-sm"><span>{t('topics.editPurpose')}</span><Textarea value={intent} maxLength={8000} required disabled={saving} onChange={e=>setIntent(e.target.value)}/></label>
   <label className="block space-y-1 text-sm"><span>{t('topics.editAnalysis')}</span><Textarea value={brief} maxLength={4000} required disabled={saving} onChange={e=>setBrief(e.target.value)}/></label>
   <div className="space-y-4"><label className="block space-y-1 text-sm"><span>{t('topics.editIncludes')}</span><Textarea value={includes} disabled={saving} onChange={e=>setIncludes(e.target.value)}/></label><label className="block space-y-1 text-sm"><span>{t('topics.editExcludes')}</span><Textarea value={excludes} disabled={saving} onChange={e=>setExcludes(e.target.value)}/></label></div>
   {queries.map((q,i)=><label key={q.source_connection_id} className="block space-y-1 text-sm"><span>{t('topics.editQuery',{source:q.label})}</span><Textarea value={q.query} maxLength={1000} required disabled={saving} onChange={e=>setQueries(old=>old.map((v,n)=>n===i?{...v,query:e.target.value}:v))}/></label>)}
  </div>
   {error&&<p role="alert" className="mt-2 shrink-0 text-sm text-destructive">{error}</p>}
   <DialogFooter className="mt-3 shrink-0"><Button variant="ghost" type="button" disabled={saving} onClick={onClose}>{t('topics.editCancel')}</Button><Button type="submit" disabled={saving||!base}>{t(saving?'topics.editSaving':'topics.editSave')}</Button></DialogFooter>
  </form>
}
