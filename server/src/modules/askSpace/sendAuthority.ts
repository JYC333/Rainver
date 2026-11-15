import type {Queryable,SpaceUserIdentity} from '../routeUtils/common.js';
import {HttpError,withQueryableTransaction} from '../routeUtils/common.js';
import {authorizeJobEffect,lockCurrentJobClaim} from '../jobs/effectAuthority.js';
import {lockRetrievalReleaseClosure,withheldPinnedReleaseRefs,type ReleaseGroup} from '../retrieval/releaseClosure.js';
import type {RetrievalRegistry} from '../retrieval/registry.js';
import {readSpaceRetrievalSettings} from '../retrieval/settings.js';
import {loadSourcePolicySnapshots,sourceEgressPoliciesForSnapshots} from '../retrieval/sourcePolicy.js';
import {retrievalEgressAllowed,type RetrievalSendAuthority,type RetrievalSendCandidate,type RetrievalEgressDestination} from '../retrieval/egress/egressPolicy.js';
import {canonical} from '../systemActions/operations/repository.js';

type Contribution={registry:RetrievalRegistry;candidate:RetrievalSendCandidate};
/** Request-local provenance, not an execution engine or a reusable grant.
 * Every physical call reacquires the current claim, complete Source release
 * closure, canonical payload and consent. Nothing holds a transaction over I/O.
 * Combined answers inherit every original contribution, never synthetic ids. */
export function createAskSendAuthority(db:Queryable,identity:SpaceUserIdentity){
 const contributions=new Map<string,Contribution>();
 const guard=(payload:readonly Contribution[])=>(destination:RetrievalEgressDestination)=>withQueryableTransaction(db,async tx=>{
  await lockCurrentJobClaim(tx);
  await tx.query('SELECT pg_advisory_xact_lock_shared(hashtext($1))',[`runtime-egress-settings:${identity.spaceId}`]);
  const groups:ReleaseGroup[]=payload.map(({registry,candidate:c})=>({registry,refs:[{object_type:c.objectType,object_id:c.objectId}]}));
  await lockRetrievalReleaseClosure(tx,identity.spaceId,identity.userId,groups);
  if(await withheldPinnedReleaseRefs(tx,identity,groups,null,{canonical:true}))throw new HttpError(403,'Think provider authority withdrawn');
  const sourceIds=new Set<string>();
  for(const {registry,candidate:c} of payload){
   const adapter=registry.adapterFor(c.objectType);
   const current=await adapter?.revalidate(tx,identity.spaceId,c.objectType,c.objectId,identity.userId);
   const object=await adapter?.loadCanonical(tx,identity.spaceId,c.objectType,c.objectId);
   if(!current||!object||current.title!==c.title||current.text!==c.text||canonical([...object.sourceConnectionIds].sort())!==canonical([...(c.sourceConnectionIds??[])].sort()))throw new HttpError(409,'Think provider content changed');
   object.sourceConnectionIds.forEach(id=>sourceIds.add(id));
  }
  const settings=await readSpaceRetrievalSettings(tx,identity.spaceId);
  const snapshots=await loadSourcePolicySnapshots(tx,identity.spaceId,[...sourceIds]);
  if(!retrievalEgressAllowed({object_type:'think',object_id:identity.spaceId},{externalEgressEnabled:settings.externalEgressEnabled,destination,payloadSourceConnectionIds:[...sourceIds],sourcePolicies:sourceEgressPoliciesForSnapshots(snapshots)}))throw new HttpError(403,'Think provider consent withdrawn');
  // Mark irreversible start under the same current claim and consent locks.
  // A lost response leaves the existing single-attempt unknown fence intact.
  await authorizeJobEffect(tx);
 });
 return {
  query:guard([]),
  forRegistry(registry:RetrievalRegistry):RetrievalSendAuthority{return candidates=>{
   const payload=candidates.map(candidate=>({registry,candidate:{...candidate,sourceConnectionIds:[...(candidate.sourceConnectionIds??[])]}}));
   for(const c of payload)contributions.set(c.candidate.objectType+':'+c.candidate.objectId,c);
   return guard(payload);
  };},
  combined:()=>guard([...contributions.values()]),
 };
}
