/** Explicit stage-two acceptance in a private delegated test subtree. No instance
 * configuration, model invocation, or database migration command is involved. */
import {readFile,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
const group=(await readFile('/proc/self/cgroup','utf8')).trim().split('\n').find(x=>x.startsWith('0::'))?.slice(3);
if(!group?.endsWith('/manager'))throw new Error('Requires a private DelegateSubgroup=manager test unit');
const root=join('/sys/fs/cgroup',dirname(group));
await writeFile(join(root,'cgroup.subtree_control'),'+cpu +memory +pids');
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const child=spawn(process.execPath,[join(repo,'server/node_modules/vitest/vitest.mjs'),'run','test/sourceGoalsDb.test.ts'],{cwd:join(repo,'server'),stdio:'inherit',env:{...process.env,SOURCE_GOAL_OS_SMOKE:'1',SOURCE_EXECUTION_CGROUP_ROOT:root,DBUS_SESSION_BUS_ADDRESS:'unix:path=/source-test-unavailable-bus',XDG_RUNTIME_DIR:'/source-test-unavailable-runtime'}});
child.on('error',error=>{console.error(error.message);process.exitCode=1;});
child.on('exit',code=>process.exitCode=code??1);
