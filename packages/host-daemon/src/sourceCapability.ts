import {access,realpath} from "node:fs/promises";
import {constants} from "node:fs";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {helperProcessEnv} from "./providerBinding.js";
const exec=promisify(execFile);
let recoveryBlocked=false;
export function blockSourceExecution():void{recoveryBlocked=true;}
export function sourceExecutionLocallyEnabled():boolean{return process.env.RAINVER_SOURCES_EXECUTION==="1" && !recoveryBlocked;}
/** Opt-in offers a protocol only after basic backend reachability checks. Actual
 * kernel ceilings are still verified in every execution before code import. */
export async function sourceExecutionOffer():Promise<string|null>{
 if(!sourceExecutionLocallyEnabled() || process.platform!=="linux" || !process.versions.node.startsWith("24."))return null;
 try{
  await access("/usr/bin/bwrap",constants.X_OK);
  if(process.env.RAINVER_SOURCE_CGROUP_ROOT){
   const root=await realpath(process.env.RAINVER_SOURCE_CGROUP_ROOT);
   if(!root.startsWith("/sys/fs/cgroup/"))return null;
   await access(root,constants.W_OK);
  }else{
   const env=helperProcessEnv({PATH:"/usr/bin:/bin",XDG_RUNTIME_DIR:process.env.XDG_RUNTIME_DIR,DBUS_SESSION_BUS_ADDRESS:process.env.DBUS_SESSION_BUS_ADDRESS});
   await exec("/usr/bin/systemctl",["--user","show-environment"],{env,timeout:1000});
  }
  return "isolated-v1";
 }catch{return null;}
}
