// Explicit Linux acceptance; build first (protocol, agent-cli, host-daemon). Requires working bwrap; never skips.
// ADR 0030 §4a: an egress-`none` strict namespace keeps exactly one network path, its own model lease.
// Everything contacted is a listener this script opens on this Host: a synthetic provider proxy, a synthetic
// control-plane tool API and a decoy. No live provider, credential, database or outside network is used.
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { planStrictLaunch } from '../dist/execution.js';
import { startModelChannel } from '../dist/modelChannel.js';
import { startLocalToolBridge } from '@rainver/agent-cli/local-bridge';
import { RunToolChannel } from '../dist/runToolChannel.js';

const here = dirname(fileURLToPath(import.meta.url));
const agentCliDist = resolve(here, '../../agent-cli/dist');
const PORT = 18790;
const LEASE = randomUUID();
const OTHER_LEASE = randomUUID();
const LEASE_TOKEN = 'lease-token-' + randomUUID();
const UPSTREAM_KEY = 'UPSTREAM-SECRET-' + randomUUID(); // held only by the synthetic proxy
const RUN = randomUUID();
const TOOL_TOKEN = 't'.repeat(43);
const LAUNCH = randomUUID();

const root = await mkdtemp(join(tmpdir(), 'rv-mc-'));
const external = Object.values(networkInterfaces()).flat().find(a => a && a.family === 'IPv4' && !a.internal)?.address;
assert.ok(external, 'a non-loopback IPv4 address of this Host is needed to show the boundary');

// Synthetic provider proxy: serves only this lease, authenticated by its token; records every request.
const proxyLog = [];
let revoked = false;
const proxy = createHttpServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    proxyLog.push({ method: req.method, url: req.url, host: req.headers.host, proxyAuth: req.headers['proxy-authorization'] ?? null });
    const prefix = `/anthropic/${LEASE}/`;
    if (!req.url.startsWith(prefix) || req.headers['x-api-key'] !== LEASE_TOKEN || revoked) {
      res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"lease_invalid"}');
      return;
    }
    // Streamed, as a model response is: two chunks with a pause between them.
    const turn = JSON.parse(body || '{}');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: {"turn":${turn.turn},"part":1}\n\n`);
    setTimeout(() => res.end(`data: {"turn":${turn.turn},"part":2,"saw_tool_result":${JSON.stringify(turn.tool_result ?? null)}}\n\n`), 50);
  });
});
// The synthetic Host socket accepts the Run tool frame. Shell networking stays disabled.
const toolLog = [];
const tools = new RunToolChannel();
const sendTool = (frame) => {
  if (frame.type !== 'run_tool_request') return true;
  const auth = frame.token === TOOL_TOKEN && frame.run_id === RUN && frame.launch_id === LAUNCH;
  toolLog.push({ auth });
  const allowed = auth && frame.request.kind === 'call' && frame.request.action_id === 'demo_sensitive.read';
  queueMicrotask(() => tools.receive(sendTool, {
    type: 'run_tool_result', request_id: frame.request_id, run_id: frame.run_id, launch_id: frame.launch_id,
    status: allowed ? 200 : 404, text: allowed ? '{"data_class":"sensitive","rows":["SENSITIVE-ROW-1"]}' : '{}',
  }));
  return true;
};
tools.bind(sendTool);
// Decoy: anything reaching it is a breach.
let decoyHits = 0;
const decoy = createTcpServer(socket => { decoyHits += 1; socket.on('error', () => {}); socket.end('HTTP/1.1 200 OK\r\nContent-Length: 7\r\n\r\nreached'); });
const listen = (server, host) => new Promise(r => server.listen(0, host, () => r(server.address().port)));
const proxyPort = await listen(proxy, '0.0.0.0');
const decoyPort = await listen(decoy, '0.0.0.0');

const FIXTURE = String.raw`
import net from 'node:net';
import dns from 'node:dns/promises';
import { randomUUID } from 'node:crypto';
import { localToolRequest } from ${JSON.stringify(join(agentCliDist, 'localBridge.js'))};
const cfg = JSON.parse(process.argv[1]);
const out = {};
const model = async (body, base = process.env.ANTHROPIC_BASE_URL) => {
  try {
    const r = await fetch(base + '/v1/messages', { method: 'POST', headers: { 'x-api-key': process.env.ANTHROPIC_AUTH_TOKEN, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    return { status: r.status, text: await r.text() };
  } catch (e) { return { error: e.cause?.code ?? e.name }; }
};
const raw = (text) => new Promise(done => {
  const s = net.connect(cfg.port, '127.0.0.1'); let d = '';
  s.on('data', c => { d += c; }); s.on('close', () => done(d.split('\r\n')[0] || 'CLOSED'));
  s.on('error', e => done('ERR ' + e.code)); s.write(text); setTimeout(() => s.destroy(), 3000);
});
const tcp = (host, port) => new Promise(done => {
  const s = net.connect({ host, port, timeout: 3000 });
  s.on('connect', () => { done('CONNECTED'); s.destroy(); });
  s.on('timeout', () => { done('BLOCKED timeout'); s.destroy(); });
  s.on('error', e => done('BLOCKED ' + e.code));
});
const req = (line, extra = '') => line + ' HTTP/1.1\r\nHost: 127.0.0.1\r\n' + extra + 'Content-Length: 0\r\nConnection: close\r\n\r\n';
if (cfg.mode === 'full') {
  out.first = await model({ turn: 1 });
  const read = await localToolRequest(process.env.RAINVER_TOOL_BRIDGE, { id: randomUUID(), method: 'POST', path: 'tools/demo_sensitive.read', body: {} });
  out.read = read;
  out.second = await model({ turn: 2, tool_result: read.text });
  out.absolute = await raw(req('POST http://' + cfg.external + ':' + cfg.decoyPort + '/'));
  out.ownLeaseGet = await raw(req('GET /anthropic/' + cfg.lease + '/v1/files'));
  out.connect = await raw('CONNECT ' + cfg.external + ':' + cfg.decoyPort + ' HTTP/1.1\r\nHost: ' + cfg.external + '\r\n\r\n');
  out.otherLease = await raw(req('POST /anthropic/' + cfg.otherLease + '/v1/messages'));
  out.otherRoute = await raw(req('POST /openai/' + cfg.lease + '/v1/chat/completions'));
  out.dotSegment = await raw(req('POST /anthropic/' + cfg.lease + '/../' + cfg.otherLease + '/v1/messages'));
  out.encoded = await raw(req('POST /anthropic/' + cfg.lease + '/%2e%2e/' + cfg.otherLease));
  out.upgrade = await raw(req('GET /anthropic/' + cfg.lease + '/v1/ws', 'Upgrade: websocket\r\nConnection: Upgrade\r\n'));
  out.proxyAuthStripped = await raw(req('POST /anthropic/' + cfg.lease + '/v1/messages', 'Proxy-Authorization: Basic eDp5\r\nX-Api-Key: ' + process.env.ANTHROPIC_AUTH_TOKEN + '\r\n'));
  out.hostExternal = await tcp(cfg.external, cfg.decoyPort);
  out.hostLoopbackDecoy = await tcp('127.0.0.1', cfg.decoyPort);
  out.proxyDirectLoopback = await tcp('127.0.0.1', cfg.proxyPort);
  out.proxyDirectExternal = await tcp(cfg.external, cfg.proxyPort);
  out.replacedBase = await model({ turn: 3 }, 'http://' + cfg.external + ':' + cfg.proxyPort + '/anthropic/' + cfg.lease);
  out.dnsResolve = await dns.resolve4('example.com').then(() => 'RESOLVED', e => 'BLOCKED ' + e.code);
  out.dnsLookup = await dns.lookup('example.com').then(() => 'RESOLVED', e => 'BLOCKED ' + e.code);
  out.envHasUpstreamKey = JSON.stringify(process.env).includes(cfg.upstreamMarker);
} else if (cfg.mode === 'revoked') {
  out.afterRevoke = await model({ turn: 9 });
} else if (cfg.mode === 'closed') {
  out.before = await model({ turn: 1 });
  (await import('node:fs')).writeFileSync(cfg.signal + '.waiting', '');
  const fs = await import('node:fs');
  for (let i = 0; i < 400 && !fs.existsSync(cfg.signal + '.go'); i++) await new Promise(r => setTimeout(r, 25));
  out.after = await model({ turn: 2 });
} else if (cfg.mode === 'control') {
  out.hostExternal = await tcp(cfg.external, cfg.decoyPort);
  out.model = await model({ turn: 1 });
}
console.log(JSON.stringify(out));
`;

async function launch(mode, egress, channel, extra = {}) {
  const runDir = join(root, `run-${mode}-${egress}`), cwd = join(root, `ws-${mode}-${egress}`);
  await Promise.all([mkdir(runDir, { recursive: true }), mkdir(cwd, { recursive: true })]);
  const bridge = extra.bridge ? await startLocalToolBridge(runDir, (request, signal) => tools.invoke({ run_id: RUN, launch_id: LAUNCH, token: TOOL_TOKEN }, request, signal)) : null;
  const handle = channel ? await startModelChannel(runDir, channel) : null;
  const cfg = { mode, port: PORT, external, decoyPort, proxyPort, lease: LEASE, otherLease: OTHER_LEASE, upstreamMarker: 'UPSTREAM-SECRET-', signal: join(runDir, 'signal') };
  const plan = planStrictLaunch({
    runId: RUN, runDir, command: process.execPath, args: ['--input-type=module', '-e', FIXTURE, JSON.stringify(cfg)], cwd,
    derivedEnv: {
      // What a provider binding composed for the channel looks like: the loopback forwarder plus the lease token.
      ANTHROPIC_BASE_URL: channel ? `http://127.0.0.1:${PORT}/anthropic/${LEASE}` : `http://${external}:${proxyPort}/anthropic/${LEASE}`,
      ANTHROPIC_AUTH_TOKEN: LEASE_TOKEN,
      ...(bridge ? { RAINVER_TOOL_BRIDGE: bridge.endpoint } : {}),
    },
    ambient: { PATH: process.env.PATH, UPSTREAM_PROVIDER_KEY: UPSTREAM_KEY },
    isolation: { sandbox_mode: 'read_write', egress_profile: egress }, egress: {},
    profileDir: null, loginHome: null, toolTree: null, runtimeRoot: resolve(here, '../..'),
    readOnlyExecutables: [process.execPath],
    modelChannel: handle ?? undefined,
  });
  assert.ok(!plan.args.join('\n').includes(LEASE_TOKEN), 'the lease token is never on argv');
  assert.ok(!plan.args.join('\n').includes(UPSTREAM_KEY) && !JSON.stringify(plan.env).includes(UPSTREAM_KEY), 'no upstream key reaches the namespace');
  assert.equal(plan.args.includes('--unshare-net'), egress === 'none');
  await mkdir(plan.home, { recursive: true, mode: 0o700 }); // as launchRun does
  const child = spawn(plan.command, plan.args, { env: plan.env, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', c => { stdout += c; });
  child.stderr.on('data', c => { stderr += c; });
  if (mode === 'closed') {
    const waiting = cfg.signal + '.waiting';
    for (let i = 0; i < 400 && !existsSync(waiting); i++) await new Promise(r => setTimeout(r, 25));
    await handle.close(); // the Run ends / is cancelled: its channel closes
    await writeFile(cfg.signal + '.go', '');
  }
  const code = await new Promise((ok, fail) => { child.on('error', fail); child.on('exit', ok); setTimeout(() => child.kill('SIGKILL'), 60000).unref(); });
  const stats = handle?.stats() ?? null;
  await handle?.close(); await bridge?.close();
  assert.equal(code, 0, stderr);
  return { out: JSON.parse(stdout.trim().split('\n').pop()), stats };
}

try {
  // 1. Product path: model request, sensitive plugin read through the tool bridge, model continues.
  const channel = { version: 1, upstream_base_url: `http://127.0.0.1:${proxyPort}`, route: 'anthropic', lease_id: LEASE, loopback_port: PORT };
  const { out, stats } = await launch('full', 'none', channel, { bridge: true });
  assert.equal(out.first.status, 200); assert.match(out.first.text, /"turn":1,"part":2/);
  assert.equal(out.read.status, 200); assert.match(out.read.text, /SENSITIVE-ROW-1/);
  assert.equal(out.second.status, 200); assert.match(out.second.text, /"turn":2,"part":2,"saw_tool_result":".*SENSITIVE-ROW-1/);
  // 2. The channel cannot be pointed anywhere else.
  assert.match(out.absolute, /^HTTP\/1\.1 403/);
  assert.match(out.ownLeaseGet, /^HTTP\/1\.1 405/);
  assert.match(out.connect, /^HTTP\/1\.1 405/);
  assert.match(out.otherLease, /^HTTP\/1\.1 403/);
  assert.match(out.otherRoute, /^HTTP\/1\.1 403/);
  assert.match(out.dotSegment, /^HTTP\/1\.1 403/);
  assert.match(out.encoded, /^HTTP\/1\.1 403/);
  assert.match(out.upgrade, /^HTTP\/1\.1 403/);
  assert.match(out.proxyAuthStripped, /^HTTP\/1\.1 200/);
  // 3. Native sockets, loopback, DNS and a replaced destination all fail.
  assert.match(out.hostExternal, /^BLOCKED (ENETUNREACH|EHOSTUNREACH|timeout)$/);
  assert.match(out.hostLoopbackDecoy, /^BLOCKED ECONNREFUSED$/);
  assert.match(out.proxyDirectLoopback, /^BLOCKED ECONNREFUSED$/);
  assert.match(out.proxyDirectExternal, /^BLOCKED (ENETUNREACH|EHOSTUNREACH|timeout)$/);
  assert.ok(out.replacedBase.error, `replaced base URL must fail: ${JSON.stringify(out.replacedBase)}`);
  assert.match(out.dnsResolve, /^BLOCKED /); assert.match(out.dnsLookup, /^BLOCKED /);
  assert.equal(out.envHasUpstreamKey, false);
  // The synthetic proxy saw only this lease's three model calls, with its own Host and no proxy credential.
  assert.deepEqual(proxyLog.map(e => e.url), [`/anthropic/${LEASE}/v1/messages`, `/anthropic/${LEASE}/v1/messages`, `/anthropic/${LEASE}/v1/messages`]);
  assert.ok(proxyLog.every(e => e.host === `127.0.0.1:${proxyPort}` && e.proxyAuth === null));
  assert.equal(decoyHits, 0);
  assert.deepEqual(stats, { forwarded: 3, refused: 8 });
  assert.equal(toolLog.length, 1); assert.equal(toolLog[0].auth, true);
  // 4. Revocation: once the lease is revoked the only destination refuses.
  revoked = true;
  assert.equal((await launch('revoked', 'none', channel)).out.afterRevoke.status, 401);
  revoked = false;
  // 5. Closing the channel mid-Run (Run end, cancel) cuts it.
  const closed = (await launch('closed', 'none', channel)).out;
  assert.equal(closed.before.status, 200); assert.ok(closed.after.error, JSON.stringify(closed.after));
  // 6. Negative controls: without `none` the same namespace reaches the Host decoy (so the blocks above are real);
  //    with `none` but no channel, the model is unreachable (so the channel is what carries it).
  const control = (await launch('control', 'default', null)).out;
  assert.equal(control.hostExternal, 'CONNECTED');
  assert.equal(control.model.status, 200);
  const noChannel = (await launch('control', 'none', null)).out;
  assert.match(noChannel.hostExternal, /^BLOCKED /); assert.ok(noChannel.model.error);
  console.log(`model channel acceptance passed (bwrap, host ${external}; forwarded ${stats.forwarded}, refused ${stats.refused}; decoy hits ${decoyHits})`);
} finally {
  proxy.close(); decoy.close();
  await rm(root, { recursive: true, force: true });
}
