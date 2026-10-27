import type {SourceResponse} from '@rainver/protocol';
/** Keys/types only: bounded diagnostics for model repair without retaining source
 * text in public read models. Raw calibration fixtures stay private. */
export function goalResponseDiagnostic(response:SourceResponse){
 const shape=(x:unknown,depth=0):unknown=>{if(depth>=3)return Array.isArray(x)?'array':typeof x;if(Array.isArray(x))return {array:x.length?shape(x[0],depth+1):'empty'};if(x&&typeof x==='object')return Object.fromEntries(Object.entries(x).slice(0,32).map(([k,v])=>[k.slice(0,64),shape(v,depth+1)]));return x===null?'null':typeof x;};
 let jsonShape:unknown;try{if(response.content_type.includes('json'))jsonShape=shape(JSON.parse(Buffer.from(response.body_base64,'base64').toString('utf8')));}catch{}
 const media=response.content_type.split(';')[0].trim().toLowerCase();
 return {status:response.status,content_type:/^(application\/(json|[^/]+\+json|xml|rss\+xml|atom\+xml)|text\/(xml|html))$/.test(media)?media:'application/octet-stream',...(jsonShape?{schema_only:true,json_shape:jsonShape}:{})};
}
