/** Read-only standard-image gate. Run only in a disposable unprivileged container;
 * no instance mounts, network, cgroup delegation or userns privilege is added. */
import assert from 'node:assert/strict';
import {mkdtemp,access} from 'node:fs/promises';
import {constants} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {sourceExecutionOffer} from '../../packages/host-daemon/dist/sourceCapability.js';
import {runSourceExecution} from '../../packages/host-daemon/dist/sourceExecution.js';
assert.equal(process.getuid(),1000);assert.match(process.version,/^v24\./);
await access('/usr/bin/bwrap',constants.X_OK);
assert.equal(process.env.RAINVER_SOURCE_CGROUP_ROOT,undefined);
assert.equal(await sourceExecutionOffer(),null);
let requests=0;
const code='export default async({request})=>{await request("https://must-not-send.test/");return {unexpected:true}}';
const root=await mkdtemp(join(tmpdir(),'source-container-refusal-'));
const result=await runSourceExecution({root,node:process.execPath,maxConcurrent:1,enabled:true},
 {execution_id:randomUUID(),version_sha256:createHash('sha256').update(code).digest('hex'),code,input_json:'{}',limits:{wall_ms:1000,memory_bytes:134217728,cpu_quota_percent:29,processes:32,requests:1,output_bytes:100}},
 async()=>{requests++;throw new Error('unauthorized send');},new AbortController().signal);
assert.equal(result.status,'refused');assert.equal(requests,0);
console.log(JSON.stringify({node:process.version,uid:process.getuid(),offer:null,status:result.status,error:result.error,requests,
 note:'Standard image without administrator cgroup/userns authorization; refusal only, not successful container execution.'},null,2));
