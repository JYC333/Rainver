// Explicit Linux acceptance; build first. Requires working bwrap; never skips.
// ADR 0030 isolation proof: the strict namespace with egress `none` (the only
// profile the sensitive plugin-data release accepts) cannot open a socket to
// the Host, while `default` can. Only a listener this script opens on the
// Host's own addresses is contacted; no outside network is used.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { buildStrictNamespaceCommand } from '../dist/strictNamespace.js';

const root = await mkdtemp(join(tmpdir(), 'rainver-netns-'));
const server = createServer(socket => socket.end('reached'));
await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
const port = server.address().port;
const external = Object.values(networkInterfaces()).flat().find(a => a && a.family === 'IPv4' && !a.internal)?.address;
assert.ok(external, 'a non-loopback IPv4 address of this Host is needed to show the boundary');
try {
  const cwd = join(root, 'source'), home = join(root, 'profile');
  await Promise.all([mkdir(cwd), mkdir(home)]);
  async function attempt(egress, address) {
    const command = buildStrictNamespaceCommand({ command: process.execPath,
      args: ['--input-type=module', '-e', `
        import net from 'node:net';
        const socket = net.connect({host: ${JSON.stringify(address)}, port: ${port}, timeout: 3000});
        socket.on('data', data => { console.log('CONNECTED ' + data); socket.destroy(); });
        socket.on('timeout', () => { console.log('BLOCKED timeout'); socket.destroy(); });
        socket.on('error', error => console.log('BLOCKED ' + error.code));`],
      cwd, home, binds: [{ path: process.execPath, access: 'read_only' }],
      isolation: { sandbox_mode: 'read_write', egress_profile: egress }, env: {} });
    // Asynchronous, so this process keeps serving the listener while the namespace connects.
    const child = spawn(command.command, command.args, { env: command.env, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); setTimeout(() => child.kill('SIGKILL'), 20000).unref(); });
    assert.equal(code, 0, stderr);
    return stdout.trim();
  }
  // Positive control: the same namespace without `none` reaches the Host listener.
  assert.equal(await attempt('default', external), 'CONNECTED reached');
  // `none`: its own network namespace; neither the Host address nor its loopback is reachable.
  assert.match(await attempt('none', external), /^BLOCKED (ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|timeout)$/);
  assert.equal(await attempt('default', '127.0.0.1'), 'CONNECTED reached');
  assert.match(await attempt('none', '127.0.0.1'), /^BLOCKED (ECONNREFUSED|ENETUNREACH|timeout)$/);
  console.log(`network namespace acceptance passed (host ${external}:${port})`);
} finally {
  server.close();
  await rm(root, { recursive: true, force: true });
}
