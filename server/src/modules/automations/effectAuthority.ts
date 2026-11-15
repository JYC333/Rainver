import {AsyncLocalStorage} from 'node:async_hooks';
import {withQueryableTransaction,type Queryable} from '../routeUtils/common.js';
// Host-created invocation capability; never accepted from HTTP or Job payload.
type Admission={check:(tx:Queryable)=>Promise<void>;closed:boolean;checking:Set<Queryable>};
const current=new AsyncLocalStorage<Admission>();
export async function withAutomationEffectAuthority<T>(check:Admission['check'],work:()=>Promise<T>):Promise<T>{
 const a:Admission={check,closed:false,checking:new Set()};
 return current.run(a,async()=>{try{return await work();}finally{a.closed=true;}});
}
/** Call before the target owner's first domain lock/write, never around IO. */
export async function admitAutomationEffect(tx:Queryable):Promise<void>{
 const a=current.getStore();if(!a)return;
 if(a.closed)throw new Error('Automation fire invocation ended');
 if(a.checking.has(tx))return;
 a.checking.add(tx);try{await a.check(tx);}finally{a.checking.delete(tx);}
}

export function withAutomationEffectTransaction<T>(db:Queryable,work:(tx:Queryable)=>Promise<T>):Promise<T>{
 return withQueryableTransaction(db,async tx=>{await admitAutomationEffect(tx);return work(tx);});
}
