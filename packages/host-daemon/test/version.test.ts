import {execFileSync} from 'node:child_process';
import {mkdtemp, mkdir, copyFile, writeFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import { describe, expect, it } from "vitest";
import packageMetadata from "../package.json";
import { daemonVersion } from "../src/version.js";

describe("daemonVersion", () => {
  it("uses package metadata instead of a duplicated source constant", () => {
    expect(daemonVersion()).toBe(packageMetadata.version);
  });
});

// Exercise the installed app/dist + app/BUILD_ID layout in a real Node process.
it('reports the installed build and distinguishes repeated local builds of one commit',async()=>{
 const root=await mkdtemp(join(tmpdir(),'rainver-version-layout-'));
 try{
  const app=join(root,'app');await mkdir(join(app,'dist'),{recursive:true});
  await writeFile(join(app,'package.json'),JSON.stringify({type:'module',version:packageMetadata.version}));
  await copyFile(new URL('../src/version.ts',import.meta.url),join(app,'dist','version.ts'));
  const code=`import {daemonVersion} from ${JSON.stringify(pathToFileURL(join(app,'dist','version.ts')).href)};process.stdout.write(daemonVersion());`;
  const version=()=>execFileSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8'});
  await writeFile(join(app,'BUILD_ID'),'0123456789abcdef0123456789abcdef01234567\n');expect(version()).toBe(packageMetadata.version+'+0123456789ab');
  await writeFile(join(app,'BUILD_ID'),'local-90194e4f1426-20261108001229-2135126\n');const first=version();
  await writeFile(join(app,'BUILD_ID'),'local-90194e4f1426-20261108010229-2135127\n');const second=version();
  expect(first).not.toBe(second);expect(first).toContain('+local-');expect(second.length).toBeLessThanOrEqual(32);
 }finally{await rm(root,{recursive:true,force:true})}
});
