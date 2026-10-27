/** Run under a transient delegated test unit (COMMANDS). This helper only
 * enables controllers in that unit's private delegated subtree. */
import {readFile,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
const group=(await readFile('/proc/self/cgroup','utf8')).trim().split('\n').find(x=>x.startsWith('0::'))?.slice(3);
if(!group?.endsWith('/manager'))throw new Error('Requires DelegateSubgroup=manager');
const root=join('/sys/fs/cgroup',dirname(group));
await writeFile(join(root,'cgroup.subtree_control'),'+cpu +memory +pids');
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const child=spawn(process.execPath,[join(repo,'packages/host-daemon/node_modules/vitest/vitest.mjs'),'run',
 'test/sourceExecution.test.ts','test/sourceCollection.test.ts','test/sourceCollectionCloseout.test.ts','test/sourceFraming.test.ts','test/sourceExecutionChannel.test.ts','test/sourceRecoveryOs.test.ts'],
 {cwd:join(repo,'packages/host-daemon'),stdio:'inherit',env:{...process.env,DBUS_SESSION_BUS_ADDRESS:"unix:path=/source-test-unavailable-bus",XDG_RUNTIME_DIR:"/source-test-unavailable-runtime",SOURCE_EXECUTION_OS_SMOKE:'1',SOURCE_EXECUTION_CGROUP_ROOT:root}});
child.on('error',error=>{console.error(error.message);process.exitCode=1});
child.on('exit',code=>process.exitCode=code??1);
