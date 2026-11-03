import {useState} from 'react'
import {projectReadingApi} from '../../../api/client'
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from '../../../components/ui/dialog'
import {Button} from '../../../components/ui/button'
import {SpaceLink} from '../../../core/spaceNav'
import {useAppTranslation} from '../../../i18n'
import {formatDateTime} from '../../../i18n/format'
import {formatDigestDate} from '../../library/DigestDay'
import {useReadingResource} from './useReadingResource'
import {ReadingFeedback} from './ReadingFeedback'
export function ReadingHistory({space,project}:{space:string;project:string}){
 const {t}=useAppTranslation(),[open,setOpen]=useState(false)
 return <><Button size="sm" variant="ghost" onClick={()=>setOpen(true)}>{t('projectReading.browseHistory')}</Button><Dialog open={open} onOpenChange={setOpen}><DialogContent><DialogHeader><DialogTitle>{t('projectReading.browseHistory')}</DialogTitle><DialogDescription>{t('projectReading.archiveHint')}</DialogDescription></DialogHeader>{open&&<HistoryPage space={space} project={project} close={()=>setOpen(false)}/>}</DialogContent></Dialog></>
}
function HistoryPage({space,project,close}:{space:string;project:string;close:()=>void}){
 const {t,locale}=useAppTranslation(),[cursors,setCursors]=useState<Array<string|undefined>>([undefined]),cursor=cursors[cursors.length-1]
 const read=useReadingResource(`${space}:${project}:${cursor??''}`,signal=>projectReadingApi.history(space,project,cursor,{signal}))
 return <div className="max-h-[65dvh] space-y-3 overflow-y-auto"><ReadingFeedback loading={read.loading} error={read.error} retry={read.reload}/>
  {read.data?.items.length===0&&<p className="text-sm text-muted-foreground">{t('projectReading.historyEmpty')}</p>}
  <ul className="divide-y divide-border">{read.data?.items.map(entry=>{
   const params=new URLSearchParams({tab:'overview'});if(entry.date)params.set('date',entry.date)
   if(entry.kind==='edition')params.set('composition',entry.id)
   else{params.set('archive','theme');params.set('briefing',entry.id)}
   return <li key={`${entry.kind}:${entry.id}`} className="py-3"><SpaceLink onClick={close} className="block space-y-1 text-sm underline-offset-2 hover:underline" to={`/projects/${project}/sources?${params}`}>
    <span className="block font-medium">{entry.date?formatDigestDate(entry.date,locale):t('projectReading.fullAnalysis')} · {t(`projectReading.archiveKind.${entry.kind}`)}{entry.revision&&` · ${t('projectReading.version',{version:entry.revision})}`}</span>
    <span className="block text-xs text-muted-foreground">{formatDateTime(entry.created_at)}</span>
   </SpaceLink></li>
  })}</ul>
  <div className="flex justify-between gap-2"><Button size="sm" variant="ghost" disabled={cursors.length===1||read.loading} onClick={()=>setCursors(c=>c.slice(0,-1))}>{t('projectReading.newerHistory')}</Button><Button size="sm" variant="outline" disabled={!read.data?.next_cursor||read.loading} onClick={()=>setCursors(c=>[...c,read.data!.next_cursor!])}>{t('projectReading.olderHistory')}</Button></div>
 </div>
}
