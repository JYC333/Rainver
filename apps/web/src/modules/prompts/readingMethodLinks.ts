import {safeAppPath} from '../../lib/safeHttpUrl'
import {readingReturnTo} from '../library/readingLinks'
/** Navigation only, never authority. Keep the original Reader origin (notably serendipity). */
export function readingMethodReturn(itemId:string,raw:string|null,projectId?:string|null):string{
 const fallback=`/library/items/${encodeURIComponent(itemId)}?from=${projectId?'project':'library'}`
 if(!raw||safeAppPath(raw)!==raw)return fallback
 const [path,query='']=raw.split('?');if(raw.split('?').length>2)return fallback
 const expected=`/library/items/${encodeURIComponent(itemId)}`
 const daily=/^\/library\/digests\/[\w-]{1,64}\/\d{4}-\d{2}-\d{2}\/items\/([\w-]{1,64})$/.exec(path)
 if(path!==expected&&daily?.[1]!==itemId)return fallback
 const q=new URLSearchParams(query),keys=[...q.keys()]
 if(new Set(keys).size!==keys.length||keys.some(k=>!['from','returnTo','projectId','change'].includes(k)))return fallback
 if(q.has('from')&&!['project','serendipity','library'].includes(q.get('from')!))return fallback
 if(q.has('projectId')&&!/^[\w-]{1,64}$/.test(q.get('projectId')!))return fallback
 if(q.has('change')&&!/^[\w-]{1,64}$/.test(q.get('change')!))return fallback
 if(q.has('returnTo')&&!readingReturnTo(q.get('returnTo'),q.get('projectId')))return fallback
 return path+(q.size?`?${q.toString()}`:'')
}
