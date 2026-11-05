import { useRef, useState } from 'react'
import { MoreHorizontal } from 'lucide-react'
import type { ProjectBoardColumn } from '../../../types/api'
import { useAppTranslation } from '../../../i18n'
import { Button } from '../../../components/ui/button'
import { Input } from '../../../components/ui/input'
import { Select } from '../../../components/ui/select'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '../../../components/ui/dropdown-menu'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../../../components/ui/dialog'
import { errMsg } from '../../../lib/utils'

export function BoardColumnName({column,disabled,onRename}:{column:ProjectBoardColumn;disabled:boolean;onRename:(name:string)=>Promise<void>}) {
  const {t}=useAppTranslation()
  const [editing,setEditing]=useState(false)
  const [name,setName]=useState(column.label)
  const [error,setError]=useState('')
  const original=useRef(column.label)
  const pending=useRef(false)
  const cancelBlur=useRef(false)
  async function finish(){
    if(pending.current||cancelBlur.current||disabled)return
    const next=name.trim()
    if(!next||next===original.current){setEditing(false);setError('');return}
    pending.current=true
    setError('')
    try{await onRename(next);setEditing(false)}
    catch(e){setError(errMsg(e))}
    finally{pending.current=false}
  }
  if(!editing)return <Button variant="ghost" size="sm" className="min-w-0 flex-1 justify-start truncate border border-transparent px-1 font-medium" disabled={disabled} aria-label={t('board_ui.rename_column',{name:column.label})} onClick={()=>{original.current=column.label;cancelBlur.current=false;setName(column.label);setError('');setEditing(true)}}>{column.label}</Button>
  return <div className="min-w-0 flex-1 space-y-1">
    <Input className="h-7 min-w-0 px-1 py-0 text-xs font-medium" autoFocus maxLength={256} aria-label={t('board_ui.name')} aria-invalid={Boolean(error)} value={name} disabled={disabled}
      onFocus={event=>event.currentTarget.select()} onChange={event=>setName(event.target.value)} onBlur={()=>void finish()}
      onKeyDown={event=>{
        event.stopPropagation()
        if(event.key==='Enter'){event.preventDefault();event.currentTarget.blur()}
        if(event.key==='Escape'){event.preventDefault();cancelBlur.current=true;setEditing(false);setError('')}
      }}/>
    {error&&<p role="alert" className="text-xs text-destructive">{error}</p>}
  </div>
}

export function BoardColumnMeaning({column,disabled,canWrite,onChange}:{column:ProjectBoardColumn;disabled:boolean;canWrite:boolean;onChange:(status:string)=>Promise<void>}) {
  const {t}=useAppTranslation()
  const [next,setNext]=useState<string|null>(null)
  const [error,setError]=useState('')
  return <>
    <div className="space-y-1 text-xs text-muted-foreground"><span>{t('board_ui.meaning')}</span>{canWrite?<Select ariaLabel={t('board_ui.meaning_for',{name:column.label})} size="sm" disabled={disabled} value={column.status_key} onChange={value=>{if(value!==column.status_key){setError('');setNext(value)}}} options={['inbox','ready','in_progress','waiting_for_review','blocked','done'].map(value=>({value,label:t(`board_ui.${value}`)}))}/>:<span className="ml-2">{t(`board_ui.${column.status_key}`)}</span>}</div>
    <Dialog open={next!==null} onOpenChange={open=>{if(!open&&!disabled)setNext(null)}}><DialogContent><DialogHeader><DialogTitle>{t('board_ui.remap_title',{name:column.label})}</DialogTitle><DialogDescription>{t('board_ui.remap_help')}</DialogDescription></DialogHeader>
      <p className="text-sm">{t(`board_ui.${column.status_key}`)} → {next&&t(`board_ui.${next}`)}</p>
      {error&&<p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
      <div className="mt-5 flex justify-end gap-2"><Button variant="outline" disabled={disabled} onClick={()=>setNext(null)}>{t('board_ui.cancel')}</Button><Button disabled={disabled} onClick={()=>{if(next)void onChange(next).then(()=>setNext(null)).catch(e=>setError(errMsg(e)))}}>{t(disabled?'board_ui.saving':'board_ui.save')}</Button></div>
    </DialogContent></Dialog>
  </>
}

export function BoardColumnMenu({column,disabled,canDelete,canAdd,onAdd,onDelete}:{column:ProjectBoardColumn;disabled:boolean;canDelete:boolean;canAdd:boolean;onAdd:()=>void;onDelete:()=>void}) {
  const {t}=useAppTranslation()
  const opening=useRef(false)
  return <DropdownMenu><DropdownMenuTrigger asChild><Button size="icon" variant="ghost" className="size-7 shrink-0" disabled={disabled} aria-label={t('board_ui.column_actions',{name:column.label})}><MoreHorizontal className="size-4"/></Button></DropdownMenuTrigger>
    <DropdownMenuContent align="end" onCloseAutoFocus={event=>{if(opening.current){event.preventDefault();opening.current=false}}}><DropdownMenuItem disabled={!canAdd} onSelect={()=>{opening.current=true;onAdd()}}>{t('board_ui.add_after')}</DropdownMenuItem><DropdownMenuItem className="text-destructive" disabled={!canDelete} onSelect={()=>{opening.current=true;onDelete()}}>{t('board_ui.remove')}</DropdownMenuItem></DropdownMenuContent>
  </DropdownMenu>
}

export function BoardColumnDraft({disabled,onCreate,onCancel}:{disabled:boolean;onCreate:(name:string,status:string)=>Promise<void>;onCancel:()=>void}) {
  const {t}=useAppTranslation()
  const [name,setName]=useState('')
  const [status,setStatus]=useState('ready')
  const [error,setError]=useState('')
  return <form aria-label={t('board_ui.add')} className="self-start space-y-3 rounded-xl border border-border bg-card p-3" onSubmit={event=>{event.preventDefault();if(!name.trim()||disabled)return;void onCreate(name.trim(),status).catch(e=>setError(errMsg(e)))}}>
    <label className="block space-y-1 text-sm"><span>{t('board_ui.name')}</span><Input autoFocus maxLength={256} value={name} disabled={disabled} onChange={e=>setName(e.target.value)}/></label>
    <div className="space-y-1 text-sm"><span>{t('board_ui.meaning')}</span><Select ariaLabel={t('board_ui.meaning')} value={status} disabled={disabled} onChange={setStatus} options={['inbox','ready','in_progress','waiting_for_review','blocked','done'].map(value=>({value,label:t(`board_ui.${value}`)}))}/></div>
    <p className="text-xs text-muted-foreground">{t('board_ui.meaning_help')}</p>
    {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="flex gap-2"><Button type="submit" size="sm" disabled={disabled||!name.trim()}>{t(disabled?'board_ui.saving':'board_ui.add')}</Button><Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={onCancel}>{t('board_ui.cancel')}</Button></div>
  </form>
}

export function BoardColumnRemoval({column,columns,disabled,onDelete,onClose}:{column:ProjectBoardColumn;columns:ProjectBoardColumn[];disabled:boolean;onDelete:(target:string)=>Promise<void>;onClose:()=>void}) {
  const {t}=useAppTranslation()
  const [target,setTarget]=useState('')
  const [error,setError]=useState('')
  const destinations=columns.filter(c=>c.status_key&&c.key!==column.key)
  return <Dialog open onOpenChange={open=>{if(!open&&!disabled)onClose()}}><DialogContent>
    <DialogHeader><DialogTitle>{t('board_ui.remove_named',{name:column.label})}</DialogTitle><DialogDescription>{t('board_ui.delete_help')}</DialogDescription></DialogHeader>
    <p className="mb-2 text-sm">{t('board_ui.removed',{name:column.label})}</p>
    <Select ariaLabel={t('board_ui.destination')} value={target} disabled={disabled} onChange={setTarget} options={[{value:'',label:t('board_ui.destination'),disabled:true},...destinations.map(c=>({value:c.key,label:c.label}))]}/>
    {error&&<p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
    <div className="mt-5 flex justify-end gap-2"><Button variant="outline" disabled={disabled} onClick={onClose}>{t('board_ui.cancel')}</Button><Button variant="destructive" disabled={disabled||!destinations.some(c=>c.key===target)} onClick={()=>void onDelete(target).catch(e=>setError(errMsg(e)))}>{t(disabled?'board_ui.saving':'board_ui.remove')}</Button></div>
  </DialogContent></Dialog>
}
