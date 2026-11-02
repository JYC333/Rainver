import {useState} from 'react'
import {projectReadingApi} from '../../../api/client'
import {Button} from '../../../components/ui/button'
import {Card} from '../../../components/ui/card'
import {AgentExecutionPicker,type AgentExecutionSelection} from '../../../components/agents/AgentExecutionPicker'
import {useAppTranslation} from '../../../i18n'
import {useReadingAction,useReadingResource} from './useReadingResource'
import {ReadingFeedback} from './ReadingFeedback'
export function ThemeAnalysis({space,user,goal,version,canManage}:{space:string;user:string;goal:string;version:string|null;canManage:boolean}){
 const {t}=useAppTranslation();const [open,setOpen]=useState(false)
 return <details onToggle={e=>setOpen(e.currentTarget.open)} className="mt-3 border-t border-border pt-3"><summary className="cursor-pointer text-sm font-medium">{t('projectReading.analysisSettings')}</summary>{open&&<Analysis key={`${space}:${user}:${goal}:${version}`} space={space} user={user} goal={goal} version={version} canManage={canManage}/>}</details>
}
function Analysis({space,user,goal,version,canManage}:{space:string;user:string;goal:string;version:string|null;canManage:boolean}){
 const {t}=useAppTranslation();const read=useReadingResource(`${space}:${goal}`,signal=>projectReadingApi.themes(goal,{spaceId:space,signal}));const action=useReadingAction();const [execution,setExecution]=useState<AgentExecutionSelection>({agent_id:'',runtime_profile_id:''});const [confirm,setConfirm]=useState(false)
 const enabled=!!read.data?.analysis?.enabled&&read.data.analysis.version_id===version
 return <Card className="mt-3 space-y-3 p-4"><ReadingFeedback loading={read.loading} error={read.error??action.error} retry={read.reload}/><p className="text-sm">{t(enabled?'projectReading.analysisOn':'projectReading.analysisOff')}</p>{read.data?.analysis_admission&&<p role="alert" className="text-sm">{t('projectReading.analysisBlocked')}</p>}
 {read.data?.rounds.slice(0,3).map(r=><p key={r.id} className="text-xs text-muted-foreground">{t(`projectReading.status.${r.status}`,{defaultValue:r.status})}{r.coverage.complete===false&&` · ${t('projectReading.partial')}`}</p>)}
 <p className="text-sm text-muted-foreground">{t('projectReading.analysisConsent')}</p>{canManage&&version&&<>{!enabled&&<><label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirm} disabled={action.busy} onChange={e=>setConfirm(e.target.checked)}/>{t('projectReading.analysisConfirm')}</label><AgentExecutionPicker spaceId={space} userId={user} value={execution} onChange={setExecution} disabled={action.busy}/></>}
 <Button variant="outline" size="sm" disabled={read.loading||!!read.error||action.busy||!enabled&&(!confirm||!execution.agent_id||!execution.runtime_profile_id)} onClick={()=>void action.run(()=>projectReadingApi.consent(goal,{expected_version_id:version,enabled:!enabled,...(!enabled?{agent_id:execution.agent_id,runtime_profile_id:execution.runtime_profile_id,session_config:execution.session_config??[]}:{})},{spaceId:space}),read.reload)}>{t(enabled?'projectReading.disableAnalysis':'projectReading.enableAnalysis')}</Button></>}
 </Card>
}
