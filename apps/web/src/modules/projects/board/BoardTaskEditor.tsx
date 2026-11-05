import { useEffect, useState } from 'react'
import { tasksApi } from '../../../api/client'
import type { ProjectBoardCard } from '../../../types/api'
import { useAppTranslation } from '../../../i18n'
import { Button } from '../../../components/ui/button'
import { Input } from '../../../components/ui/input'
import { Textarea } from '../../../components/ui/textarea'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../../../components/ui/dialog'
import { errMsg } from '../../../lib/utils'

export default function BoardTaskEditor({card,mode,onClose,onSaved}:{card:ProjectBoardCard;mode:'edit'|'delete';onClose:()=>void;onSaved:()=>void}) {
  const {t}=useAppTranslation()
  const [title,setTitle]=useState(card.title)
  const [description,setDescription]=useState('')
  const [loading,setLoading]=useState(mode==='edit')
  const [busy,setBusy]=useState(false)
  const [error,setError]=useState('')
  useEffect(()=>{if(mode!=='edit')return;let current=true;void tasksApi.get(card.id).then(task=>{if(current){setTitle(task.title);setDescription(task.description??'');setLoading(false)}}).catch(e=>{if(current)setError(errMsg(e))});return()=>{current=false}},[card.id,mode])
  return <Dialog open onOpenChange={open=>{if(!open&&!busy)onClose()}}><DialogContent>
    <DialogHeader><DialogTitle>{t(mode==='delete'?'board_ui.delete_title':'board_ui.edit')}</DialogTitle><DialogDescription>{mode==='delete'?t('board_ui.delete_text',{title:card.title}):card.title}</DialogDescription></DialogHeader>
    {mode==='edit'&&<div className="space-y-3"><label className="block space-y-1 text-sm"><span>{t('board_ui.title')}</span><Input maxLength={512} value={title} disabled={loading||busy} onChange={e=>setTitle(e.target.value)}/></label><label className="block space-y-1 text-sm"><span>{t('board_ui.description')}</span><Textarea value={description} disabled={loading||busy} onChange={e=>setDescription(e.target.value)}/></label></div>}
    {error&&<p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
    <div className="mt-5 flex justify-end gap-2"><Button variant="outline" disabled={busy} onClick={onClose}>{t('board_ui.cancel')}</Button><Button variant={mode==='delete'?'destructive':'default'} disabled={loading||busy||!title.trim()} onClick={async()=>{setBusy(true);setError('');try{if(mode==='delete')await tasksApi.delete(card.id);else await tasksApi.update(card.id,{title:title.trim(),description:description||null});onSaved()}catch(e){setError(errMsg(e))}finally{setBusy(false)}}}>{t(busy?(mode==='delete'?'board_ui.deleting':'board_ui.saving'):(mode==='delete'?'board_ui.delete':'board_ui.save'))}</Button></div>
  </DialogContent></Dialog>
}
