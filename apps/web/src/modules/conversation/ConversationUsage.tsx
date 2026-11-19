import {useEffect,useMemo,useState} from 'react'
import type {ConversationSubscriptionLogin,ConversationQuotaDisplayWindow,RoomConversationQuota} from '@rainver/protocol'
import {useAppTranslation} from '../../i18n'
import {Button} from '../../components/ui/button'
import {Popover,PopoverContent,PopoverTrigger} from '../../components/ui/popover'
import {Dialog,DialogContent,DialogTitle,DialogDescription,DialogTrigger} from '../../components/ui/dialog'
import {SpaceLink} from '../../core/spaceNav'
import {hostsApi,type RequestOptions} from '../../api/client'
import {scopedUserStorageKey} from '../../lib/sessionResidue'
import {errMsg} from '../../lib/utils'
import {readingFreshness} from './quotaDismissal'
import {formatDateTime} from '../../i18n/format'

type Login=ConversationSubscriptionLogin
type Window=ConversationQuotaDisplayWindow
export function usageAccounts(logins:Login[]){
  const groups=new Map<string,{key:string;label:string;labels:Set<string>;agents:Set<string>;windows:Map<string,Window>;target:Login['refresh_target']}>()
  for(const login of logins){
    const key=login.pool_key??login.login_key
    let group=groups.get(key)
    if(!group){group={key,label:login.account_label,labels:new Set(),agents:new Set(),windows:new Map(),target:login.refresh_target};groups.set(key,group)}
    group.labels.add(login.account_label)
    for(const agent of login.agent_ids??[])group.agents.add(agent)
    group.target??=login.refresh_target
    for(const window of login.display_windows??(login.windows??(login.window?[{...login.window,checked_at:login.checked_at}]:[])).map(w=>({id:w.kind,label:w.kind,group:'account' as const,utilization:w.utilization,resets:w.resets_at,checked_at:w.checked_at}))){
      const old=group.windows.get(window.id)
      if(!old || Date.parse(window.checked_at??'')>Date.parse(old.checked_at??'') || (!old.checked_at&&window.checked_at))group.windows.set(window.id,window)
    }
  }
  return [...groups.values()].map(group=>({...group,label:[...group.labels].sort().join(' / ')}))
}

/** Static account utilization. Unknown data has a track and dash, never a zero reading. */
export function UsageRing({value}:{value:number|null}){
  const pct=value===null?0:Math.max(0,Math.min(100,value))
  return <svg aria-hidden="true" viewBox="0 0 24 24" className={`size-6 shrink-0 -rotate-90 ${value===null?'text-muted-foreground':pct>=90?'text-destructive':pct>=70?'text-warning':'text-primary'}`}>
    <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="3" className="opacity-20"/>
    {value!==null&&<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="3" strokeDasharray={`${pct*56.55/100} 56.55`} strokeLinecap="round"/>}
  </svg>
}

function formatReset(value:string){
  const parsed=Date.parse(value.replace(/^Resets\s+/i,''))
  return Number.isFinite(parsed)?formatDateTime(new Date(parsed).toISOString()):value.replace(/^Resets\s+/i,'')
}

export function ConversationUsage({quota,selectedAgents,agents,scope,userId,onRefresh}:{quota:RoomConversationQuota|null;selectedAgents:string[];agents:Array<{id:string;name:string}>;scope:RequestOptions;userId:string;onRefresh:()=>void}){
  const {t}=useAppTranslation()
  const [open,setOpen]=useState(false),[mobile,setMobile]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('')
  const pref=scopedUserStorageKey('quota-numbers',userId,scope.spaceId??'')
  const [numbers,setNumbers]=useState(()=>{try{return sessionStorage.getItem(pref)!=='false'}catch{return true}})
  useEffect(()=>{if(typeof window.matchMedia!=='function')return;const media=window.matchMedia('(max-width: 639px)');const change=()=>setMobile(media.matches);change();media.addEventListener('change',change);return()=>media.removeEventListener('change',change)},[])
  const accounts=useMemo(()=>usageAccounts(quota?.logins??[]),[quota])
  const selected=accounts.filter(a=>!selectedAgents.length||selectedAgents.some(id=>a.agents.has(id)))
  const other=accounts.filter(a=>!selected.includes(a))
  const fullest=(a:typeof accounts[number])=>Math.max(-1,...[...a.windows.values()].map(w=>w.utilization??-1))
  selected.sort((a,b)=>fullest(b)-fullest(a)||a.key.localeCompare(b.key))
  other.sort((a,b)=>fullest(b)-fullest(a)||a.key.localeCompare(b.key))
  // With no shared account meter, name one native allowance explicitly; never invent an overall total.
  const primary=selected.flatMap(a=>{
    const windows=[...a.windows.values()]
    const account=windows.filter(w=>w.group==='account')
    return (account.length?account:windows.filter(w=>w.group==='native')).filter(w=>w.utilization!==null)
  }).sort((a,b)=>(b.utilization??-1)-(a.utilization??-1)||a.id.localeCompare(b.id))[0]
  const value=primary?.utilization??null
  const summary=value===null?t('conversation_ui.usage.unknown'):`${primary?.group==='native'?`${primary.label}: `:''}${t('conversation_ui.usage.used',{pct:Math.round(value)})}`
  const trigger=<Button type="button" variant="ghost" size="sm" aria-label={`${t('conversation_ui.usage.title')}: ${summary}`} title={summary}><UsageRing value={value}/>{numbers&&<span className="tabular-nums">{value===null?'—':`${Math.round(value)}%`}</span>}</Button>
  const windowLabel=(window:Window)=>{
    const kind=window.id==='five_hour'?'session':window.id==='seven_day'?'week':window.id
    return kind==='session'||kind==='week'?t(`conversation_ui.usage.${kind}`):window.label
  }
  const row=(a:typeof accounts[number])=><section key={a.key} className="space-y-2 rounded-md border border-border p-3">
    <p className="break-words text-sm font-medium">{a.label}</p>
    <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">{a.agents.size?t('conversation_ui.usage.agents',{count:a.agents.size}):t('conversation_ui.usage.agent_unknown')}</summary><p className="mt-1 break-words">{[...a.agents].map(id=>agents.find(agent=>agent.id===id)?.name??t('conversation_ui.usage.agent')).join(', ')}</p></details>
    <div className="space-y-3">{(['account','native','third_party','other'] as const).map(group=>{
      const windows=[...a.windows.values()].filter(w=>w.group===group)
      if(!windows.length)return null
      const meters=<div className="mt-2 flex flex-wrap gap-3">{windows.map(window=><div key={window.id} className="min-w-0 flex-1 basis-32 text-xs">
        <div className="flex items-center gap-2"><UsageRing value={window.utilization}/><div className="min-w-0"><p className="break-words">{windowLabel(window)}</p><p className="font-medium tabular-nums">{window.utilization===null?'—':t('conversation_ui.usage.used',{pct:Math.round(window.utilization)})}</p></div></div>
        {window.resets&&<p className="mt-1 break-words text-muted-foreground">{t('conversation_ui.usage.reset',{time:formatReset(window.resets)})}</p>}
        <p className="text-muted-foreground">{window.checked_at?t('conversation_ui.usage.updated',{time:formatDateTime(window.checked_at)}):t('conversation_ui.usage.unknown')}{readingFreshness(window.checked_at,Date.now())==='stale'&&` · ${t('conversation_ui.usage.stale')}`}</p>
      </div>)}</div>
      const warning=windows.some(w=>w.utilization!==null&&w.utilization>=(quota?.warn_pct??70))
      return group==='third_party'||group==='other'?<details key={group}><summary className="cursor-pointer text-xs">{t(`conversation_ui.usage.${group==='other'?'other_windows':group}`)} ({windows.length}){warning&&<span className="ml-2 text-warning">{t('conversation_ui.usage.attention')}</span>}</summary>{meters}</details>:<div key={group}>{group==='native'&&<><p className="text-xs font-medium">{t('conversation_ui.usage.native')}</p><p className="text-xs text-muted-foreground">{t('conversation_ui.usage.independent')}</p></>}{meters}</div>
    })}{!a.windows.size&&<p className="text-xs text-muted-foreground">{t('conversation_ui.usage.unknown')}</p>}</div>
    {a.target&&<Button size="sm" variant="outline" disabled={busy} onClick={async()=>{setBusy(true);setError('');try{await hostsApi.refreshUsage(a.target!.host_id,a.target!.runtime_key,a.target!.installation,undefined,scope);onRefresh()}catch(e){setError(errMsg(e))}finally{setBusy(false)}}}>{busy?t('conversation_ui.usage.refreshing'):t('conversation_ui.usage.refresh')}</Button>}
  </section>
  const content=<div className="space-y-3">
    <p className="text-xs text-muted-foreground">{t('conversation_ui.usage.hint')}</p>
    {/* An action label names what the click does, so it carries no aria-pressed: a pressed "Hide…" would read as the opposite state. */}
    <Button type="button" size="sm" variant="outline" onClick={()=>{setNumbers(!numbers);try{sessionStorage.setItem(pref,String(!numbers))}catch{}}}>{t(numbers?'conversation_ui.usage.hide_numbers':'conversation_ui.usage.show_numbers')}</Button>
    {error&&<p role="alert" className="text-xs text-destructive">{error}</p>}
    <div className="max-h-[50dvh] space-y-2 overflow-y-auto overscroll-contain">{selected.length?selected.map(row):<p className="text-sm text-muted-foreground">{t('conversation_ui.usage.empty')}</p>}
      {other.map(row)}
    </div>
    <Button asChild size="sm" variant="outline"><SpaceLink to={scope.spaceId?`/spaces/${scope.spaceId}/usage`:'/usage'}>{t('conversation_ui.usage.full')}</SpaceLink></Button>
  </div>
  const change=(next:boolean)=>{setOpen(next);if(next)onRefresh()}
  return mobile?<Dialog open={open} onOpenChange={change}><DialogTrigger asChild>{trigger}</DialogTrigger><DialogContent className="bottom-0 left-0 top-auto max-h-[85dvh] translate-x-0 translate-y-0 overflow-y-auto rounded-b-none p-4 data-[state=open]:animate-none data-[state=closed]:animate-none"><DialogTitle>{t('conversation_ui.usage.title')}</DialogTitle><DialogDescription className="sr-only">{t('conversation_ui.usage.hint')}</DialogDescription>{content}</DialogContent></Dialog>:<Popover open={open} onOpenChange={change}><PopoverTrigger asChild>{trigger}</PopoverTrigger><PopoverContent aria-label={t('conversation_ui.usage.title')} className="w-96" side="top"><p className="mb-2 font-semibold">{t('conversation_ui.usage.title')}</p>{content}</PopoverContent></Popover>
}
