import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runLocationGit} from '@rainver/folder-read';

/** Conservative content proof for cherry-picked/manually applied changes.
 * Git checks the whole reverse patch against a private index of the committed
 * target. Neither the real index nor working files are touched. An incomplete
 * diff or a failed proof falls back to the ordinary merge/conflict workflow. */
export async function workspaceDeltaAlreadyApplied(root:string,base:string,source:string,target:string):Promise<boolean>{
 const scratch=await mkdtemp(join(tmpdir(),'rainver-adoption-'));
 try{
  const diff=await runLocationGit(['diff','--binary','--full-index','--no-ext-diff','--no-textconv','--no-renames',base,source,'--'],root,30000,{maxOutputBytes:8*1024*1024,outputEncoding:'base64'});
  if(diff.code!==0||diff.incomplete)return false;
  const bytes=Buffer.from(diff.stdout,'base64');
  if(!bytes.length)return true;
  const patch=join(scratch,'change.patch'),env={GIT_INDEX_FILE:join(scratch,'index')};
  await writeFile(patch,bytes);
  const read=await runLocationGit(['read-tree',target],root,30000,{env});
  if(read.code!==0||read.incomplete)return false;
  const proof=await runLocationGit(['apply','--reverse','--cached','--check','--whitespace=nowarn',patch],root,30000,{env,maxOutputBytes:4096});
  return proof.code===0&&!proof.incomplete;
 }finally{await rm(scratch,{recursive:true,force:true});}
}
