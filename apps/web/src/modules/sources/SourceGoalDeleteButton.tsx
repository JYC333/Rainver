import {useState} from 'react'
import {sourceGoalsApi} from '../../api/client'
import {useAppTranslation} from '../../i18n'
import {Button} from '../../components/ui/button'
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription,DialogFooter} from '../../components/ui/dialog'
/** Uses the canonical goal deletion; collected material is retained. */
export function SourceGoalDeleteButton({goalId,spaceId,disabled,onDeleted}:{goalId:string;spaceId:string;disabled?:boolean;onDeleted:()=>void|Promise<void>}){
 const {t}=useAppTranslation();const [open,setOpen]=useState(false);const [busy,setBusy]=useState(false);const [failed,setFailed]=useState(false)
 async function remove(){setBusy(true);setFailed(false);try{await sourceGoalsApi.action(goalId,'delete',{}, {spaceId});setOpen(false);await onDeleted()}catch{setFailed(true)}finally{setBusy(false)}}
 return <><Button variant="ghost" size="sm" disabled={disabled} onClick={()=>setOpen(true)}>{t('sourceGoals.deleteGoal')}</Button><Dialog open={open} onOpenChange={v=>{if(!busy)setOpen(v)}}><DialogContent showClose={!busy}><DialogHeader><DialogTitle>{t('sourceGoals.deleteGoal')}</DialogTitle><DialogDescription>{t('sourceGoals.deleteGoalHint')}</DialogDescription></DialogHeader>{failed&&<p role="alert" className="text-sm text-destructive">{t('sourceGoals.deleteGoalFailed')}</p>}<DialogFooter><Button variant="outline" disabled={busy} onClick={()=>setOpen(false)}>{t('sourceGoals.keepGoal')}</Button><Button variant="destructive" disabled={busy} onClick={()=>void remove()}>{t('sourceGoals.deleteGoal')}</Button></DialogFooter></DialogContent></Dialog></>
}
