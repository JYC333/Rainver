import {useEffect,useRef,useState} from 'react'
import {SourceGoalEditSchema,type SourceGoalDetail} from '@rainver/protocol'
import {sourceGoalsApi} from '../../../api/client'
import {Button} from '../../../components/ui/button'
import {Input} from '../../../components/ui/input'
import {Textarea} from '../../../components/ui/textarea'
import {Dialog,DialogContent,DialogDescription,DialogFooter,DialogHeader,DialogTitle} from '../../../components/ui/dialog'
import {useAppTranslation} from '../../../i18n'
import {topicTitle} from './topicTitle'

/** Human-authored plan draft. Saving never calls the Agent or applies the plan. */
export function TopicEditor({detail,spaceId,onClose,onSaved}:{detail:SourceGoalDetail;spaceId:string;onClose:()=>void;onSaved:()=>void}){
 const {t}=useAppTranslation(),g=detail.goal
 const base=detail.versions.find(v=>v.id===(g.current_version_id??g.active_version_id))?.plan_json
 const initial=base?.intent_snapshot??g.intent_json
 const [title,setTitle]=useState(base?.title??topicTitle(g))
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
  const input=SourceGoalEditSchema.safeParse({expected_revision:g.revision,idempotency_key:key.current,title,intent,analysis_brief:brief,includes:lines(includes),excludes:lines(excludes),queries:queries.map(({source_connection_id,query})=>({source_connection_id,query}))})
  if(!input.success){setError(t('topics.editInvalid'));return}
  lock.current=true;setSaving(true);setError(null)
  try{await sourceGoalsApi.edit(g.id,input.data,{spaceId,signal:lifetime.current?.signal});if(!lifetime.current?.signal.aborted)onSaved()}
  catch(e){if(!lifetime.current?.signal.aborted)setError(t(e&&typeof e==='object'&&'status'in e&&e.status===409?'topics.editConflict':'topics.editFailed'))}
  finally{lock.current=false;setSaving(false)}
 }
 return <Dialog open onOpenChange={open=>{if(!open&&!saving)onClose()}}><DialogContent className="max-h-[90dvh] overflow-y-auto" showClose={!saving}>
  <DialogHeader><DialogTitle>{t('topics.edit')}</DialogTitle><DialogDescription>{t('topics.editHint')}</DialogDescription></DialogHeader>
  <form className="space-y-4" onSubmit={e=>{e.preventDefault();void save()}} onChange={()=>{key.current=crypto.randomUUID()}}>
   <label className="block space-y-1 text-sm"><span>{t('topics.editTitle')}</span><Input value={title} maxLength={60} required disabled={saving} onChange={e=>setTitle(e.target.value)}/></label>
   <label className="block space-y-1 text-sm"><span>{t('topics.editPurpose')}</span><Textarea value={intent} maxLength={8000} required disabled={saving} onChange={e=>setIntent(e.target.value)}/></label>
   <label className="block space-y-1 text-sm"><span>{t('topics.editAnalysis')}</span><Textarea value={brief} maxLength={4000} required disabled={saving} onChange={e=>setBrief(e.target.value)}/></label>
   <div className="grid gap-4 sm:grid-cols-2"><label className="block space-y-1 text-sm"><span>{t('topics.editIncludes')}</span><Textarea value={includes} disabled={saving} onChange={e=>setIncludes(e.target.value)}/></label><label className="block space-y-1 text-sm"><span>{t('topics.editExcludes')}</span><Textarea value={excludes} disabled={saving} onChange={e=>setExcludes(e.target.value)}/></label></div>
   {queries.map((q,i)=><label key={q.source_connection_id} className="block space-y-1 text-sm"><span>{t('topics.editQuery',{source:q.label})}</span><Textarea value={q.query} maxLength={1000} required disabled={saving} onChange={e=>setQueries(old=>old.map((v,n)=>n===i?{...v,query:e.target.value}:v))}/></label>)}
   {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
   <DialogFooter><Button variant="ghost" type="button" disabled={saving} onClick={onClose}>{t('topics.editCancel')}</Button><Button type="submit" disabled={saving||!base}>{t(saving?'topics.editSaving':'topics.editSave')}</Button></DialogFooter>
  </form>
 </DialogContent></Dialog>
}
