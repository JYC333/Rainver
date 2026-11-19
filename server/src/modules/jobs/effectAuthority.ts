import {AsyncLocalStorage} from 'node:async_hooks';
import type {Queryable} from '../routeUtils/common.js';
import type {JobEnvelopeForHandler} from './handlerRegistry.js';

export class JobEffectLeaseLost extends Error {
 constructor(message='Source dispatch Job no longer owns execution'){super(message);this.name='JobEffectLeaseLost';}
}
type Credential={db:Queryable;job:JobEnvelopeForHandler;closed:boolean;lost:boolean;beforeEffect?:(db?:Queryable)=>Promise<void>};
const authority=new AsyncLocalStorage<Credential>();
/** Invocation-scoped execution credential. It survives async preparation, never
 * an invocation's completion. It grants no domain, consent or spend authority. */
export async function withJobEffectAuthority<T>(db:Queryable,job:JobEnvelopeForHandler,work:()=>Promise<T>,beforeEffect?:(db?:Queryable)=>Promise<void>):Promise<T>{
 const credential={db,job,closed:false,lost:false,beforeEffect};
 // Provider SDKs may wrap a denied fetch as a generic connection error, or
 // retrieval may degrade to lexical results. Neither restores Job ownership.
 return authority.run(credential,async()=>{try{const result=await work();if(credential.lost)throw new JobEffectLeaseLost();return result;}catch(error){if(credential.lost)throw new JobEffectLeaseLost();throw error;}finally{credential.closed=true;}});
}
export function hasJobEffectAuthority():boolean{return !!authority.getStore();}
/** Whether this invocation's credential already found the Job claimed by someone else.
 * A provider SDK may wrap the refusal; the flag, not the error type, is authoritative. */
export function jobEffectAuthorityLost():boolean{const c=authority.getStore();return !!c&&c.lost;}
/** Captures authority for a later Host request callback, whose incoming socket
 * event has a different async context. Closed credentials continue to refuse. */
export function bindJobEffectAuthority<A extends unknown[],R>(fn:(...args:A)=>R):(...args:A)=>R{
 const credential=authority.getStore();return credential?(...args)=>authority.run(credential,()=>fn(...args)):fn;
}
/** The irreversible-start linearization point is this claim-conditioned write,
 * serialized on the SAME Job row as cancel/reclaim. Once it commits, outcome
 * is unknown until receipted, even if the process dies before sending. For DB
 * enqueue, pass its owner transaction so admission and intent commit together.
 * Physical I/O callers invoke their effect immediately afterwards, with no
 * intervening asynchronous preparation. No transaction spans the effect. */
export async function authorizeJobEffect(db?:Queryable):Promise<void>{
 const credential=authority.getStore();if(!credential)return;
 if(credential.closed||credential.lost)throw new JobEffectLeaseLost();
 await credential.beforeEffect?.(db);
 const j=credential.job;
 const admitted=await (db??credential.db).query(`UPDATE jobs SET result_json=result_json || '{"effect_started":true}'::jsonb WHERE id=$1 AND space_id=$2 AND status='running' AND claimed_by=$3 AND attempts=$4 AND result_json->>'source_dispatch'='started' RETURNING id`,[j.job_id,j.space_id,j.worker_id,j.attempts]);
 if(!admitted.rows.length||credential.closed){credential.lost=true;throw new JobEffectLeaseLost();}
}
/** A durable write derived from external I/O (for example a provider-built
 * Artifact) settles in a short caller-owned transaction that first locks this
 * Job row under its CURRENT claim. Reclaim/cancel update the same row, so they
 * order before (and refuse) or after (and observe) the settlement commit. A
 * lost claim marks the credential lost and the caller writes nothing. Without
 * an invocation credential or explicit envelope there is no claim to hold. */
export async function lockCurrentJobClaim(tx:Queryable,job?:JobEnvelopeForHandler):Promise<void>{
 const credential=authority.getStore(),j=job??credential?.job;if(!j)return;
 if(!job&&credential&&(credential.closed||credential.lost))throw new JobEffectLeaseLost();
 const held=await tx.query(`SELECT id FROM jobs WHERE id=$1 AND space_id=$2 AND status='running' AND claimed_by=$3 AND attempts=$4 FOR UPDATE`,[j.job_id,j.space_id,j.worker_id,j.attempts]);
 if(!held.rows.length){if(credential&&credential.job.job_id===j.job_id)credential.lost=true;throw new JobEffectLeaseLost('Job lost its claim before its derived result was settled');}
}
export async function performJobEffect<T>(effect:()=>T):Promise<Awaited<T>>{
 if(hasJobEffectAuthority())await authorizeJobEffect();
 return await effect();
}
