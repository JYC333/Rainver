import {constants} from 'node:fs';
import {lstat,open,realpath,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {acquireIgnoredAdmission} from './workspaceIgnoredAdmission.js';
import {sweepWorkspaceFilePage} from './workspaceFilePages.js';
import {workspaceIdentity} from './worktreeIdentity.js';
import {taskLeaseKey,validTaskWorktreeIds,withTaskHeld} from './taskWorktree.js';
import {unchangedReceipt} from './workspaceReceiptExpiry.js';
import {releasedReceiptMayExpire} from './workspaceRetention.js';

/** A refusal is evidence until the exact owner has completed release. Neither
 * its age nor a neighbouring successful cleanup proves that fact. Lock order
 * matches preservation: Task first, then Location admission. */
export async function sweepIgnoredBlockedReceipts(config:string,location:string,log:(line:string)=>void){
 const dir=join(config,'task-worktrees-quarantine',location);
 await sweepWorkspaceFilePage(dir,'ignored-blocked-'+location,async name=>{
  if(!name.endsWith('-blocked-ignored.json'))return;
  const key=name.slice(0,-'-blocked-ignored.json'.length);
  if(!workspaceIdentity(key)||!validTaskWorktreeIds(location,key)){log(`ignored refusal ${location}/${name}: legacy_owner_unknown; owner review required`);return;}
  await withTaskHeld(taskLeaseKey(location,key),async()=>{
   const release=await acquireIgnoredAdmission(config,location);
   try{
    const path=join(dir,name),before=await lstat(path),h=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    let value:Record<string,unknown>;
    try{const st=await h.stat();if(!st.isFile()||st.size>2*1024*1024)throw new Error('workspace_ignored_receipt_invalid');value=JSON.parse(await h.readFile('utf8'));}finally{await h.close();}
    if(value.version!==2||value.location_id!==location||value.workspace_key!==key||value.state!=='rolled_back'
     ||!Array.isArray(value.paths)||value.paths.length||typeof value.blocked_reason!=='string'
     ||value.original_root!==join(await realpath(config),'task-worktrees',location,key)){
     log(`ignored refusal ${location}/${name}: receipt_identity_unproven; owner review required`);return;
    }
    if(!await releasedReceiptMayExpire(location,key)||!await unchangedReceipt(path,before,value))return;
    await rm(path);const directory=await open(dir,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await directory.sync();}finally{await directory.close();}
   }finally{release();}
  });
 },log);
}
