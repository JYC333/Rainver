import {useEffect,useState} from 'react'
import type {RoomConversationDefault,ConversationBackendOption} from '@rainver/protocol'
import type {RoomDetail} from '../../types/api'
import {roomsApi} from '../../api/client'
import {Button} from '../../components/ui/button'
import {Select} from '../../components/ui/select'
import {Card,CardTitle} from '../../components/ui/card'
import {useAppTranslation} from '../../i18n'
import {errMsg} from '../../lib/utils'
import {ConversationSessionConfig} from '../conversation/ConversationSessionConfig'

export function RoomConversationDefaults({detail,onChanged}:{detail:RoomDetail;onChanged:()=>Promise<void>}){
 const {t}=useAppTranslation()
 const [changed,setChanged]=useState<Set<string>>(new Set())
 const [revision,setRevision]=useState(0)
 const [loaded,setLoaded]=useState(false)
 const [open,setOpen]=useState(false),[loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null)
 const [defaults,setDefaults]=useState<RoomConversationDefault[]>([]),[catalogs,setCatalogs]=useState<Record<string,ConversationBackendOption[]>>({})
 useEffect(()=>{
  if(!open)return
  let active=true;setLoading(true);setLoaded(false);setError(null)
  roomsApi.conversationDefaults(detail.room.id,{spaceId:detail.room.space_id}).then(result=>{if(active){setLoaded(true);setChanged(new Set());setRevision(result.revision);setDefaults(result.defaults.filter(item=>detail.agent_members.some(member=>member.agent_id===item.agent_id)));setCatalogs(Object.fromEntries(result.agents.map(agent=>[agent.agent_id,agent.options])))}}).catch(e=>{if(active)setError(errMsg(e))}).finally(()=>{if(active)setLoading(false)})
  return ()=>{active=false}
 },[open,detail.room.id,detail.room.space_id])
 function current(id:string):RoomConversationDefault{return defaults.find(item=>item.agent_id===id)??{agent_id:id,participating:true,runtime_profile_id:null,session_config:[]}}
 function update(value:RoomConversationDefault){setChanged(ids=>new Set([...ids,value.agent_id]));setDefaults(items=>[...items.filter(item=>item.agent_id!==value.agent_id),value])}
 async function save(){setBusy(true);setError(null);try{await roomsApi.saveConversationDefaults(detail.room.id,defaults.filter(item=>changed.has(item.agent_id)),revision,{spaceId:detail.room.space_id});await onChanged();setOpen(false)}catch(e){setError(errMsg(e))}finally{setBusy(false)}}
 return <Card className="space-y-3 p-4 lg:col-span-2">
  <div className="flex flex-wrap items-center justify-between gap-2"><CardTitle>{t('conversation_ui.participants.defaults_title')}</CardTitle><Button size="sm" variant="outline" disabled={!detail.viewer_can_write||busy} onClick={()=>setOpen(value=>!value)}>{t('conversation_ui.participants.defaults_edit')}</Button></div>
  <p className="text-xs text-muted-foreground">{t('conversation_ui.participants.defaults_note')}</p>
  {open&&<div className="space-y-3">{loading?<p>{t('conversation_ui.preflight.loading')}</p>:detail.agent_members.map(member=>{
   const value=current(member.agent_id),options=catalogs[member.agent_id]??[],option=options.find(option=>option.runtime_profile_id===value.runtime_profile_id)
   return <div className="space-y-2 rounded-md border border-border p-3" key={member.agent_id}>
    <Button size="sm" variant={value.participating?'secondary':'outline'} aria-pressed={value.participating} disabled={busy||member.role==='manager'||!catalogs[member.agent_id]} onClick={()=>update({...value,participating:!value.participating})}>{member.agent_name} · {t(value.participating?'conversation_ui.participants.joined':'conversation_ui.participants.absent')}</Button>
    {value.participating&&<><Select ariaLabel={member.agent_name} value={value.runtime_profile_id??''} disabled={busy||!catalogs[member.agent_id]} onChange={id=>update({...value,runtime_profile_id:id||null,session_config:[]})} options={[{value:'',label:t('conversation_ui.participants.runtime_default')},...options.map(option=>({value:option.runtime_profile_id,label:`${option.name} · ${option.runtime_key}`,disabled:option.usable===false}))]}/>
    {value.runtime_profile_id&&!option&&<p className="text-xs text-destructive">{t('conversation_ui.preflight.runtime_unavailable')}</p>}
    {option&&<div className="flex flex-wrap gap-2"><ConversationSessionConfig options={option.session_config_options??[]} value={value.session_config} disabled={busy} onChange={session_config=>update({...value,session_config})}/></div>}
    {!catalogs[member.agent_id]&&<p className="text-xs text-destructive">{t('conversation_ui.preflight.runtime_unavailable')}</p>}</>}
   </div>
  })}{!loading&&<Button size="sm" disabled={busy||!loaded} onClick={()=>void save()}>{t('conversation_ui.participants.defaults_save')}</Button>}</div>}
  {error&&<p role="alert" className="text-xs text-destructive">{error}</p>}
 </Card>
}
