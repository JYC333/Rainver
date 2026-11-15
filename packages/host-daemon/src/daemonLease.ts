import {constants} from 'node:fs';
import {mkdir,open} from 'node:fs/promises';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {helperProcessEnv} from './providerBinding.js';

/** Linux kernel lock shared by service, foreground daemon and owner recovery.
 * flock owns an inherited no-follow fd. EOF on the pipe (including parent
 * crash) exits the holder; the kernel releases the lock without stale PID or
 * systemd assumptions. The holder ignores group SIGTERM/INT until its parent
 * finishes draining and closes stdin; --no-fork avoids a second lock owner
 * exiting early. Missing/unsupported flock fails closed for daemon and CLI.
 * The stable lock inode is never unlinked. */
export async function acquireDaemonLease(config:string):Promise<()=>Promise<void>>{
 if(process.platform!=='linux')throw new Error('daemon recovery lease requires Linux');
 await mkdir(config,{recursive:true,mode:0o700});
 const fd=await open(join(config,'daemon.lock'),constants.O_CREAT|constants.O_RDWR|constants.O_NOFOLLOW,0o600);
 const child=spawn('flock',['--exclusive','--nonblock','--no-fork','--conflict-exit-code','75','/proc/self/fd/3',process.execPath,'-e',
  "process.on('SIGTERM',()=>{});process.on('SIGINT',()=>{});process.stdout.write('locked\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));"],
 {stdio:['pipe','pipe','pipe',fd.fd],env:helperProcessEnv({PATH:process.env.PATH})});
 let stderr='';
 child.stderr!.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-1024);});
 const exited=new Promise<void>(resolve=>child.once('close',()=>resolve()));
 try{
  await new Promise<void>((resolve,reject)=>{
   child.once('error',()=>reject(new Error('host_daemon_lock_unavailable: flock could not start')));
   child.once('close',code=>reject(new Error(code===75?'host_daemon_busy':`host_daemon_lock_unavailable: flock exited ${code} (${stderr.trim()})`)));
   child.stdout!.once('data',chunk=>chunk.toString()==='locked\n'?resolve():reject(new Error('host_daemon_lock_failed')));
  });
 }catch(error){child.stdin!.end();await exited;throw error;}finally{await fd.close();}
 return async()=>{child.stdin!.end();await exited;};
}
