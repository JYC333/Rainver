import type { RequestOptions } from './transport'
import { ApiRequestError, post, request } from './transport'
import type { OperationId, OperationInput, OperationOutcome, OperationOutput } from '@rainver/protocol'

/** A keyed command at a retained URL whose adapter owns a pre-transaction step; never retried. */
export async function operationAt<T>(method:'POST'|'PUT'|'PATCH'|'DELETE',path:string,body:unknown,key:string,options:RequestOptions={}):Promise<T>{
  const result=await request<OperationOutcome<T>>(method,path,body,{...options,idempotencyKey:key})
  if(!('status' in result)||result.status!=='succeeded')throw new Error('Command did not complete')
  return result.data
}

/**
 * The shared request and operation transport for purpose-specific API consumers
 * kept in their own files (`api/gmail.ts`): same auth, Space header, error and
 * idempotency handling as every call here.
 */
export const apiTransport = { request, operationAt }

/** Generic query adapter. Discovery is a real core consumer; no automatic retries. */
export function queryOperation<Id extends OperationId>(id:Id,input:OperationInput<Id>,options:RequestOptions={}):Promise<OperationOutcome<OperationOutput<Id>>> {
  return request('GET',`/queries/${encodeURIComponent(id)}?input=${encodeURIComponent(JSON.stringify(input))}`,undefined,options)
}

export function callOperation<Id extends OperationId>(id:Id,input:OperationInput<Id>,key:string,options:RequestOptions={}):Promise<OperationOutcome<OperationOutput<Id>>> {
  if(!key)throw new Error('An explicit idempotency key is required')
  return request('POST',`/actions/${encodeURIComponent(id)}`,input,{...options,idempotencyKey:key})
}

/** One explicit-key command attempt; never retried. Returns only the body-free receipt. */
export async function commandReceipt<Id extends OperationId>(id:Id,input:OperationInput<Id>,key:string,options:RequestOptions={}):Promise<OperationOutput<Id>> {
  const result=await callOperation(id,input,key,options)
  if(!('status' in result)||result.status!=='succeeded')throw new Error('Command did not complete')
  return result.data
}

/** A read-only core query sent to its retained POST URL (no key; bodies can exceed a query string). */
export async function queryAt<T>(path:string,body:unknown,options:RequestOptions={}):Promise<T>{
  const result=await post<OperationOutcome<T>>(path,body,options)
  if(!('status' in result)||result.status!=='succeeded')throw new Error('Query did not complete')
  return result.data
}

export function found<T extends {id:string}>(rows:readonly T[],id:string,label:string):T{
  const row=rows.find(r=>r.id===id);if(!row)throw new Error(`${label} is no longer available`);return row
}

/** Local manifest adapters use the same transport and mandatory explicit command keys as core operations. */
export function queryPluginOperation<T>(id:import('@rainver/protocol').PluginOperationId,input:unknown,options:RequestOptions={}):Promise<OperationOutcome<T>>{
 return request('GET',`/queries/${encodeURIComponent(id)}?input=${encodeURIComponent(JSON.stringify(input))}`,undefined,options)
}

export function callPluginOperation<T>(id:import('@rainver/protocol').PluginOperationId,input:unknown,key:string,options:RequestOptions={}):Promise<OperationOutcome<T>>{
 if(!key)throw new Error('An explicit idempotency key is required')
 return request('POST',`/actions/${encodeURIComponent(id)}`,input,{...options,idempotencyKey:key})
}
export async function projectManagementCall<Id extends keyof typeof import('@rainver/protocol').PROJECT_MANAGEMENT_SCHEMAS>(id:Id,input:OperationInput<Id>,key:string){
  const result=await callOperation(id,input,key);
  if(!('status' in result)||result.status!=='succeeded')throw new Error('Project command did not complete');
  return result.data;
}

/** User mutation keys belong to the event; a caller can explicitly retry the same input/key.
 * No write retry is performed here. Receipts never cache Note content. */
export async function noteObjectCall<Id extends import('@rainver/protocol').OperationId>(id:Id,input:import('@rainver/protocol').OperationInput<Id>,key:string){
 try{const result=await callOperation(id,input,key);if(!('status' in result)||result.status!=='succeeded')throw new Error('Note action did not complete');return result.data;}
 catch(e){if(e instanceof ApiRequestError){const metadata=(e.payload?.error as {metadata?:Record<string,unknown>}|undefined)?.metadata;if(metadata&&['note_owning_entry_required','note_cross_project_share_required'].includes(String(metadata.code)))throw new ApiRequestError(e.message,e.status,String(metadata.code),metadata);}throw e;}
}
