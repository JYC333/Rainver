import {useRef,useState} from 'react'
import {sourcesApi} from '../../api/client'
import type {SourceItem} from '../../types/api'
import {useAppTranslation} from '../../i18n'
import {SpaceLink} from '../../core/spaceNav'
import {spacePath} from '../../core/navigation'
import {safeHttpUrl} from '../../lib/safeHttpUrl'
import {errMsg} from '../../lib/utils'
import {Button} from '../../components/ui/button'
import {Input} from '../../components/ui/input'
import {Dialog,DialogContent,DialogDescription,DialogFooter,DialogHeader,DialogTitle} from '../../components/ui/dialog'
import {readingHref} from './readingLinks'
import {MaterialProcessingPanel} from './MaterialProcessingPanel'

/** Save one canonical link, then use the same preparation operation as an old
 * item. The dialog never runs a browser-side extraction job. */
export function SaveReadingUrlDialog({spaceId,projectId,onClose}:{spaceId:string;projectId?:string;onClose:(changed:boolean)=>void}){
 const {t}=useAppTranslation();const [url,setUrl]=useState('');const [title,setTitle]=useState('');const [saved,setSaved]=useState<SourceItem|null>(null);const [busy,setBusy]=useState(false);const [error,setError]=useState<unknown>(null);const locked=useRef(false);
 const materials=projectId?`/projects/${projectId}/sources?view=all`:'/library/reading?view=all';
 async function save(){if(locked.current||!safeHttpUrl(url))return;locked.current=true;setBusy(true);setError(null);try{
  const row=await sourcesApi.createManualUrl({url:url.trim(),title:title.trim()||undefined,...(projectId?{project_id:projectId}:{}),queue_content:false},{spaceId});
  // Start preparation before mounting its panel, so the panel's first read
  // observes the queued operation instead of a stale idle state.
  try{await sourcesApi.prepareMaterial(row.id,{}, {spaceId:row.space_id})}catch(e){setError(e)}
  setSaved(row);
 }catch(e){setError(e)}finally{locked.current=false;setBusy(false)}}
 return <Dialog open onOpenChange={open=>{if(!open&&!busy)onClose(!!saved)}}><DialogContent className="max-h-[90dvh] overflow-y-auto" showClose={!busy}>
  <DialogHeader><DialogTitle>{t(saved?'reading.startArticleSaved':'reading.startSaveArticle')}</DialogTitle><DialogDescription>{t(projectId?'reading.startProjectSaveHint':'reading.startPersonalSaveHint')}</DialogDescription></DialogHeader>
  {!saved?<form className="space-y-4" onSubmit={e=>{e.preventDefault();void save()}}><label className="block space-y-1 text-sm"><span>{t('reading.startArticleUrl')}</span><Input aria-label={t('reading.startArticleUrl')} type="url" required value={url} onChange={e=>setUrl(e.target.value)} disabled={busy}/></label><label className="block space-y-1 text-sm"><span>{t('reading.startArticleTitle')}</span><Input aria-label={t('reading.startArticleTitle')} value={title} onChange={e=>setTitle(e.target.value)} disabled={busy}/></label>{error!=null&&<p role="alert" className="text-destructive">{errMsg(error)}</p>}<DialogFooter><Button type="submit" disabled={busy||!safeHttpUrl(url)}>{t('reading.saveAndPrepare')}</Button></DialogFooter></form>:<div className="space-y-3">
   <p className="break-words text-sm font-medium">{saved.title}</p>{error!=null&&<p role="alert" className="text-destructive">{errMsg(error)}</p>}<MaterialProcessingPanel itemId={saved.id} spaceId={saved.space_id} hasContent={saved.content_state==='content_saved'} onReady={async()=>{setSaved(await sourcesApi.getItem(saved.id,{spaceId:saved.space_id}))}}/>
   <DialogFooter><Button variant="ghost" onClick={()=>onClose(true)}>{t('reading.startClose')}</Button><Button asChild><SpaceLink to={spacePath(saved.space_id,readingHref({source_item_id:saved.id,reader_origin:projectId?'project':'library'},projectId))}>{t('reading.startOpenReader')}</SpaceLink></Button><Button variant="outline" asChild><SpaceLink to={spacePath(saved.space_id,materials)}>{t('reading.startViewAllMaterial')}</SpaceLink></Button></DialogFooter>
  </div>}
 </DialogContent></Dialog>
}
