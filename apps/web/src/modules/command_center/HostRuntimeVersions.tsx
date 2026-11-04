import {useState} from 'react'
import {Ellipsis,Loader2} from 'lucide-react'
import {Button} from '../../components/ui/button'
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from '../../components/ui/dialog'
import {DropdownMenu,DropdownMenuContent,DropdownMenuItem,DropdownMenuTrigger} from '../../components/ui/dropdown-menu'
import {useAppTranslation} from '../../i18n'

/** Recovery stays available without competing with everyday login and upgrade. */
export default function HostRuntimeVersions({name,host,current,previous,busy,online,onRollback}:{
  name:string;host:string;current:string|null;previous?:string|null;busy:boolean;online:boolean;onRollback:()=>void
}){
  const [open,setOpen]=useState(false),{t}=useAppTranslation()
  const tr=(key:string,values?:Record<string,string>)=>t(`management_ui.host_catalog.${key}`,values)
  return <>
    <DropdownMenu><DropdownMenuTrigger asChild><Button size="sm" variant="ghost" aria-label={tr('more_label',{name,host})}><Ellipsis className="size-4"/></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end"><DropdownMenuItem onSelect={()=>setOpen(true)}>{tr('version_management')}</DropdownMenuItem></DropdownMenuContent>
    </DropdownMenu>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="w-[calc(100%-2rem)] max-w-md">
      <DialogHeader><DialogTitle>{tr('version_management')} · {name}</DialogTitle><DialogDescription>{host}</DialogDescription></DialogHeader>
      <dl className="space-y-3 text-sm"><div><dt className="text-muted-foreground">{tr('current_version')}</dt><dd className="break-words">{current??tr('unknown_version')}</dd></div>
        <div><dt className="text-muted-foreground">{tr('rollback_version')}</dt><dd className="break-words">{previous??tr('no_rollback')}</dd></div></dl>
      {previous&&<div className="mt-4 space-y-3"><p className="text-xs text-muted-foreground">{tr('rollback_help')}</p>
        <Button variant="outline" disabled={!online||busy} onClick={onRollback}>
          {busy&&<Loader2 className="size-4 animate-spin"/>}{tr(busy?'rolling_back':'rollback_to',{version:previous})}
        </Button></div>}
    </DialogContent></Dialog>
  </>
}
