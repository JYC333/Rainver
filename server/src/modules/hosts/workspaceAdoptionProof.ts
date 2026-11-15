import {isWireRelativePath,looksSecretLikePath} from '@rainver/folder-read';

type Git=(argv:string[])=>Promise<string|null>;
export const validCommit=(c:string)=>/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(c);
/** Whole changed paths include deletions and modes; bounded literal pathspecs. */
export async function adoptionPaths(git:Git,base:string,source:string):Promise<string[]|null>{
 if(![base,source].every(validCommit)||await git(['merge-base','--is-ancestor',base,source])===null)return null;
 const raw=await git(['--literal-pathspecs','diff','--name-only','--no-ext-diff','--no-textconv','--no-renames','-z',base,source,'--']);
 if(raw===null||!raw.endsWith('\0')||Buffer.byteLength(raw)>128*1024)return null;
 const paths=raw.split('\0').filter(Boolean);
 return !paths.length||paths.length>500||paths.some(p=>p.length>4096||!isWireRelativePath(p)||p.split('/').some(s=>s==='..'||s==='.git')||looksSecretLikePath(p))?null:paths;
}
/** Find an actual version in current target history, never a reflog or an
 * unreachable object. A bounded miss preserves work for later review. */
export async function findHistoricalAdoption(git:Git,base:string,source:string,target:string,paths:string[]):Promise<string|null>{
 if(await git(['merge-base','--is-ancestor',source,target])!==null)return source;
 if(await git(['merge-base','--is-ancestor',base,target])===null)return null;
 const history=await git(['--literal-pathspecs','rev-list','--full-history','--max-count=50',target,'--',...paths]);
 if(history===null)return null;
 for(const at of [...new Set([target,...history.trim().split(/\s+/).filter(validCommit)])]){
  if(await git(['--literal-pathspecs','diff','--quiet','--no-ext-diff','--no-textconv',source,at,'--',...paths])!==null)return at;
 }
 return null;
}
