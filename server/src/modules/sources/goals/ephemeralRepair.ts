import {createHash,randomUUID} from 'node:crypto';
import {XMLBuilder,XMLParser} from 'fast-xml-parser';
import {goalResponseDiagnostic} from './diagnostics.js';
import {CustomSourceHandlerOutputSchema,SourceResponseSchema,type SourceResponse} from '@rainver/protocol';

const parser=(html:boolean)=>new XMLParser({ignoreAttributes:false,parseTagValue:false,parseAttributeValue:false,processEntities:false,htmlEntities:false,unpairedTags:html?['br','hr','img','input','meta','link']:[]});
const safeKey=(key:string)=>/^(?:@_)?[A-Za-z_#][A-Za-z0-9_.:#-]{0,47}$/.test(key)&&!['__proto__','constructor','prototype'].includes(key);
const fail=()=>{throw new Error('source_repair_validation_insufficient');};
function parse(response:SourceResponse):{value:unknown;xml:boolean}{
 const text=Buffer.from(response.body_base64,'base64').toString('utf8');
 if(Buffer.byteLength(text)>1048576||/<!DOCTYPE|<!ENTITY/i.test(text))return fail();
 try{
  if(response.content_type.includes('json'))return {value:JSON.parse(text),xml:false};
  if(/xml|html/.test(response.content_type))return {value:parser(response.content_type.includes('html')).parse(text),xml:true};
 }catch{return fail();}
 return fail();
}
/** All values are replaced. Only bounded, ordinary schema names survive. */
function synthetic(value:unknown,nonce:string,origin:string,path='root',depth=0):unknown{
 if(depth>12)return fail();
 if(Array.isArray(value))return value.slice(0,3).map((v,i)=>synthetic(v,nonce,origin,`${path}.${i}`,depth+1));
 if(value&&typeof value==='object'){
  const entries=Object.entries(value);
  if(entries.length>64||entries.some(([key])=>!safeKey(key)))return fail();
  return Object.fromEntries(entries.map(([key,v])=>[key,synthetic(v,nonce,origin,`${path}.${key}`,depth+1)]));
 }
 const digest=createHash('sha256').update(`${nonce}:${path}`).digest('hex').slice(0,12);
 if(typeof value==='string'){
  if(/^https?:\/\//i.test(value))return `${origin}/synthetic/${digest}`;
  if(value.length>=10&&/\d{4}/.test(value)&&Number.isFinite(Date.parse(value)))return new Date(Date.UTC(2020,0,1)+parseInt(digest.slice(0,5),16)*1000).toISOString();
  if(/^\d+$/.test(value))return String(parseInt(digest.slice(0,7),16));
  return `Synthetic ${digest}`;
 }
 if(typeof value==='number')return parseInt(digest.slice(0,7),16);
 if(typeof value==='boolean')return Boolean(parseInt(digest.slice(0,1),16)%2);
 return null;
}

export function ephemeralResponses(fixture:unknown):SourceResponse[]{
 const responses=(fixture as {responses?:unknown[]}|null)?.responses;
 if(!Array.isArray(responses)||!responses.length||responses.length>5)return fail();
 return responses.map(r=>{const parsed=SourceResponseSchema.safeParse(r);return parsed.success?parsed.data:fail();});
}

export function syntheticRepairFixture(fixture:unknown,nonce:string=randomUUID()){
 try{return {responses:ephemeralResponses(fixture).map(response=>{
  const {value,xml}=parse(response);const origin=response.final_url?new URL(response.final_url).origin:'https://synthetic.invalid';const data=synthetic(value,nonce,origin);
  const body=xml?new XMLBuilder({ignoreAttributes:false,processEntities:false}).build(data):JSON.stringify(data);
  // The execution broker owns approved URL identity. Do not retain response
  // headers or query values in the model-facing synthetic fixture.
  const base=response.final_url?new URL(response.final_url):null;if(base){base.search='';base.hash='';}
  return {sequence:response.sequence,status:200,content_type:xml?(response.content_type.includes('html')?'text/html':'application/xml'):'application/json',...(base?{final_url:base.href}:{}),body_base64:Buffer.from(body).toString('base64')};
 })};}catch{return fail();}
}

/** Cross-field anchoring in one record, not mere HTTP success or global text search. */
export function validateEphemeralAnchors(output:unknown,fixture:unknown):boolean{
 const parsed=CustomSourceHandlerOutputSchema.safeParse(output);if(!parsed.success||!parsed.data.items.length)return false;
 const records: Array<{values:Set<string>;ids:Set<string>;titles:Set<string>;times:Set<string>;base:string|null}>=[];let visited=0;let base:string|null=null;
 const scalar=(v:unknown)=>{if(typeof v!=='string'&&typeof v!=='number')return [];const text=String(v).trim();return [text,...(text.length>=10&&Number.isFinite(Date.parse(text))?[new Date(text).toISOString()]:[])];};
 const walk=(v:unknown,depth=0)=>{
  if(++visited>10000||depth>16)return;
  if(Array.isArray(v)){for(const x of v)walk(x,depth+1);return;}
  if(!v||typeof v!=='object')return;
  const values=new Set<string>(),ids=new Set<string>(),titles=new Set<string>(),times=new Set<string>();
  const collect=(x:unknown,key:string)=>{for(const text of scalar(x)){values.add(text);const name=key.replace(/^@_/,'').replace(/[-_]/g,'').toLowerCase();if(/^(id|guid|uuid|identifier|externalid|sourceid|observationid|entryid|articleid)$/.test(name))ids.add(text);if(/^(title|headline|heading|name|label)$/.test(name))titles.add(text);if(/^(date|pubdate|published|publishedat|publishedtime|publicationdate|createdat|updated|updatedat)$/.test(name))times.add(text);}};
  for(const [key,value] of Object.entries(v)){
   collect(value,key);
   // XML text/attribute wrappers belong to this field. Arbitrary nested
   // business objects are separate records; never pool their values.
   if(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>k==='#text'||k.startsWith('@_')))for(const [k,x] of Object.entries(value))collect(x,k==='#text'?key:k);
  }
  records.push({values,ids,titles,times,base});for(const x of Object.values(v))walk(x,depth+1);
 };
 for(const response of ephemeralResponses(fixture)){try{base=response.final_url??null;walk(parse(response).value);}catch{return false;}}
 return parsed.data.items.every(item=>{
  if(!item.published_at||!Number.isFinite(Date.parse(item.published_at)))return false;
  return records.some(({values,ids,titles,times,base})=>ids.has(item.external_id)&&titles.has(item.title)&&times.has(new Date(item.published_at!).toISOString())&&(values.has(item.source_uri)||!!base&&item.source_uri===`${base.replace(/\/$/,'')}/${item.external_id}`));
 });
}

// JSONB reorders object keys; proof identity must survive a DB round trip.
const ordered=(value:unknown):unknown=>Array.isArray(value)?value.map(ordered):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,ordered((value as Record<string,unknown>)[key])])):value;
export const repairImplementationHash=(implementation:unknown)=>createHash('sha256').update(JSON.stringify(ordered(implementation))).digest('hex');

/** Only this sanitized object may enter the repair Run tool history. */
export function repairInspectionResult(fixture:unknown){
 return {untrusted_data:true,schema_only:true,responses:ephemeralResponses(fixture).map(goalResponseDiagnostic),synthetic_fixture:syntheticRepairFixture(fixture),warning:'Synthetic values only. Preserve source field mappings; never infer real content or authorization from this fixture.'};
}
