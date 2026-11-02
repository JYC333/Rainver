import {useState} from 'react'
import type {ProjectDeepReadOperation} from '@rainver/protocol'
import {projectReadingApi} from '../../../api/client'
import {AgentExecutionPicker,type AgentExecutionSelection} from '../../../components/agents/AgentExecutionPicker'
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from '../../../components/ui/dialog'
import {Button} from '../../../components/ui/button'
import {Select} from '../../../components/ui/select'
import {useAppTranslation} from '../../../i18n'
import {useReadingResource,useReadingAction} from './useReadingResource'
import {ReadingFeedback} from './ReadingFeedback'
export type DeepOperation=ProjectDeepReadOperation
const choiceKey=(c:{goal_id:string;version_id:string;connection_id:string})=>`${c.goal_id}:${c.version_id}:${c.connection_id}`
export function DeepReadRequest({space,project,user,item,previous,rerun,onClose,onStarted}:{space:string;project:string;user:string;item:string;previous?:DeepOperation;rerun?:boolean;onClose:()=>void;onStarted:()=>void}){
 const {t}=useAppTranslation();const action=useReadingAction();const purposes=useReadingResource(`${space}:${project}:${item}`,signal=>projectReadingApi.purposes(space,project,item,{signal}))
 const [purpose,setPurpose]=useState(previous?.following?choiceKey(previous.following):previous?.purpose_version_id??'');const [custom,setCustom]=useState(!!previous?.execution);const [execution,setExecution]=useState<AgentExecutionSelection>(previous?.execution??{agent_id:'',runtime_profile_id:''})
 return <Dialog open onOpenChange={v=>{if(!v&&!action.busy)onClose()}}><DialogContent className="reading-touch max-h-[90dvh] overflow-y-auto"><DialogHeader><DialogTitle>{t('projectReading.request')}</DialogTitle><DialogDescription>{t('projectReading.privateHint')}</DialogDescription></DialogHeader>
  <ReadingFeedback error={purposes.error??action.error} loading={purposes.loading} retry={purposes.reload}/>
  <label className="space-y-2 text-sm"><span>{t('projectReading.purpose')}</span><Select disabled={action.busy||!!previous} value={purpose} onChange={setPurpose} ariaLabel={t('projectReading.purpose')} options={[{value:'',label:t('projectReading.ordinaryPurpose')},...(purposes.data?.choices??[]).map(c=>({value:choiceKey(c),label:c.label}))]}/></label>
  {purposes.data?.truncated&&<p className="text-xs text-muted-foreground">{t('projectReading.purposeBound')}</p>}
  <p className="text-xs text-muted-foreground">{t('projectReading.cost')}</p>
  <details open={custom} onToggle={e=>{if(!action.busy)setCustom(e.currentTarget.open)}}><summary className="cursor-pointer text-sm font-medium">{t('reading.executionSettings')}</summary>{custom&&<div className="mt-3"><AgentExecutionPicker spaceId={space} userId={user} value={execution} onChange={setExecution} disabled={action.busy}/></div>}</details>
  <Button disabled={action.busy||purposes.loading||!!purposes.error||custom&&(!execution.agent_id||!execution.runtime_profile_id)} onClick={()=>void action.run(async()=>{
   const choices=purposes.data?.choices??[];const legacy=previous&&!previous.following?choices.filter(c=>c.version_id===purpose):[];const chosen=choices.find(c=>choiceKey(c)===purpose)??(legacy.length===1?legacy[0]:undefined);if(purpose&&!chosen)throw new Error(t('projectReading.purposeChanged'))
   const result=await projectReadingApi.start(space,project,item,{...(custom?execution:{}),following:chosen?{goal_id:chosen.goal_id,version_id:chosen.version_id,connection_id:chosen.connection_id}:null,...(previous?{[rerun?'rerun_of':'retry_of']:previous.id}:{})});
   if(result.status==='needs_consent')throw new Error(t('projectReading.needsConsent'))
   if(!result.processing_id)throw new Error(t('projectReading.setup'))
  },onStarted)}>{t(previous?rerun?'projectReading.rerun':'reading.retry':'projectReading.request')}</Button>
 </DialogContent></Dialog>
}
