import {mkdtemp,rm,mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {afterEach,beforeEach,beforeAll,expect,it} from 'vitest';
import {acquireDaemonLease} from '../src/daemonLease.js';
import {runService} from '../src/commands/run.js';
import {saveConfig} from '../src/config.js';
const exec=promisify(execFile);
let dir:string;
beforeEach(async()=>{dir=await mkdtemp(join(tmpdir(),'rainver-owner-lease-'));process.env.RAINVER_HOST_CONFIG_DIR=dir;});
afterEach(async()=>{delete process.env.RAINVER_HOST_CONFIG_DIR;await rm(dir,{recursive:true,force:true});});
// Exercise the actual owner command built from this checkout, never stale dist.
beforeAll(async()=>{await exec(process.execPath,[resolve('node_modules/typescript/bin/tsc'),'-p','tsconfig.build.json']);});
const cli=resolve('dist/cli.js');
const linuxIt=it.skipIf(process.platform!=='linux');
const env=()=>({PATH:process.env.PATH,RAINVER_HOST_CONFIG_DIR:dir});
linuxIt('excludes actual owner CLI mutation and foreground daemon with the same kernel lease',async()=>{
 await saveConfig({server_url:'http://127.0.0.1:9',host_id:'h',trust:'trusted',token:'t',workspaces:{}});
 const release=await acquireDaemonLease(dir);
 try{
  await expect(runService()).rejects.toThrow('host_daemon_busy');
  await expect(exec(process.execPath,[cli,'ignored','discard','--location','fixture','--key','fixture','--confirm-discard'],{env:env()})).rejects.toMatchObject({stderr:expect.stringContaining('host_daemon_busy')});
 }finally{await release();}
 const base=join(dir,'task-worktrees-quarantine','fixture','fixture-preserved-ignored');await mkdir(join(base,'files'),{recursive:true});
 await writeFile(join(base,'manifest.json'),JSON.stringify({version:2,location_id:'fixture',workspace_key:'fixture',original_root:dir,paths:[],state:'preserved',retention:'owner_review',bytes:0}));
 await expect(exec(process.execPath,[cli,'ignored','discard','--location','fixture','--key','fixture'],{env:env()})).rejects.toMatchObject({stderr:expect.stringContaining('explicit')});
 expect(JSON.parse(await readFile(join(base,'manifest.json'),'utf8')).state).toBe('preserved');
 // No installation root, systemd or --offline assertion substitutes for the lock.
 expect((await exec(process.execPath,[cli,'ignored','discard','--location','fixture','--key','fixture','--confirm-discard'],{env:env()})).stdout).toContain('discarded');
});
linuxIt('releases the kernel lock when its owning process crashes',async()=>{
 const moduleUrl=new URL('../dist/daemonLease.js',import.meta.url).href;
 const child=spawn(process.execPath,['--input-type=module','-e',`import {acquireDaemonLease} from ${JSON.stringify(moduleUrl)};await acquireDaemonLease(process.env.RAINVER_HOST_CONFIG_DIR);process.stdout.write('ready');setInterval(()=>{},1000);`],{env:env(),stdio:['ignore','pipe','pipe']});
 await new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('exit',()=>reject(new Error('fixture exited')));child.stdout.once('data',()=>resolve());});
 await expect(acquireDaemonLease(dir)).rejects.toThrow('host_daemon_busy');
 const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await exited;
 let release:(()=>Promise<void>)|undefined;
 for(let i=0;i<50&&!release;i++){
  try{release=await acquireDaemonLease(dir);}catch{await new Promise(resolve=>setTimeout(resolve,20));}
 }
 expect(release).toBeTypeOf('function');await release!();
});
linuxIt('keeps the lease while the service process group receives SIGTERM and the parent drains',async()=>{
 const moduleUrl=new URL('../dist/daemonLease.js',import.meta.url).href;
 const child=spawn(process.execPath,['--input-type=module','-e',`import {acquireDaemonLease} from ${JSON.stringify(moduleUrl)};process.on('SIGTERM',()=>process.stdout.write('draining'));const release=await acquireDaemonLease(process.env.RAINVER_HOST_CONFIG_DIR);process.stdout.write('ready');process.stdin.resume();process.stdin.once('data',async()=>{await release();process.exit(0);});`],{env:env(),detached:true,stdio:['pipe','pipe','pipe']});
 const data=()=>new Promise<string>((resolve,reject)=>{child.stdout.once('data',chunk=>resolve(chunk.toString()));child.once('error',reject);});
 try{
  expect(await data()).toBe('ready');
  const draining=data();process.kill(-child.pid!,'SIGTERM');expect(await draining).toBe('draining');
  await expect(acquireDaemonLease(dir)).rejects.toThrow('host_daemon_busy');
  const exited=new Promise(resolve=>child.once('exit',resolve));child.stdin.end('release');await exited;
  const release=await acquireDaemonLease(dir);await release();
 }finally{try{process.kill(-child.pid!,'SIGKILL');}catch{}}
});
linuxIt('fails closed with a diagnostic when flock is missing or unsupported',async()=>{
 const path=process.env.PATH;
 try{
  process.env.PATH=dir;
  await expect(acquireDaemonLease(dir)).rejects.toThrow('host_daemon_lock_unavailable');
  const {chmod}=await import('node:fs/promises');
  await writeFile(join(dir,'flock'),'#!/bin/sh\necho "locking unsupported" >&2\nexit 69\n');await chmod(join(dir,'flock'),0o700);
  await expect(acquireDaemonLease(dir)).rejects.toThrow('locking unsupported');
 }finally{process.env.PATH=path;}
});

linuxIt('exposes bounded owner CLI pages and per-item errors using the returned frontier',async()=>{
 const base=join(dir,'task-worktrees-quarantine','fixture');await mkdir(base,{recursive:true});
 for(const key of ['a','b','c','d'])await writeFile(join(base,`${key}-blocked-ignored.json`),JSON.stringify({blocked_reason:'fixture'}));
 await writeFile(join(base,'aa-blocked-ignored.json'),'{');
 const list=async(after?:string)=>JSON.parse((await exec(process.execPath,[cli,'ignored','list','--location','fixture','--limit','2',...(after?['--after',after]:[])],{env:env()})).stdout);
 const first=await list();expect(first.items.map((i:any)=>i.key)).toEqual(['a']);expect(first.errors).toHaveLength(1);expect(first.next).toBe('aa-blocked-ignored.json');
 const second=await list(first.next);expect(second.items.map((i:any)=>i.key)).toEqual(['b','c']);
 const last=await list(second.next);expect(last.items.map((i:any)=>i.key)).toEqual(['d']);expect(last.next).toBeNull();
});
