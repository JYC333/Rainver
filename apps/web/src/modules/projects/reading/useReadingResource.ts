import {useCallback,useEffect,useRef,useState} from 'react'
import {registerInMemoryResidue,sessionEpoch} from '../../../lib/sessionResidue'
/** One page-owned request generation. Same-scope transient failures retain history;
 * permission failures and scope changes remove it, including A→B→A replies. */
export function useReadingResource<T>(key:string,read:(signal:AbortSignal)=>Promise<T>){
 const getter=useRef(read);getter.current=read
 const [revision,setRevision]=useState(0),[state,setState]=useState<{key:string;data:T|null;error:unknown;loading:boolean}>({key,data:null,error:null,loading:true})
 useEffect(()=>{const c=new AbortController(),epoch=sessionEpoch();setState(s=>({key,data:s.key===key?s.data:null,error:null,loading:true}));getter.current(c.signal).then(data=>{if(!c.signal.aborted&&epoch===sessionEpoch())setState({key,data,error:null,loading:false})}).catch(error=>{if(!c.signal.aborted&&epoch===sessionEpoch())setState(s=>({key,data:[401,403,404].includes(error?.status)?null:s.key===key?s.data:null,error,loading:false}))});const unregister=registerInMemoryResidue(()=>{c.abort();setState({key,data:null,error:null,loading:false})});return()=>{unregister();c.abort()}},[key,revision])
 return {...(state.key===key?state:{data:null,error:null,loading:true}),reload:useCallback(()=>setRevision(n=>n+1),[])}
}
export function useReadingAction(){
 const owner=useRef<object|null>(null),lock=useRef(false);const [busy,setBusy]=useState(false),[error,setError]=useState<unknown>(null)
 useEffect(()=>{const id={};owner.current=id;const unregister=registerInMemoryResidue(()=>{owner.current=null;lock.current=false;setBusy(false);setError(null)});return()=>{unregister();owner.current=null}},[])
 return {busy,error,clearError:useCallback(()=>setError(null),[]),denied:[401,403,404].includes((error as {status?:number})?.status??0),run:async(action:()=>Promise<unknown>,done?:()=>void)=>{if(lock.current||!owner.current)return;const id=owner.current,epoch=sessionEpoch();lock.current=true;setBusy(true);setError(null);try{await action();if(owner.current===id&&epoch===sessionEpoch())done?.()}catch(e){if(owner.current===id&&epoch===sessionEpoch())setError(e)}finally{lock.current=false;if(owner.current===id&&epoch===sessionEpoch())setBusy(false)}}}
}
