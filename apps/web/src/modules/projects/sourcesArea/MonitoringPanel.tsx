import {useEffect,useState} from 'react'
import {useParams} from 'react-router-dom'
import type {ProjectMonitoringState} from '@rainver/protocol'
import {projectMonitoringApi} from '../../../api/client'
import {useAppTranslation} from '../../../i18n'
import {Button} from '../../../components/ui/button'
import SourceGoalsList from '../../sources/SourceGoalsList'
import {MonitoringReadingView} from './MonitoringReadingView'
export default function MonitoringPanel({mode='config'}:{mode?:'config'|'results'|'candidates';guided?:boolean;onChanged?:()=>void}){
 const {projectId=''}=useParams();const {t}=useAppTranslation();const [state,setState]=useState<ProjectMonitoringState|null>(null);const [error,setError]=useState<unknown>(null);const [busy,setBusy]=useState(false);
 useEffect(()=>{let live=true;if(mode!=='config')void projectMonitoringApi.state(projectId).then(s=>{if(live)setState(s)}).catch(e=>{if(live)setError(e)});return()=>{live=false}},[projectId,mode]);
 if(mode==='config')return <SourceGoalsList projectId={projectId}/>;
 async function action(fn:()=>Promise<unknown>){setBusy(true);setError(null);try{await fn();setState(await projectMonitoringApi.state(projectId))}catch(e){setError(e)}finally{setBusy(false)}}
 if(error)return <div role="alert">{t('sourceGoals.errorHint')}<Button onClick={()=>void action(async()=>{})}>{t('sourceGoals.retry')}</Button></div>;
 if(!state)return <p role="status">{t('sourceGoals.loading')}</p>;
 return <MonitoringReadingView state={state} mode={mode} busy={busy} action={action} more={async()=>{if(state.candidates_next_offset!=null){const next=await projectMonitoringApi.state(projectId,state.candidates_next_offset);setState({...next,candidates:[...state.candidates,...next.candidates]})}}}/>;
}
