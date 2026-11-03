import {useLocation} from 'react-router-dom'
import {useEffect,useRef,useState} from 'react'
import {projectReadingApi} from '../../../api/client'
import {Button} from '../../../components/ui/button'
import {Card} from '../../../components/ui/card'
import {AgentExecutionPicker,type AgentExecutionSelection} from '../../../components/agents/AgentExecutionPicker'
import {useAppTranslation} from '../../../i18n'
import {useReadingAction,useReadingResource} from './useReadingResource'
import {analysisFailureKey} from './analysisFailure'
import {ReadingFeedback} from './ReadingFeedback'
export function ThemeAnalysis({space,user,goal,version,canManage}:{space:string;user:string;goal:string;version:string|null;canManage:boolean}){
 const {t}=useAppTranslation();const location=useLocation();const [open,setOpen]=useState(location.hash==='#topic-analysis');const [visited,setVisited]=useState(open)
 return <details id="topic-analysis" open={open} onToggle={e=>{setOpen(e.currentTarget.open);if(e.currentTarget.open)setVisited(true)}} className="mt-3 border-t border-border pt-3"><summary className="cursor-pointer text-sm font-medium">{t('projectReading.analysisSettings')}</summary>{visited&&<Analysis active={open} key={`${space}:${user}:${goal}:${version}`} space={space} user={user} goal={goal} version={version} canManage={canManage}/>}</details>
}
function Analysis({space,user,goal,version,canManage,active}:{active:boolean;space:string;user:string;goal:string;version:string|null;canManage:boolean}){
 const {t}=useAppTranslation();const read=useReadingResource(`${space}:${goal}`,signal=>projectReadingApi.themes(goal,{spaceId:space,signal}),{pollWhile:data=>active&&data.rounds.some(r=>['collecting','generating'].includes(r.status))});const action=useReadingAction();const [execution,setExecution]=useState<AgentExecutionSelection>({agent_id:'',runtime_profile_id:''});const [confirm,setConfirm]=useState(false)
 const wasActive=useRef(active)
 useEffect(()=>{if(active&&!wasActive.current)read.reload();wasActive.current=active},[active,read.reload])
 const enabled=!!read.data?.analysis?.enabled&&read.data.analysis.version_id===version
 if(!read.data)return <Card className="mt-3 space-y-3 p-4"><ReadingFeedback loading={read.loading} error={read.error} retry={read.reload}/></Card>
 return <Card className="mt-3 space-y-3 p-4"><ReadingFeedback loading={read.loading} error={read.error??action.error} retry={read.reload}/><p className="text-sm">{t(enabled?'projectReading.analysisOn':'projectReading.analysisOff')}</p>{read.data?.analysis_admission&&<p role="alert" className="text-sm">{t('projectReading.analysisBlocked')}</p>}
 {read.data.rounds.slice(0,3).map(r=><div key={r.id} className="space-y-2 text-sm">
  <p className="text-xs text-muted-foreground">{t(`projectReading.status.${r.status}`,{defaultValue:r.status})}{r.coverage.complete===false&&` · ${t('projectReading.partial')}`}</p>
  {['blocked','awaiting_analysis'].includes(r.status)&&<>{r.status==='awaiting_analysis'?<p>{t('projectReading.analysisAwaiting')}</p>:<p>{t(analysisFailureKey(r.error_code))}</p>}{canManage&&enabled&&r.version_id===version&&r.coverage.complete!==false&&!['limit','changed','access','collection'].some(key=>analysisFailureKey(r.error_code).endsWith(`.${key}`))&&<><p className="text-xs text-muted-foreground">{t('projectReading.retryAnalysisHint')}</p><Button size="sm" variant="outline" disabled={action.busy||read.loading||!!read.error} onClick={()=>void action.run(()=>projectReadingApi.retryTheme(goal,r.id,{spaceId:space}),read.reload)}>{t(action.busy?'projectReading.retryingAnalysis':'projectReading.retryAnalysis')}</Button></>}</>}
 </div>)}
 <p className="text-sm text-muted-foreground">{t('projectReading.analysisConsent')}</p>{canManage&&version&&<>{!enabled&&<><label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirm} disabled={action.busy} onChange={e=>setConfirm(e.target.checked)}/>{t('projectReading.analysisConfirm')}</label><AgentExecutionPicker spaceId={space} userId={user} value={execution} onChange={setExecution} disabled={action.busy}/></>}
 <Button variant="outline" size="sm" disabled={read.loading||!!read.error||action.busy||!enabled&&(!confirm||!execution.agent_id||!execution.runtime_profile_id)} onClick={()=>void action.run(()=>projectReadingApi.consent(goal,{expected_version_id:version,enabled:!enabled,...(!enabled?{agent_id:execution.agent_id,runtime_profile_id:execution.runtime_profile_id,session_config:execution.session_config??[]}:{})},{spaceId:space}),read.reload)}>{t(enabled?'projectReading.disableAnalysis':'projectReading.enableAnalysis')}</Button></>}
 </Card>
}
