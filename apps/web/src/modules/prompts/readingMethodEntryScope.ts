import {readingMethodsApi} from './readingMethodApi'
import {registerInMemoryResidue,sessionEpoch} from '../../lib/sessionResidue'
type Result={can_manage:boolean;project_id:string|null}
type Entry={listeners:Set<(v:Result|null)=>void>;value:Result|null}
// Only mounted navigation affordances share this probe. No persistent or cross-session cache.
const mounted=new Map<string,Entry>()
registerInMemoryResidue(()=>{for(const e of mounted.values())for(const notify of e.listeners)notify(null);mounted.clear()})
export function observeReadingMethodScope(space:string,user:string,project:string|null,notify:(v:Result|null)=>void){
 const epoch=sessionEpoch(),key=JSON.stringify([space,user,project,epoch]);let entry=mounted.get(key)
 if(!entry){entry={listeners:new Set(),value:null};mounted.set(key,entry);const owner=entry
  void readingMethodsApi.entry(project).then(value=>{if(mounted.get(key)!==owner||epoch!==sessionEpoch())return;owner.value=value;for(const n of owner.listeners)n(value)},()=>{if(mounted.get(key)!==owner)return;owner.value={can_manage:false,project_id:project};for(const n of owner.listeners)n(owner.value)})
 }
 entry.listeners.add(notify);notify(entry.value)
 return()=>{entry!.listeners.delete(notify);if(!entry!.listeners.size&&mounted.get(key)===entry)mounted.delete(key)}
}
