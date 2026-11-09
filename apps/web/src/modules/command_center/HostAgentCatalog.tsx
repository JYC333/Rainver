import {Loader2, RefreshCw} from 'lucide-react'
import type {AcpRegistryEntry} from '../../api/client'
import {Badge} from '../../components/ui/badge'
import {Button} from '../../components/ui/button'
import {Input} from '../../components/ui/input'
import {useAppTranslation} from '../../i18n'

export interface CatalogAgent {
  entry: AcpRegistryEntry
  installed: boolean
  managed: string[]
  own: boolean
  update: boolean
  enabled: boolean
  runtimeKey?: string
}

/** This Host's installed agents and the registry share one searchable catalog. */
export default function HostAgentCatalog({hostName,rows,query,onQuery,loading,error,loaded,busy,online,onRefresh,onInstall}:{
  hostName:string; rows:CatalogAgent[]; query:string; onQuery:(value:string)=>void
  loading:boolean; error:string|null; loaded:boolean; busy:ReadonlySet<string>; online:boolean
  onRefresh:()=>void; onInstall:(entry:AcpRegistryEntry)=>void
}) {
  const {t}=useAppTranslation()
  const tr=(key:string,values?:Record<string,string>)=>t(`management_ui.host_catalog.${key}`,values)
  return <>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm font-medium">{tr('title')}</p>
      <Button size="sm" variant="ghost" disabled={loading} onClick={onRefresh}><RefreshCw className="size-3.5"/>{tr('refresh')}</Button>
    </div>
    <p className="text-xs text-muted-foreground">{tr('description',{host:hostName})}</p>
    {loading ? <p role="status" className="text-xs text-muted-foreground"><Loader2 className="mr-1 inline size-3 animate-spin"/>{tr('loading')}</p>
      : error ? <p role="alert" className="break-words text-xs text-destructive">{error}</p>
      : loaded && <>
        <Input aria-label={tr('search')} placeholder={tr('search')} value={query} onChange={event=>onQuery(event.target.value)}/>
        <ul aria-label={tr('title')} className="max-h-80 divide-y divide-border overflow-y-auto">
          {rows.map(row=>{
            const {entry}=row,working=busy.has(`registry:${entry.id}`)||Boolean(row.runtimeKey&&busy.has(row.runtimeKey))
            const actionable=row.update || !row.installed || row.own && row.managed.length===0
            const action=row.update?'upgrade':row.installed?'managed_copy':row.enabled?'install':'enable_install'
            return <li key={entry.id} className="flex min-w-0 flex-wrap items-center justify-between gap-2 py-3 text-xs" data-registry-agent={entry.id}>
              <div className="min-w-0 flex-1 basis-40 space-y-1">
                <div className="flex flex-wrap items-center gap-2"><span className="break-words font-medium">{entry.name}</span>{row.installed&&<Badge variant="secondary">{tr('installed')}</Badge>}</div>
                <p className="break-words text-muted-foreground">{row.managed.length>0?tr('versions',{current:row.managed.join(', '),latest:entry.version}):tr('available',{version:entry.version})}</p>
                {entry.description&&<p className="truncate text-muted-foreground" title={entry.description}>{entry.description}</p>}
              </div>
              {actionable&&<Button size="sm" variant="outline" disabled={working||!online} aria-label={tr(`${action}_label`,{name:entry.name,host:hostName})} onClick={()=>onInstall(entry)}>
                {working&&<Loader2 className="mr-1 size-3 animate-spin"/>}{tr(working?(row.update?'upgrading':'installing'):action)}
              </Button>}
            </li>
          })}
          {!rows.length&&<li className="py-2 text-xs text-muted-foreground">{tr('empty')}</li>}
        </ul>
      </>}
  </>
}
