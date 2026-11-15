import type {Queryable} from '../routeUtils/common.js';
/** A branded operation port lives for exactly one transaction. This local
 * discovery ledger grants no access; all owner gates still run. */
export const reportReleasePlans=new WeakMap<Queryable,Set<string>>();
/** Called only after the canonical writer's INSERT succeeds, including within
 * a host savepoint. Reused existing rows never enter through this path. */
export function noteReportOutput(db:Queryable,type:'artifact'|'proposal',id:string){
 reportReleasePlans.get(db)?.add(type+':'+id);
}
