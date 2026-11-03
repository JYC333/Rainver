import {registerInMemoryResidue} from '../../../lib/sessionResidue'
import {useEffect,useState} from 'react'
import {useLocation,useSearchParams} from 'react-router-dom'
import {projectReadingApi} from '../../../api/client'
import {Button} from '../../../components/ui/button'
import {Card} from '../../../components/ui/card'
import {SpaceLink} from '../../../core/spaceNav'
import {useAppTranslation} from '../../../i18n'
import {formatDateTime,formatNumber} from '../../../i18n/format'
import {useReadingAction,useReadingResource} from './useReadingResource'
import {ReadingFeedback} from './ReadingFeedback'
import {DeepReadRequest,type DeepOperation} from './DeepReadRequest'
import {projectReaderHref} from '../../library/readingLinks'
const ACTIVE=['pending','queued','running','cancelling','settling','waiting_for_dependency','waiting_for_review']
export function DeepReadList({space,project,user}:{space:string;project:string;user:string}){
 const {t}=useAppTranslation();const {pathname,search}=useLocation();const back=pathname.replace(/^\/spaces\/[^/]+/,'')+search
 const [params,setParams]=useSearchParams();const raw=params.get('ops_offset')??'0';const offset=/^(?:[0-9]{1,4}|10000)$/.test(raw)?Number(raw):0
 const setOffset=(value:number|((n:number)=>number))=>{const next=new URLSearchParams(params),n=typeof value==='function'?value(offset):value;if(n)next.set('ops_offset',String(n));else next.delete('ops_offset');setParams(next)}
 const [request,setRequest]=useState<{op:DeepOperation;rerun:boolean}|null>(null)
 const read=useReadingResource(`${space}:${project}:${offset}`,signal=>projectReadingApi.operations(space,project,offset,{signal}));const action=useReadingAction()
 const [knownActive,setKnownActive]=useState<string[]>([]),[cancelRequested,setCancelRequested]=useState(false)
 useEffect(()=>{if(read.data)setKnownActive(read.data.items.filter(op=>ACTIVE.includes(op.status)).map(op=>op.id))},[read.data])
 useEffect(()=>registerInMemoryResidue(()=>{setKnownActive([]);setCancelRequested(false)}),[])
 const working=read.data?.items.some(i=>ACTIVE.includes(i.status));useEffect(()=>{if(!working)return;const id=setInterval(read.reload,5000);return()=>clearInterval(id)},[working,read.reload])
 return <section className="space-y-4" aria-label={t('projectReading.deep')}><p className="text-sm text-muted-foreground">{t('projectReading.privateHint')}</p>{read.data&&<p className="text-xs text-muted-foreground">{t('projectReading.deepLimits',{attempts:formatNumber(read.data.limits.attemptsPerInput),seconds:formatNumber(read.data.limits.runSeconds)})}</p>}<Button variant="ghost" size="sm" onClick={read.reload}>{t('reading.refresh')}</Button><ReadingFeedback error={read.error??action.error} loading={read.loading} retry={read.reload}/>
 {[403,404].includes((read.error as {status?:number})?.status??0)&&knownActive.length>0&&<Card className="space-y-2 p-4 text-sm"><p>{t('projectReading.cancelWithoutContent')}</p>{knownActive.map(id=><Button key={id} size="sm" variant="outline" disabled={action.busy} onClick={()=>void action.run(()=>projectReadingApi.cancel(space,project,id),()=>{setKnownActive(ids=>ids.filter(x=>x!==id));setCancelRequested(true)})}>{t('briefing.cancel')}</Button>)}</Card>}
 {cancelRequested&&<p role="status" className="text-sm text-muted-foreground">{t('projectReading.cancelRequested')}</p>}
 {!read.loading&&read.data?.items.length===0&&<Card className="p-5 text-sm">{t('projectReading.noDeep')}</Card>}
 {!action.denied&&read.data?.items.map(op=><Card key={op.id} className="space-y-3 p-4"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-semibold">{!op.withheld&&op.title&&<span className="block break-words">{op.title}</span>}{t('projectReading.reportVersion',{version:op.generation})}</h2><time className="text-xs text-muted-foreground">{formatDateTime(op.created_at)}</time></div>{!op.withheld&&<p className="text-sm">{t('projectReading.purpose')}: {op.purpose_version_id?op.purpose_label??t('projectReading.frozenPurposeUnavailable'):t('projectReading.ordinaryPurpose')}</p>}<p className="text-sm" role="status">{t(`projectReading.status.${op.status}`,{defaultValue:op.status})}{op.withheld&&` · ${t('projectReading.withheld')}`}</p>{!op.withheld&&op.error&&<p className="text-sm text-muted-foreground">{t('projectReading.failedHint')}</p>}
 <div className="flex flex-wrap gap-2">{op.report&&!op.withheld&&<><Button variant="outline" size="sm" asChild><SpaceLink to={projectReaderHref(project,op.item_id,back,op.report.snapshot_id)}>{t('projectReading.openReport')}</SpaceLink></Button><Button variant="ghost" size="sm" asChild><SpaceLink to={projectReaderHref(project,op.item_id,back,op.original?.snapshot_id)}>{t(op.original?'projectReading.openOriginal':'projectReading.currentDocument')}</SpaceLink></Button></>}
 {ACTIVE.includes(op.status)&&<Button variant="outline" size="sm" disabled={action.busy||op.status==='cancelling'||op.status==='settling'} onClick={()=>void action.run(()=>projectReadingApi.cancel(space,project,op.id),read.reload)}>{t('briefing.cancel')}</Button>}
 {!op.withheld&&['failed','cancelled','completed'].includes(op.status)&&op.generation<3&&<Button variant="ghost" size="sm" onClick={()=>setRequest({op,rerun:op.status==='completed'})}>{t(op.status==='completed'?'projectReading.rerun':'reading.retry')}</Button>}
 </div>{!op.withheld&&!op.original&&<p className="text-xs text-muted-foreground">{t('projectReading.originalUnknown')}</p>}{!op.withheld&&op.effective_run_seconds&&<p className="text-xs text-muted-foreground">{t('projectReading.effectiveTime',{seconds:formatNumber(op.effective_run_seconds)})}</p>}{op.source_configuration_changed&&<p className="text-xs text-muted-foreground">{t('projectReading.configChanged')}</p>}</Card>)}
 <div className="flex gap-2"><Button variant="outline" size="sm" disabled={!offset||read.loading} onClick={()=>setOffset(n=>Math.max(0,n-25))}>{t('reading.previousItem')}</Button><Button variant="outline" size="sm" disabled={read.data?.next_offset==null||read.loading} onClick={()=>setOffset(read.data!.next_offset!)}>{t('reading.nextItem')}</Button></div>
 {request&&<DeepReadRequest space={space} project={project} user={user} item={request.op.item_id} previous={request.op} rerun={request.rerun} onClose={()=>setRequest(null)} onStarted={()=>{setRequest(null);read.reload()}}/>}
 </section>
}
