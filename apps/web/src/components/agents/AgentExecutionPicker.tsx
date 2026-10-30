import {cn} from '../../lib/utils'
import type {ConversationBackendCatalog,RuntimeSessionConfigSelection} from '@rainver/protocol'
import {ConversationSessionConfig,SavedConversationSessionConfig,mergeSessionConfig} from '../../modules/conversation/ConversationSessionConfig'
import {Settings2} from 'lucide-react'
import {Button} from '../ui/button'
import {useEffect,useState,useRef} from 'react'
import type {AgentOut,AgentRuntimeProfileOut} from '../../types/api'
import {agentsApi} from '../../api/client'
import {Select} from '../ui/select'
import {SpaceLink} from '../../core/spaceNav'
import {useAppTranslation} from '../../i18n'

export type AgentExecutionSelection={agent_id:string;runtime_profile_id:string;session_config?:RuntimeSessionConfigSelection[]}
/** Select existing authority; never configure credentials or invent a fallback here. */
export function AgentExecutionPicker({spaceId,userId,value,onChange,disabled=false,profileLocked=false,sessionId,className}:{spaceId:string;userId:string;value:AgentExecutionSelection;onChange:(v:AgentExecutionSelection)=>void;disabled?:boolean;profileLocked?:boolean;sessionId?:string|null;className?:string}){
 const selection=useRef(value);selection.current=value;
 const {t}=useAppTranslation();const text=(k:string)=>t(`sourceGoals.${k}`)
 const [agents,setAgents]=useState<AgentOut[]>([]);const [profiles,setProfiles]=useState<AgentRuntimeProfileOut[]>([]);const [loading,setLoading]=useState(true);const [failed,setFailed]=useState(false);const [attempt,setAttempt]=useState(0)
 useEffect(()=>{let live=true;setLoading(true);setFailed(false);void agentsApi.list({status:'active',limit:'100'},{spaceId}).then(rows=>{if(live){const owned=rows.filter(a=>a.created_by_user_id===userId&&a.agent_kind!=='system_assistant');setAgents(owned)}}).catch(()=>{if(live)setFailed(true)}).finally(()=>{if(live)setLoading(false)});return()=>{live=false}},[spaceId,userId,attempt])
 useEffect(()=>{let live=true;setProfiles([]);if(!value.agent_id)return;setLoading(true);setFailed(false);void agentsApi.listRuntimeProfiles(value.agent_id,{spaceId}).then(rows=>{if(live&&selection.current.agent_id===value.agent_id){const enabled=rows.filter(p=>p.enabled);setProfiles(enabled);const preferred=enabled.find(p=>p.is_default);if(preferred&&!selection.current.runtime_profile_id&&!profileLocked)onChange({...selection.current,runtime_profile_id:preferred.id})}}).catch(()=>{if(live)setFailed(true)}).finally(()=>{if(live)setLoading(false)});return()=>{live=false}},[value.agent_id,spaceId,attempt])
 const [catalog,setCatalog]=useState<ConversationBackendCatalog|null>(null);const [configError,setConfigError]=useState(false);
 useEffect(()=>{let live=true;setCatalog(null);setConfigError(false);if(!value.agent_id||!value.runtime_profile_id)return;void agentsApi.conversationBackends(value.agent_id,{spaceId,...(sessionId?{sessionId}:{})}).then(data=>{if(live)setCatalog(data)}).catch(()=>{if(live)setConfigError(true)});return()=>{live=false}},[spaceId,value.agent_id,value.runtime_profile_id,sessionId,attempt]);
 const offered=catalog?.options.find(o=>o.runtime_profile_id===value.runtime_profile_id);const options=offered?.session_config_options??[];
 const selected=profiles.find(p=>p.id===value.runtime_profile_id)
 return <div className={cn("space-y-3 rounded-lg border border-border p-4",className)}>
  <p className="font-medium">{text('execution')}</p>
  <Select ariaLabel={text('agent')} disabled={disabled||profileLocked||loading} value={value.agent_id} onChange={agent_id=>onChange({agent_id,runtime_profile_id:''})} options={[{value:'',label:text('chooseAgent')},...agents.map(a=>({value:a.id,label:a.name}))]}/>
  <Select ariaLabel={text('profile')} disabled={disabled||profileLocked||loading||!value.agent_id} value={value.runtime_profile_id} onChange={runtime_profile_id=>onChange({...value,runtime_profile_id})} options={[{value:'',label:text('chooseProfile')},...profiles.map(p=>({value:p.id,label:`${p.name} · ${p.runtime_key}${p.provider_binding.model?` · ${p.provider_binding.model}`:''}`}))]}/>
  {options.length>0&&<div className="flex flex-wrap gap-2" aria-label={text('modelAndMode')}>{sessionId?<SavedConversationSessionConfig options={options} value={mergeSessionConfig(options,value.session_config??catalog?.session_config??[])} persistedValue={catalog?.session_config??[]} onChange={session_config=>onChange({...value,session_config})} onSave={async session_config=>{const saved=await agentsApi.saveConversationSessionConfig(value.agent_id,{session_id:sessionId,runtime_profile_id:value.runtime_profile_id,session_config},{spaceId});setCatalog(c=>c?{...c,session_config:saved.session_config}:c);onChange({...value,session_config:saved.session_config})}} disabled={disabled}/>:<><ConversationSessionConfig options={options} value={mergeSessionConfig(options,value.session_config??[])} onChange={session_config=>onChange({...value,session_config})} disabled={disabled}/><p className="text-xs text-muted-foreground">{t('conversation_ui.session_config.first_send')}</p></>}</div>}
  {selected&&!options.length&&!configError&&<p className="text-sm text-muted-foreground">{text('runtimeOptionsUnavailable')}</p>}
  {configError&&<p role="alert">{text('executionLoadError')} <Button size="sm" variant="outline" onClick={()=>setAttempt(n=>n+1)}>{text('retry')}</Button></p>}
  {selected&&<p className="text-sm text-muted-foreground">{text(selected.backend_mode==='model_provider'?'apiUsage':'nativeUsage')}</p>}
  {loading&&<p role="status">{text('loadingExecution')}</p>}
  {failed&&<p role="alert">{text('executionLoadError')} <Button variant="outline" size="sm" onClick={()=>setAttempt(n=>n+1)}>{text('retry')}</Button></p>}
  {!loading&&!failed&&(!agents.length||value.agent_id&&!profiles.length)&&<p>{text('noExecution')}</p>}
  <Button variant="outline" size="sm" asChild><SpaceLink to={value.agent_id?`/agents/${value.agent_id}`:'/agents'}><Settings2 className="size-4"/>{text('configureExecution')}</SpaceLink></Button>
 </div>
}
