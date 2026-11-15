import type {RetrievalObjectType} from '@rainver/protocol';
import type {Queryable} from '../routeUtils/common.js';
import type {RetrievalRegistry} from './index.js';
import {lockSourceRetrievalRelease} from '../sources/retrievalReleaseLocks.js';
import {lockRetrievalReleaseClosure} from './releaseClosure.js';
type Ref={object_type:RetrievalObjectType;object_id:string};
/** Pin the canonical root/extension and the exact policy lineage the adapters
 * of one registry read, plus any additional Source-closure resources, through
 * the shared ordered release closure (`releaseClosure.ts`). Rediscovery after
 * waiting refuses changed lineage rather than acquiring a second closure. */
export async function lockContentRetrievalRelease(db:Queryable,space:string,user:string,registry:RetrievalRegistry,refs:readonly Ref[],additional:Parameters<typeof lockSourceRetrievalRelease>[3]=[]){
 await lockRetrievalReleaseClosure(db,space,user,[{registry,refs}],additional);
}
