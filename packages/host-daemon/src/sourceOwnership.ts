import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile, rmdir, realpath, link, lstat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { helperProcessEnv } from "./providerBinding.js";
const exec=promisify(execFile);
export const sourceUnitPrefix=(root:string)=>`rainver-source-${createHash("sha256").update(root).digest("hex").slice(0,16)}-`;
async function processIdentity(pid:number):Promise<string>{
  const stat=await readFile(`/proc/${pid}/stat`,"utf8");
  return (await readFile("/proc/sys/kernel/random/boot_id","utf8")).trim()+":"+stat.slice(stat.lastIndexOf(")")+2).split(" ")[19];
}
export async function sourceOwner():Promise<{pid:number;identity:string}>{return {pid:process.pid,identity:await processIdentity(process.pid)};}
async function alive(owner:{pid:number;identity:string}):Promise<boolean>{
  try{return await processIdentity(owner.pid)===owner.identity;}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return false;throw error;}
}
/** Publish a complete owner atomically. A crash before link cannot occupy the lease.
 * Temporary names carry boot/start identity, allowing scoped orphan cleanup even
 * if the process died before writing a single owner byte. */
export async function acquireSourceCollectionLease(dir:string):Promise<void>{
  const owner=await sourceOwner();
  const temporary=join(dir,`.lease-${owner.pid}-${owner.identity.replace(":","_")}-${randomUUID()}`);
  try{
    await writeFile(temporary,JSON.stringify(owner),{flag:"wx",mode:0o600});
    // Old ownerless lease directories are harmless; only owner claims the lock.
    for(let attempt=0;;attempt++){
      await mkdir(join(dir,"lease"),{recursive:true,mode:0o700});
      try{await link(temporary,join(dir,"lease","owner"));break;}
      catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT" || attempt>=3)throw error;}
    }
  }finally{await unlink(temporary).catch(error=>{if(error.code!=="ENOENT")throw error});}
}
/** Release the record, then remove only an empty directory: never recursively
 * delete a contender which published immediately after our unlink. */
export async function releaseSourceCollectionLease(dir:string):Promise<void>{
  await unlink(join(dir,"lease","owner"));
  await rmdir(join(dir,"lease")).catch(error=>{if(!["ENOENT","ENOTEMPTY","EEXIST"].includes(error.code))throw error;});
}
/** Wait for kernel task teardown before removing the owned cgroup. */
export async function stopSourceCgroup(group:string):Promise<void>{
  await writeFile(join(group,"cgroup.kill"),"1").catch(error=>{if(error.code!=="ENOENT")throw error});
  for(let attempt=0;attempt<50;attempt++){
    try{await rmdir(group);return}catch(error){
      if((error as NodeJS.ErrnoException).code==="ENOENT")return;
      if((error as NodeJS.ErrnoException).code!=="EBUSY" || attempt===49)throw error;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
  }
}
/** Recover only durable ownership records inside this daemon-owned root. Never
 * enumerate or stop somebody else's systemd units/cgroups by a broad prefix. */
export async function recoverSourceExecutions(host:{root:string;cgroupRoot?:string}):Promise<void>{
  await mkdir(host.root,{recursive:true,mode:0o700});
  host={...host,root:await realpath(host.root),cgroupRoot:host.cgroupRoot?await realpath(host.cgroupRoot):undefined};
  for(const entry of await readdir(host.root,{withFileTypes:true})){
    if(!entry.isDirectory() || !/^source-[A-Za-z0-9_-]+$/.test(entry.name))continue;
    const path=join(host.root,entry.name);
    let owner:{pid:number;identity:string;unit:string;cgroupRoot:string|null};
    try{owner=JSON.parse(await readFile(join(path,"owner.json"),"utf8"));}catch{continue;}
    if(await alive(owner)){if(owner.pid!==process.pid)throw new Error("source_execution_root_busy");continue;}
    if(!owner.unit.startsWith(sourceUnitPrefix(host.root)) || !/^[a-z0-9-]+$/.test(owner.unit))throw new Error("source_recovery_refused");
    if(owner.cgroupRoot){
      if(owner.cgroupRoot!==host.cgroupRoot)throw new Error("source_recovery_refused");
      await stopSourceCgroup(join(owner.cgroupRoot,owner.unit));
    }else{
      const env=helperProcessEnv({PATH:"/usr/bin:/bin",XDG_RUNTIME_DIR:process.env.XDG_RUNTIME_DIR,DBUS_SESSION_BUS_ADDRESS:process.env.DBUS_SESSION_BUS_ADDRESS});
      // stop is idempotent for an already-collected unit; a missing bus is not recovery.
      await exec("/usr/bin/systemctl",["--user","show-environment"],{env,timeout:5000});
      await exec("/usr/bin/systemctl",["--user","stop",owner.unit+".service"],{env,timeout:5000}).catch(async()=>{
        const {stdout}=await exec("/usr/bin/systemctl",["--user","show",owner.unit+".service","--property=LoadState","--value"],{env,timeout:5000});
        if(stdout.trim()!=="not-found")throw new Error("source_recovery_refused");
      });
    }
    await rm(path,{recursive:true,force:true});
  }
  const collections=join(host.root,"collections");
  let entries:string[];try{entries=await readdir(collections)}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return;throw error;}
  for(const id of entries){
    if(!/^[a-f0-9-]{36}$/.test(id))continue;
    const directory=join(collections,id);
    // Incomplete pre-publication files never block acquisition; clean only dead
    // owners proven by their filename identity, never another collection/scope.
    for(const name of await readdir(directory)){
      const match=/^\.lease-(\d+)-([a-f0-9-]{36})_(\d+)-[a-f0-9-]{36}$/.exec(name);
      if(match && !await alive({pid:Number(match[1]),identity:match[2]+":"+match[3]}))await unlink(join(directory,name));
    }
    const lease=join(directory,"lease");let owner:{pid:number;identity:string};
    try{
      // Read old complete directory records too; new publication is a hard link.
      const stat=await lstat(lease);
      owner=JSON.parse(await readFile(stat.isDirectory()?join(lease,"owner"):lease,"utf8"));
    }catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")continue;throw new Error("source_recovery_refused");}
    if(!await alive(owner)){if((await lstat(lease)).isDirectory())await releaseSourceCollectionLease(directory);else await unlink(lease);}else if(owner.pid!==process.pid)throw new Error("source_execution_root_busy");
  }
}
