import {createHash} from "node:crypto";
import type { Pool } from "../../db/pool.js";
import { SourceRequestSchema, type SourceResponse } from "@rainver/protocol";
import { outboundGuard, fetchGuarded, type OutboundGuard } from "./outboundUrlSafety.js";
import { admitSourceRequestGroups, coolDownSourceRequests, type RequestQuotaWindow } from "./sourceRequestQuota.js";

export class SourceRequestError extends Error {
  constructor(readonly code: string, readonly retryAt?: string) { super(code); }
}
export interface SourceRequestRoute {
  origin: string;
  path_prefix: string;
  methods: readonly ("GET" | "HEAD")[];
  query_keys?: readonly string[];
  /** Bound to this exact route; only server-owned callbacks may resolve secrets. */
  credentialHeaders?: () => Promise<Record<string, string>>;
}
export interface SourceRequestGrant {
  /** Server-resolved Source/Space/owner authorization context, not account identity. */
  scopeId:string;
  quotaGroup: string;
  quota: readonly RequestQuotaWindow[];
  endpointQuotas?: readonly { key: string; windows: readonly RequestQuotaWindow[] }[];
  routes: readonly SourceRequestRoute[];
  maxBytes: number;
  deadlineMs: number;
  authorize: () => Promise<void>;
}

/** Byte replacement preserves every untouched byte, including PDF and non-UTF8.
 * Short credential values are refused at resolution rather than corrupting arbitrary content. */
function redact(bytes: Uint8Array, secrets: Set<string>): Buffer {
  let body = Buffer.from(bytes);
  for (const secret of [...secrets].sort((a,b) => b.length-a.length)) {
    const needle = Buffer.from(secret); const chunks: Buffer[] = []; let offset = 0, index: number;
    while ((index = body.indexOf(needle, offset)) >= 0) {
      chunks.push(body.subarray(offset,index),Buffer.from("[REDACTED]")); offset=index+needle.length;
    }
    if (offset) { chunks.push(body.subarray(offset)); body=Buffer.concat(chunks); }
  }
  return body;
}
function routeFor(grant: SourceRequestGrant, url: URL, method: "GET" | "HEAD"): SourceRequestRoute {
  let path:string;try{path=decodeURIComponent(url.pathname)}catch{throw new SourceRequestError("source_scope_refused");}
  if (url.username || url.password || url.hash || /[\\\x00-\x1f%]/.test(path) || path.includes("//")
    || path.split("/").some(segment=>segment==="." || segment==="..")) throw new SourceRequestError("source_scope_refused");
  const matches=grant.routes.filter(route=>route.origin===url.origin && route.methods.includes(method)
    && (path===route.path_prefix || path.startsWith(route.path_prefix.endsWith("/")?route.path_prefix:route.path_prefix+"/")));
  if (matches.length!==1 || [...url.searchParams.keys()].some(key=>!matches[0].query_keys?.includes(key))) throw new SourceRequestError("source_scope_refused");
  return matches[0];
}
export type SourceRequestBroker = ((raw:unknown, perCallSignal?:AbortSignal)=>Promise<SourceResponse>) & {readonly scopeSha256:string;readonly authorizeExecution:(signal:AbortSignal)=>Promise<void>};
export function createSourceRequestBroker(pool: Pool, grant: SourceRequestGrant, signal: AbortSignal,
  guard: OutboundGuard = outboundGuard): SourceRequestBroker {
  // Permission callbacks stay live; configuration is a snapshot for checkpoint identity.
  grant={...grant,quota:grant.quota.map(w=>({...w})),endpointQuotas:grant.endpointQuotas?.map(g=>({...g,windows:g.windows.map(w=>({...w}))})),
    routes:grant.routes.map(r=>({...r,methods:[...r.methods],query_keys:r.query_keys?[...r.query_keys]:undefined}))};
  let sequence=0, busy=false;
  if(!/^[A-Za-z0-9:_-]{1,256}$/.test(grant.scopeId))throw new SourceRequestError("source_scope_invalid");
  if (!Number.isInteger(grant.maxBytes) || grant.maxBytes<1 || grant.maxBytes>8*1024*1024
    || !Number.isInteger(grant.deadlineMs) || grant.deadlineMs<1 || grant.deadlineMs>120_000) throw new Error("Invalid request bounds");
  for (const route of grant.routes) {
    const origin=new URL(route.origin);
    if (origin.origin!==route.origin || !route.path_prefix.startsWith("/") || /[%\\?#]/.test(route.path_prefix)
      || route.path_prefix.includes("//") || route.path_prefix.split("/").some(p=>p==="."||p==="..")
      || (route.credentialHeaders && origin.protocol!=="https:")) throw new SourceRequestError("source_scope_invalid");
  }
  const broker = async (raw:unknown, perCallSignal?:AbortSignal):Promise<SourceResponse> => {
    const combined=AbortSignal.any([signal,...perCallSignal?[perCallSignal]:[],AbortSignal.timeout(grant.deadlineMs)]);
    const check=()=>{if(combined.aborted) throw new SourceRequestError(combined.reason?.name==="TimeoutError"?"source_timeout":"source_cancelled");};
    check(); const parsed=SourceRequestSchema.safeParse(raw);if(!parsed.success)throw new SourceRequestError("source_request_invalid");const request=parsed.data;
    if (busy || request.sequence!==sequence+1) throw new SourceRequestError("source_channel_refused");
    busy=true; sequence=request.sequence;
    const secrets=new Set<string>();
    try {
      const scoped: OutboundGuard={pin:async(url,s)=>{routeFor(grant,url,request.method);check();return guard.pin(url,s);}};
      const response=await fetchGuarded({url:request.url,method:request.method,headers:request.headers,
        maxDownloadBytes:grant.maxBytes,deadlineMs:grant.deadlineMs,signal:combined,readErrorBody:true,
        headersForHop:async(url)=>{
          check(); const route=routeFor(grant,url,request.method);
          try { await grant.authorize(); } catch { throw new SourceRequestError("source_authority_revoked"); }
          check(); let credentials:Record<string,string>;try{credentials=await route.credentialHeaders?.() ?? {}}catch{throw new SourceRequestError("source_credential_unavailable");}check();
          for(const value of Object.values(credentials)) {
            const secret=value.replace(/^(?:Bearer|Basic|Token|ApiKey)\s+/i,"");
            if(Buffer.byteLength(secret)<8) throw new SourceRequestError("source_credential_invalid");
            for(const v of [value,secret]) {secrets.add(v);secrets.add(encodeURIComponent(v));secrets.add(encodeURIComponent(v).replace(/%[0-9A-F]{2}/g,m=>m.toLowerCase()));}
          }
          return {credentialHeaders:credentials};
        },
        beforeSend:async()=>{
          check();
          const admission=await admitSourceRequestGroups(pool,[{key:grant.quotaGroup,windows:grant.quota},...grant.endpointQuotas??[]],combined);
          check(); if(!admission.allowed) throw new SourceRequestError("source_quota_exhausted",admission.retryAt);
          try{await grant.authorize()}catch{throw new SourceRequestError("source_authority_revoked");}
          check();
        },
      },scoped);
      let retryAt:string|undefined;
      if(response.status===429 || response.status===503 && response.headers.has("retry-after")) {
        retryAt=await coolDownSourceRequests(pool,[grant.quotaGroup,...grant.endpointQuotas?.map(g=>g.key)??[]],response.headers.get("retry-after"));
      }
      check(); if(response.truncated) throw new SourceRequestError("source_response_too_large");
      const body=redact(response.bytes,secrets);
      if(body.length>grant.maxBytes)throw new SourceRequestError("source_response_too_large");
      const headers: Record<string,string>={};
      for(const name of ["etag","last-modified","link"]) {
        const value=response.headers.get(name); if(value && value.length<=4096) headers[name]=redact(Buffer.from(value),secrets).toString();
      }
      return {sequence:request.sequence,status:response.status,body_base64:body.toString("base64"),
        content_type:redact(Buffer.from(response.headers.get("content-type")??""),secrets).toString().slice(0,256),
        final_url:redact(Buffer.from(response.url),secrets).toString(),headers,...retryAt?{retry_at:retryAt}:{}};
    } catch(error) {
      check(); if(error instanceof SourceRequestError) throw error;
      throw new SourceRequestError(error instanceof Error && error.name==="OutboundRefusedError"?"source_network_refused":"source_network_failed");
    } finally {busy=false;}
  };
  const scopeSha256=createHash("sha256").update(JSON.stringify({scope:grant.scopeId,account:grant.quotaGroup,quota:grant.quota,endpoints:grant.endpointQuotas,
    routes:grant.routes.map(r=>({origin:r.origin,path:r.path_prefix,methods:r.methods,query:r.query_keys,credentialed:!!r.credentialHeaders})),maxBytes:grant.maxBytes,deadline:grant.deadlineMs})).digest("hex");
  const authorizeExecution=async(perCall:AbortSignal)=>{
    const combined=AbortSignal.any([signal,perCall]);
    if(combined.aborted)throw new SourceRequestError("source_cancelled");
    try{await grant.authorize()}catch{throw new SourceRequestError("source_authority_revoked");}
    if(combined.aborted)throw new SourceRequestError("source_cancelled");
  };
  return Object.defineProperties(broker,{scopeSha256:{value:scopeSha256,writable:false},authorizeExecution:{value:authorizeExecution,writable:false}}) as SourceRequestBroker;
}
