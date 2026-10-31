import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it as test } from 'vitest';
const it = test.runIf(process.platform === 'linux');
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, {recursive:true,force:true}))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'host-prerequisite-')); roots.push(root);
  const bin = join(root,'bin'); await mkdir(bin);
  await symlink('/usr/bin/timeout',join(bin,'timeout'));
  const source = await readFile(new URL('../../../ops/scripts/host/install-host.sh', import.meta.url),'utf8');
  const script = join(root,'check.sh');
  await writeFile(script, 'set -euo pipefail\n'+source.slice(source.indexOf('install_read_only_dependency()'),source.indexOf('# The installer refreshes itself first:'))+'\n"$@"\n');
  const log = join(root,'log'); await writeFile(log,'');
  async function executable(name:string,body:string) {const path=join(bin,name);await writeFile(path,'#!/bin/sh\n'+body+'\n',{mode:0o755});return path;}
  async function run(args:string[], extra:NodeJS.ProcessEnv={}) {
    return await new Promise<{code:number|null;out:string;err:string}>((resolve,reject)=>{
      const child=spawn('/bin/bash',[script,...args],{env:{PATH:bin,HOME:root,XDG_CONFIG_HOME:join(root,'config'),TEST_LOG:log,...extra}});
      let out='',err='';child.stdout.on('data',b=>{out+=b;});child.stderr.on('data',b=>{err+=b;});
      child.on('error',reject);child.on('close',code=>resolve({code,out,err}));
    });
  }
  return {root,log,executable,run};
}
it.each([
 ['apt-get','install -y bubblewrap'],['dnf','install -y bubblewrap'],['yum','install -y bubblewrap'],
 ['zypper','--non-interactive install bubblewrap'],['pacman','-S --needed --noconfirm bubblewrap'],['apk','add bubblewrap'],
])('installs only bubblewrap with %s and noninteractive elevation',async(manager,args)=>{
 const f=await fixture();await f.executable(manager,'printf "%s\\n" "$*" >> "$TEST_LOG"');
 await f.executable('sudo','printf "sudo %s\\n" "$1" >> "$TEST_LOG"; [ "$1" = -n ] && shift; exec "$@"');
 const result=await f.run(['install_read_only_dependency']);expect(result.code).toBe(0);expect(result.err).toBe('');
 const log=await readFile(f.log,'utf8');expect(log).toContain(args);if(process.getuid?.()!==0)expect(log).toContain('sudo -n');
});
it('stops on failed package installation with guidance',async()=>{
 const f=await fixture();await f.executable('apt-get','exit 33');await f.executable('sudo','shift; exec "$@"');
 const result=await f.run(['install_read_only_dependency']);expect(result.code).not.toBe(0);expect(result.err).toContain('Retry rainver-host update from a terminal');
});
it('reports unsupported package managers',async()=>{
 const f=await fixture();const result=await f.run(['install_read_only_dependency']);expect(result.code).not.toBe(0);expect(result.err).toContain('no supported system package manager');
});
it('probes with daemon startup configuration and does not install an existing dependency',async()=>{
 const f=await fixture(),binary=await f.executable('bwrap','exit 0');
 await mkdir(join(f.root,'config/rainver-host'),{recursive:true});
 await writeFile(join(f.root,'config/rainver-host/service.env'),`RAINVER_HOST_BWRAP='${binary}'\n`);
 const cli=await f.executable('cli','[ "$1" = check-read-only ] && [ -x "$RAINVER_HOST_BWRAP" ] || exit 1; echo "Read-only parallel review: ready."');
 const result=await f.run(['ensure_read_only_support',cli],{RAINVER_HOST_BWRAP:'/missing/overridden'});
 expect(result.code).toBe(0);expect(result.out).toContain('Read-only parallel review: ready.');expect(await readFile(f.log,'utf8')).toBe('');
});
it('refuses failed or unrecognized probe results even if the binary exists',async()=>{
 const f=await fixture(),binary=await f.executable('bwrap','exit 0');
 for(const body of ['exit 1','echo 0.1.0']){const cli=await f.executable('cli',body);const result=await f.run(['ensure_read_only_support',cli],{RAINVER_HOST_BWRAP:binary});expect(result.code).not.toBe(0);expect(result.err).toContain('no new Host build was activated');}
});
it('does not replace a missing explicitly configured binary',async()=>{
 const f=await fixture();const result=await f.run(['ensure_read_only_support','/missing/cli'],{RAINVER_HOST_BWRAP:join(f.root,'missing')});expect(result.code).not.toBe(0);expect(result.err).toContain('Configured RAINVER_HOST_BWRAP');expect(await readFile(f.log,'utf8')).toBe('');
});
it('fails promptly when unattended administrator permission is refused',async()=>{
 if(process.getuid?.()===0)return; // root needs no elevation
 const f=await fixture();await f.executable('apt-get','echo forbidden >> "$TEST_LOG"');await f.executable('sudo','exit 1');
 const result=await f.run(['install_read_only_dependency']);expect(result.code).not.toBe(0);expect(result.err).toContain('administrator permission');expect(await readFile(f.log,'utf8')).toBe('');
});
