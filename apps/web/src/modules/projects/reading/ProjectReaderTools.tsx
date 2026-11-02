import {useEffect,useState} from 'react'
import {projectReadingApi} from '../../../api/client'
import {Button} from '../../../components/ui/button'
import {Select} from '../../../components/ui/select'
import {SpaceLink} from '../../../core/spaceNav'
import {useAppTranslation} from '../../../i18n'
import {formatDateTime} from '../../../i18n/format'
import {useReadingResource,useReadingAction} from './useReadingResource'
import {ReadingFeedback} from './ReadingFeedback'
import {DeepReadRequest} from './DeepReadRequest'
export function ProjectReaderTools({space,user,project,item,version,currentArtifact,onChoose,onDenied}:{space:string;user:string;project:string;item:string;version:string|null;currentArtifact:string|null;onChoose:(v:string|null)=>void;onDenied:(e:unknown)=>void}){
 const {t}=useAppTranslation();const action=useReadingAction();const [offset,setOffset]=useState(0);const [request,setRequest]=useState(false),[started,setStarted]=useState(false)
 const read=useReadingResource(`${space}:${user}:${project}:${item}:${offset}`,async signal=>{
  try{return await projectReadingApi.records(space,project,item,offset,{signal})}catch(e){if([401,403,404].includes((e as {status:number})?.status)&&!signal.aborted)onDenied(e);throw e}
 });const favorite=useReadingResource(`${space}:${user}:${project}:${item}`,signal=>projectReadingApi.favoriteStatus(space,project,item,{signal}))
 useEffect(()=>{if(action.denied)onDenied(action.error)},[action.denied])
 const exact=useReadingResource(`${space}:${user}:${project}:${item}:${version}`,async signal=>{
  if(!version)return null
  try{const result=await projectReadingApi.record(space,project,item,version,{signal});if(!result.items.some(r=>r.snapshot_id===version))throw Object.assign(new Error(t('reading.documentMissing')),{status:404});return result}
  catch(e){if([401,403,404].includes((e as {status:number})?.status)&&!signal.aborted)onDenied(e);throw e}
 })
 const records=read.data,selected=exact.data?.items.find(r=>r.snapshot_id===version)??read.data?.items.find(r=>r.snapshot_id===version)
 const frozenOriginal=selected?.role==='analysis'?selected.original_snapshot_id:null

 return <div className="reading-touch mx-4 mt-3 space-y-3 rounded-lg border border-border bg-card p-3 text-sm" aria-label={t('projectReading.readerTools')}>
 <ReadingFeedback error={read.error??exact.error??favorite.error??action.error} loading={read.loading} retry={()=>{read.reload();exact.reload();favorite.reload()}}/>
 {started&&<p role="status">{t('projectReading.requestSaved')}</p>}
 {records&&<><p className="text-xs text-muted-foreground">{t(selected?.role==='analysis'&&!frozenOriginal?'projectReading.originalUnknown':records.original?'projectReading.originalRetained':'projectReading.originalUnknown')}</p><div className="flex flex-wrap items-center gap-2">
 {(frozenOriginal||records.original)&&<Button size="sm" variant="outline" onClick={()=>onChoose(frozenOriginal??(currentArtifact===records.original!.artifact_id?null:records.original!.snapshot_id))}>{t(frozenOriginal?'projectReading.originalUsed':version?'projectReading.latestOriginal':'projectReading.openOriginal')}</Button>}
 <Select ariaLabel={t('projectReading.reportHistory')} value={version??''} onChange={v=>onChoose(v||null)} options={[{value:'',label:t('projectReading.currentDocument')},...records.items.map(v=>({value:v.snapshot_id,label:`${t(v.role==='original'?'projectReading.openOriginal':v.role==='analysis'?'projectReading.openReport':'projectReading.legacyAnalysis')} · ${formatDateTime(v.captured_at)}`}))]}/>
 <Button size="sm" variant="ghost" disabled={action.busy||!favorite.data} aria-pressed={favorite.data?.favorite??false} onClick={()=>void action.run(()=>projectReadingApi.favorite(space,project,item,!favorite.data!.favorite),favorite.reload)}>{t(favorite.data?.favorite?'projectReading.unfavorite':'projectReading.favorite')}</Button>
 <Button size="sm" variant="outline" onClick={()=>setRequest(true)}>{t('projectReading.request')}</Button><Button size="sm" variant="ghost" asChild><SpaceLink to={`/projects/${project}/sources?tab=deep`}>{t('projectReading.allReports')}</SpaceLink></Button>
 </div>{(offset>0||records.next_offset!=null)&&<div className="mt-2 flex flex-wrap gap-2"><Button size="sm" variant="ghost" disabled={read.loading||offset===0} onClick={()=>setOffset(Math.max(0,offset-25))}>{t('reading.previousItem')}</Button><Button size="sm" variant="ghost" disabled={read.loading||records.next_offset==null} onClick={()=>setOffset(records.next_offset!)}>{t('projectReading.moreReportHistory')}</Button></div>}</>}
 {request&&<DeepReadRequest space={space} project={project} user={user} item={item} onClose={()=>setRequest(false)} onStarted={()=>{setRequest(false);setStarted(true);read.reload()}}/>}
 </div>
}
