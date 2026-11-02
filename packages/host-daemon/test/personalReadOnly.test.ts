import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { saveConfig } from '../src/config.js';
import { handleLaunch, handleStdinClose, handleTerminate } from '../src/execution.js';
import { buildStrictNamespaceCommand } from '../src/strictNamespace.js';
import { assertReadOnlyBinds, workspacePathLeaseKeys, captureReadOnlyBasis, executableRoots } from '../src/readOnlyWorkspace.js';
import type { HostDaemonFrame } from '@rainver/protocol';
vi.mock('node:child_process',async original=>{const actual=await original<typeof import('node:child_process')>();return {...actual,spawn:(command:string,...args:unknown[])=>actual.spawn(command==='/usr/bin/bwrap'?(process.env.RAINVER_HOST_BWRAP??command):command,...args as Parameters<typeof actual.spawn> extends [unknown,...infer R]?R:never)};});
let root = '';
afterEach(async () => {
  delete process.env.RAINVER_HOST_CONFIG_DIR;
  if (root) await rm(root, {
    recursive: true,
    force: true
  });
});
it('rejects writable shadows, symlink and hard-link aliases before launch', async () => {
  root = await mkdtemp(join(tmpdir(), 'personal-readonly-'));
  const workspace = join(root, 'workspace'),
    profile = join(root, 'profile');
  await mkdir(workspace);
  await mkdir(profile);
  await writeFile(join(workspace, 'file'), 'basis');
  await symlink(workspace, join(root, 'alias'));
  expect(workspacePathLeaseKeys(workspace, [])).toEqual(workspacePathLeaseKeys(join(root, 'alias'), []));
  expect(() => assertReadOnlyBinds([workspace], [{
    path: root,
    access: 'read_write'
  }])).toThrow(/overlaps/);
  await symlink(join(workspace, 'not-yet-created'), join(profile, 'dangling'));
  expect(() => assertReadOnlyBinds([workspace], [{
    path: profile,
    access: 'read_write'
  }])).toThrow(/symlink/);
  await rm(join(profile, 'dangling'));
  await link(join(workspace, 'file'), join(profile, 'hardlink'));
  expect(() => assertReadOnlyBinds([workspace], [{
    path: profile,
    access: 'read_write'
  }])).toThrow(/hard links/);
});
// Explicit OS acceptance: no silent skip. Set RAINVER_HOST_BWRAP to a test-only extracted binary if needed.
it.runIf(process.env.PERSONAL_READONLY_OS === '1')('actual trusted Host launch overlaps two protected readers and makes alias writer await both exits', async () => {
  root = await mkdtemp(join(tmpdir(), 'personal-readonly-live-'));
  const repo = join(root, 'repo'),
    workspace = join(root, 'workspace');
  await mkdir(repo);
  const git = (args: string[]) => execFileSync('git', args, {
    cwd: repo,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid'
    },
    stdio: 'pipe'
  });
  git(['init']);
  await writeFile(join(repo, 'file'), 'basis');
  git(['add', 'file']);
  git(['commit', '-m', 'fixture']);
  git(['worktree', 'add', '-b', 'review', workspace]);
  expect(await captureReadOnlyBasis(workspace, join(repo, '.git'))).toBe(git(['rev-parse', 'HEAD^{tree}']).toString().trim());
  const originalObjects = git(['count-objects', '-v']).toString();
  const alias = join(root, 'alias');
  await symlink(workspace, alias);
  process.env.RAINVER_HOST_CONFIG_DIR = join(root, 'daemon');
  const server = createServer((_, res) => {
    res.setHeader('content-type', 'application/json');
    res.end('{}');
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const address = server.address() as {
    port: number;
  };
  await saveConfig({
    server_url: `http://127.0.0.1:${address.port}`,
    host_id: 'synthetic',
    token: 'synthetic',
    trust: 'trusted',
    workspaces: {
      primary: workspace,
      alias
    }
  });
  const messages: HostDaemonFrame[] = [];
  const waiters: Array<{
    test: (f: HostDaemonFrame) => boolean;
    resolve: (f: HostDaemonFrame) => void;
  }> = [];
  const send = (f: HostDaemonFrame) => {
    messages.push(f);
    for (const w of [...waiters]) if (w.test(f)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(f);
    }
  };
  const wait = async (test: (f: HostDaemonFrame) => boolean) => {
    const found = messages.find(test);
    if (found) return found;
    let timer: ReturnType<typeof setTimeout>;
    try {
      return await Promise.race([new Promise<HostDaemonFrame>(resolve => waiters.push({
        test,
        resolve
      })), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(JSON.stringify(messages))), 8000);
      })]);
    } finally {
      clearTimeout(timer!);
    }
  };
  const script = `set -eu
for op in 'echo bad > file' 'touch created' 'rm file' 'mv file moved'; do if sh -c "$op" 2>/dev/null; then echo BAD_WRITE;exit 4;fi;done
index=$(git rev-parse --git-path index)
if sh -c 'echo bad > "$1"' sh "$index" 2>/dev/null; then echo BAD_INDEX;exit 5;fi
if git config --local readonly.escape true 2>/dev/null; then echo BAD_GIT;exit 6;fi
if sh -c 'echo bad > "$1"' sh "${alias}/file" 2>/dev/null;then echo BAD_ALIAS;exit 7;fi
if sh -c 'echo bad > "$1"' sh "/proc/${process.pid}/root${workspace}/file" 2>/dev/null;then exit 8;fi
/usr/bin/python3 - <<'PY_IPC'
import errno, socket
s,t = socket.socketpair(); s.close(); t.close()
for make in [lambda: socket.socket(socket.AF_UNIX), lambda: socket.socketpair(socket.AF_UNIX, socket.SOCK_DGRAM), lambda: socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)]:
    try: make()
    except OSError as e: assert e.errno == errno.EPERM, e
    else: raise AssertionError("Unix client policy bypass")
s = socket.socket(socket.AF_INET); s.close()
print("IPC_POLICY_OK")
PY_IPC
echo report > "$RAINVER_OUTPUT_DIR/report.md"
echo cache > "$HOME/cache"
echo profilecache > "$CODEX_HOME/cache"
echo scratch > /tmp/scratch
printf 'READ_READY\\n'
read gate || true
`;
  try {
    const profileKey = 'agents/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/location/cccccccc-cccc-4ccc-8ccc-cccccccccccc/codex_cli/native';
    const binding = {
      profile_key: profileKey,
      env: {},
      profile_env: {
        CODEX_HOME: '.codex'
      },
      files: [{
        relative_path: '.codex/config.toml',
        contents: 'sandbox_mode = "danger-full-access"'
      }],
      credential_source: 'host_login' as const,
      login_link: null
    };
    const read = (id: string) => handleLaunch({
      run_id: id,
      launch_id: id,
      provider_binding: binding,
      workspace_location_id: 'primary',
      argv: ['/bin/sh', '-c', script],
      keep_stdin_open: true,
      isolation: {
        sandbox_mode: 'read_only',
        egress_profile: 'default'
      }
    }, send, () => {});
    await Promise.all([read('reader-one'), read('reader-two')]);
    for (const id of ['reader-one', 'reader-two']) {
      await wait(f => f.type === 'output' && f.run_id === id && f.chunk.includes('READ_READY'));
      expect(messages.some(f => f.type === 'complete' && f.run_id === id)).toBe(false);
    }
    for(const id of ['reader-one','reader-two'])expect(messages.filter(f=>f.type==='output'&&f.run_id===id).map(f=>f.type==='output'?f.chunk:'').join('')).toContain('IPC_POLICY_OK');
    expect(git(['count-objects', '-v']).toString()).toBe(originalObjects);
    const writer = handleLaunch({
      run_id: 'writer',
      launch_id: 'writer',
      workspace_location_id: 'alias',
      argv: ['/bin/sh', '-c', 'echo changed > file']
    }, send, () => {});
    await wait(f => f.type === 'waiting_for_workspace' && f.run_id === 'writer');
    handleStdinClose({
      run_id: 'reader-one'
    });
    await wait(f => f.type === 'complete' && f.run_id === 'reader-one');
    expect(await readFile(join(workspace, 'file'), 'utf8')).toBe('basis');
    handleStdinClose({
      run_id: 'reader-two'
    });
    await wait(f => f.type === 'complete' && f.run_id === 'reader-two');
    await writer;
    await wait(f => f.type === 'complete' && f.run_id === 'writer');
    expect(await readFile(join(workspace, 'file'), 'utf8')).toContain('changed');
    await handleLaunch({
      run_id: 'writer-hold',
      launch_id: 'writer-hold',
      workspace_location_id: 'primary',
      argv: ['/bin/sh', '-c', 'echo WRITER_READY;read gate || true'],
      keep_stdin_open: true,
      provider_binding: binding
    }, send, () => {});
    await wait(f => f.type === 'output' && f.run_id === 'writer-hold' && f.chunk.includes('WRITER_READY'));
    const late = read('reader-late');
    await wait(f => f.type === 'waiting_for_workspace' && f.run_id === 'reader-late');
    expect(messages.some(f => f.type === 'launched' && f.run_id === 'reader-late')).toBe(false);
    handleStdinClose({
      run_id: 'writer-hold'
    });
    await wait(f => f.type === 'complete' && f.run_id === 'writer-hold');
    await late;
    await wait(f => f.type === 'output' && f.run_id === 'reader-late' && f.chunk.includes('READ_READY'));
    handleStdinClose({
      run_id: 'reader-late'
    });
    await wait(f => f.type === 'complete' && f.run_id === 'reader-late');
    expect(messages.filter(f => f.type === 'complete').every(f => f.type === 'complete' && f.exit_code === 0)).toBe(true);
    // Synthetic credentials only: check declared binding layouts, not vendor auth.
    const previousHome=process.env.HOME;
    const loginHome=join(root,'synthetic-login');
    try {
      process.env.HOME=loginHome;
      const layouts=[
        {key:'codex_cli',state:'CODEX_HOME',sub:'.codex',file:'auth.json',shared:undefined},
        {key:'claude_code',state:'CLAUDE_CONFIG_DIR',sub:'.claude',file:'.credentials.json',shared:'CLAUDE_SECURESTORAGE_CONFIG_DIR'},
        {key:'acp_antigravity_acp',state:'GEMINI_HOME',sub:'.gemini',file:'antigravity-acp/acp_token.json',shared:undefined}
      ];
      for(const layout of layouts){
        await mkdir(join(loginHome,layout.sub,'antigravity-acp'),{recursive:true});
        await writeFile(join(loginHome,layout.sub,layout.file),'synthetic-login');
        await writeFile(join(loginHome,layout.sub,'private-unrelated'),'not-exposed');
        const credentialEnv=layout.shared??layout.state;
        const id='login-layout-'+layout.key;
        await handleLaunch({run_id:id,launch_id:id,workspace_location_id:'primary',
          // Neutral shell, never a logged-in vendor process.
          argv:['/bin/sh','-c',`set -eu; login="$${credentialEnv}/${layout.file}"; test "$(cat "$login")" = synthetic-login; if echo bad >> "$login" 2>/dev/null;then exit 9;fi; test ! -e "$${credentialEnv}/private-unrelated"; mkdir -p "$${layout.state}"; echo cache > "$${layout.state}/layout-cache"; echo LOGIN_LAYOUT_OK`],
          provider_binding:{...binding,profile_key:profileKey.replace('codex_cli',layout.key),profile_env:{[layout.state]:layout.sub},files:[],
            login_link:{home_subdir:layout.sub,credential_file:layout.file,...(layout.shared?{shared_credential_env:layout.shared}:{})}},
          isolation:{sandbox_mode:'read_only',egress_profile:'default'}
        },send,()=>{});
        const completed=await wait(f=>f.type==='complete'&&f.run_id===id);
        expect(completed,JSON.stringify(messages.filter(f=>'run_id' in f&&f.run_id===id))).toMatchObject({exit_code:0});
        expect(await readFile(join(loginHome,layout.sub,layout.file),'utf8')).toBe('synthetic-login');
      }
    } finally { if(previousHome===undefined)delete process.env.HOME;else process.env.HOME=previousHome; }
    await saveConfig({server_url:`http://127.0.0.1:${address.port}`,host_id:'synthetic',token:'synthetic',trust:'strict',workspaces:{plain:repo}});
  await handleLaunch({run_id:'strict-writer',launch_id:'strict-writer',workspace_location_id:'plain',argv:['/bin/sh','-c','echo strict > file; git -c user.name=Fixture -c user.email=fixture@example.invalid add file && git -c user.name=Fixture -c user.email=fixture@example.invalid commit -m strict'],isolation:{sandbox_mode:'read_write',egress_profile:'default'}},send,()=>{});
  expect(await wait(f=>f.type==='complete'&&f.run_id==='strict-writer')).toMatchObject({exit_code:0});
  await saveConfig({server_url:`http://127.0.0.1:${address.port}`,host_id:'synthetic',token:'synthetic',trust:'trusted',workspaces:{primary:workspace,alias}});
  const binary = process.env.RAINVER_HOST_BWRAP;
    process.env.RAINVER_HOST_BWRAP = '/nonexistent/rainver-test-bwrap';
    try {
      await read('capability-lost');
      const failed = await wait(f => f.type === 'complete' && f.run_id === 'capability-lost');
      expect(failed).toMatchObject({
        exit_code: expect.any(Number)
      });
      if (failed.type === 'complete') expect(failed.exit_code).not.toBe(0);
      expect(messages.some(f => f.type === 'launched' && f.run_id === 'capability-lost')).toBe(false);
    } finally {
      process.env.RAINVER_HOST_BWRAP = binary;
    }
  } finally {
    for (const id of ['reader-one', 'reader-two', 'writer', 'writer-hold', 'reader-late', 'capability-lost']) handleTerminate({
      run_id: id,
      force: true
    });
    handleStdinClose({
      run_id: 'reader-one'
    });
    handleStdinClose({
      run_id: 'reader-two'
    });
    await new Promise<void>(r => server.close(() => r()));
  }
}, 30000);

// All data and paths below are synthetic, including both possible login HOMEs.
it.runIf(process.env.PERSONAL_READONLY_OS === '1')('executes narrowed package/file/alias roots without exposing either login HOME', async () => {
  root=await mkdtemp(join(tmpdir(),'readonly-executable-roots-'));
  const owner=join(root,'owner'), other=join(root,'other-home'), work=join(root,'work'), privateHome=join(root,'run-home');
  for(const dir of [owner,other,work,privateHome])await mkdir(dir);
  for(const home of [owner,other]){await mkdir(join(home,'.ssh'));await writeFile(join(home,'.ssh/id_fake'),'NEIGHBOUR_SECRET');}
  const oldHome=process.env.HOME;
  try {
    process.env.HOME=owner;
    await writeFile(join(owner,'package.json'),'{}');
    await writeFile(join(root,'package.json'),'{}'); // An ancestor is not an installation root either.
    const paths=[join(owner,'.local/tool/bin/tool'),join(other,'node_modules/fixture/bin/tool'),join(owner,'tool')];
    for(const tool of paths){await mkdir(join(tool,'..'),{recursive:true});await writeFile(tool,`#!/bin/sh\necho RUN; cat ${owner}/.ssh/id_fake ${other}/.ssh/id_fake 2>/dev/null || true\n`,{mode:0o755});}
    await writeFile(join(other,'node_modules/fixture/package.json'),JSON.stringify({name:'fixture',dependencies:{'fixture-dep':'1'}}));
    const dep=join(other,'node_modules/fixture-dep');await mkdir(dep);await writeFile(join(dep,'package.json'),'{}');await writeFile(join(dep,'index.js'),'module.exports="DEPENDENCY_OK"');
    const nodeTool=join(other,'node_modules/fixture/bin/node-tool');
    await writeFile(nodeTool,`#!/usr/bin/env node\nconsole.log('RUN',require('fixture-dep'));\n`,{mode:0o755});
    await symlink(owner,join(root,'owner-alias'));
    await symlink(paths[0]!,join(owner,'linked-tool'));
    paths.push(join(root,'owner-alias/tool'),join(owner,'linked-tool'),nodeTool);
    for(const tool of paths){
      const env={PATH:process.env.PATH!,HOME:other};
      const roots=executableRoots(tool,env);
      for(const path of roots)for(const home of [owner,other])expect(home===path||home.startsWith(path+'/')).toBe(false);
      const plan=buildStrictNamespaceCommand({command:tool,args:[],cwd:work,home:privateHome,env:{PATH:process.env.PATH!},isolation:{sandbox_mode:'read_only',egress_profile:'none'},binds:roots.map(path=>({path,access:'read_only'}))});
      const output=execFileSync(process.env.RAINVER_HOST_BWRAP!,plan.args,{env:plan.env,encoding:'utf8',stdio:['ignore','pipe','pipe','pipe']});
      expect(output,tool).toContain('RUN');expect(output,tool).not.toContain('NEIGHBOUR_SECRET');
      if(tool===nodeTool)expect(output).toContain('DEPENDENCY_OK');
    }
  } finally {if(oldHome===undefined)delete process.env.HOME;else process.env.HOME=oldHome;}
});

it('narrows executable aliases and refuses dependency directories aliasing either login HOME',async()=>{
  root=await mkdtemp(join(tmpdir(),'readonly-roots-unit-'));
  const home=join(root,'home'),other=join(root,'other');
  await mkdir(home);await mkdir(other);await writeFile(join(home,'package.json'),'{}');
  const tool=join(home,'tool');await writeFile(tool,'#!/bin/sh\necho RUN');
  const previous=process.env.HOME;
  try {
    process.env.HOME=home;
    const roots=executableRoots(tool,{HOME:other});
    expect(roots).toContain(tool);expect(roots).not.toContain(home);expect(roots).not.toContain(root);
    const pkg=join(other,'node_modules/tool');await mkdir(join(pkg,'bin'),{recursive:true});
    await writeFile(join(pkg,'package.json'),JSON.stringify({dependencies:{'login-alias':'1'}}));
    await writeFile(join(pkg,'bin/tool'),'#!/bin/sh\necho RUN');
    await symlink(home,join(other,'node_modules/login-alias'));
    expect(()=>executableRoots(join(pkg,'bin/tool'),{HOME:other})).toThrow(/expose a login HOME/);
  }finally{if(previous===undefined)delete process.env.HOME;else process.env.HOME=previous;}
});

it.runIf(process.env.PERSONAL_READONLY_OS === '1')('refuses a whole-HOME CA directory before personal read spawn',async()=>{
  root=await mkdtemp(join(tmpdir(),'readonly-ca-home-'));
  const home=join(root,'home'),workspace=join(root,'workspace');await mkdir(home);await mkdir(workspace);
  const previousHome=process.env.HOME,previousCA=process.env.SSL_CERT_DIR;
  try {
    process.env.HOME=home;process.env.SSL_CERT_DIR=home;process.env.RAINVER_HOST_CONFIG_DIR=join(root,'daemon');
    await saveConfig({host_id:'synthetic',token:'synthetic',server_url:'http://127.0.0.1:1',trust:'trusted',workspaces:{fixture:workspace}});
    const frames:HostDaemonFrame[]=[];
    await handleLaunch({run_id:'whole-home-ca',launch_id:'whole-home-ca',workspace_location_id:'fixture',argv:['/bin/sh','-c','echo RUN'],isolation:{sandbox_mode:'read_only',egress_profile:'default'}},f=>frames.push(f),()=>{});
    expect(frames.find(f=>f.type==='complete')).toMatchObject({exit_code:1});
    expect(frames.some(f=>f.type==='launched')).toBe(false);
    expect(JSON.stringify(frames)).not.toContain(home);
  }finally{
    if(previousHome===undefined)delete process.env.HOME;else process.env.HOME=previousHome;
    if(previousCA===undefined)delete process.env.SSL_CERT_DIR;else process.env.SSL_CERT_DIR=previousCA;
  }
});
