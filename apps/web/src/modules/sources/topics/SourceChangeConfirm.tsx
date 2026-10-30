import {useEffect,useState} from 'react'
import type {SourceGoalBindingReconfirmation} from '@rainver/protocol'
import {ApiRequestError,sourceGoalsApi} from '../../../api/client'
import {Button} from '../../../components/ui/button'
import {Dialog,DialogContent,DialogDescription,DialogFooter,DialogHeader,DialogTitle} from '../../../components/ui/dialog'
import {useAppTranslation} from '../../../i18n'
import {formatDateTime} from '../../../i18n/format'
import {errMsg} from '../../../lib/utils'

/** Server refusals the person can act on; anything else shows the server's message. */
const REFUSALS=new Set(['source_scope_changed','source_binding_changed','source_binding_not_blocked','source_binding_not_active'])

/**
 * A topic source stopped because its Source changed since the topic was
 * confirmed. Shows the Source as it is now (and what changed, when that was
 * recorded) and confirms exactly that: the request carries the binding
 * revision and the state token shown, and the server re-checks every gate.
 */
export function SourceChangeConfirm({goalId,bindingId,spaceId,act,disabled}:{goalId:string;bindingId:string;spaceId:string;act:(action:()=>Promise<unknown>)=>Promise<void>;disabled:boolean}){
 const {t}=useAppTranslation()
 const [open,setOpen]=useState(false)
 const [view,setView]=useState<SourceGoalBindingReconfirmation|null>(null)
 const [error,setError]=useState<string|null>(null)
 const [sending,setSending]=useState(false)
 const [attempt,setAttempt]=useState(0)
 useEffect(()=>{
  if(!open)return
  const controller=new AbortController();setView(null)
  sourceGoalsApi.sourceConfirmation(goalId,bindingId,{spaceId,signal:controller.signal}).then(setView).catch(e=>{if(!controller.signal.aborted)setError(errMsg(e))})
  return()=>controller.abort()
 },[open,goalId,bindingId,spaceId,attempt])
 const value=(key:string,raw:string|boolean|null)=>raw===null?t('topics.sourceChange.unset'):typeof raw==='boolean'?t(raw?'topics.sourceChange.yes':'topics.sourceChange.no'):t(`topics.sourceChange.value.${key}.${raw}`,{defaultValue:raw})
 async function confirm(){
  if(!view?.authority||sending)return
  setSending(true);setError(null)
  try{
   await sourceGoalsApi.confirmSource(goalId,bindingId,{binding_revision:view.binding_revision,authority:view.authority},{spaceId})
   setOpen(false)
   // The topic reloads through the page's own action (one at a time, with its error handling).
   await act(()=>Promise.resolve())
  }catch(e){
   // Refused: stay here and say why. Something changed since it was shown (409): show the current state to decide again.
   const code=e instanceof ApiRequestError?String(e.code??e.payload?.error??''):''
   setError(REFUSALS.has(code)?t(`topics.sourceChange.refused.${code}`):errMsg(e))
   if(e instanceof ApiRequestError&&e.status===409)setAttempt(n=>n+1)
  }finally{setSending(false)}
 }
 return <>
  <Button size="sm" variant="outline" disabled={disabled} onClick={()=>setOpen(true)}>{t('topics.sourceChange.review')}</Button>
  <Dialog open={open} onOpenChange={next=>{setOpen(next);if(next)setError(null)}}>
   <DialogContent>
    <DialogHeader>
     <DialogTitle>{t('topics.sourceChange.title')}</DialogTitle>
     <DialogDescription>{t('topics.sourceChange.why')}</DialogDescription>
    </DialogHeader>
    {!view&&!error&&<p role="status" className="text-sm text-muted-foreground">{t('topics.sourceChange.loading')}</p>}
    {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
    {view&&view.resolvable_by!=='you'&&<p className="text-sm">{t(`topics.sourceChange.notYours.${view.resolvable_by}`)}</p>}
    {view?.current&&<div className="space-y-3 text-sm">
     <p className="font-medium">{view.source_name}</p>
     <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
      {(['capture_policy','retention_policy','source_status','uses_credential'] as const).map(key=><div key={key} className="contents"><dt className="text-muted-foreground">{t(`topics.sourceChange.field.${key}`)}</dt><dd>{value(key,view.current![key])}</dd></div>)}
     </dl>
     {view.changed?<p>{view.changed.length?t('topics.sourceChange.changed',{fields:view.changed.map(key=>t(`topics.sourceChange.field.${key}`,{defaultValue:t('topics.sourceChange.field.other')})).filter((v,i,a)=>a.indexOf(v)===i).join(', ')}):t('topics.sourceChange.changedUnknown')}</p>
      :<p className="text-muted-foreground">{t('topics.sourceChange.notRecorded')}</p>}
     {view.related_changes.length>0&&<ul className="list-disc space-y-1 pl-5">{view.related_changes.map(c=><li key={c.kind+c.at}>{t(`topics.sourceChange.related.${c.kind}`,{defaultValue:c.kind})} · {formatDateTime(c.at)}</li>)}</ul>}
     <p className="text-muted-foreground">{t('topics.sourceChange.effect')}</p>
    </div>}
    <DialogFooter>
     <Button variant="ghost" onClick={()=>setOpen(false)}>{t('topics.sourceChange.keepStopped')}</Button>
     {view?.resolvable_by==='you'&&<Button disabled={disabled||sending||!view.authority} onClick={()=>void confirm()}>{t('topics.sourceChange.confirm')}</Button>}
    </DialogFooter>
   </DialogContent>
  </Dialog>
 </>
}
