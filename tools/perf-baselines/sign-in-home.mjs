// ⑤ PWA: signed-in cold start of /home and sign-in → Home, against a production
// web build with synthetic APIs (Chromium, Service Workers blocked). See README.md.
//   PWA_BUILD_DIR=/tmp/build SAMPLES=7 [THROTTLE=1] [PAUSE=1500] node sign-in-home.mjs
// THROTTLE: gzip transfer, 40 ms RTT, ~1.6 MB/s, 4× CPU (as project-load.mjs).
// PAUSE: milliseconds between filling the form (which focuses it) and submitting.
import { gzipSync } from 'node:zlib'; import { readFile } from 'node:fs/promises'; import { createServer } from 'node:http'; import { createRequire } from 'node:module'; import { extname, join, resolve } from 'node:path'
const { chromium } = createRequire(new URL('../../apps/web/package.json', import.meta.url))('playwright-core')
const dir = resolve(process.env.PWA_BUILD_DIR); const N = Number(process.env.SAMPLES ?? 5)
const space = { id: 'space-pwa', name: 'PWA Space', type: 'personal', role: 'owner' }
const user = { id: 'user-pwa', name: 'PWA tester', email: 'test@example.test', default_space_id: space.id, instance_role: 'member' }
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json' }
function serve(signedIn) { const s = createServer(async (req, res) => { const path = new URL(req.url, 'http://x').pathname
  if (path.startsWith('/api/')) { let data
    if (path === '/api/v1/auth/sign-in/email') { signedIn = true; data = { user } }
    else if (path === '/api/v1/auth/config') data = { password_enabled: true, google_enabled: false, registration_open: false, password_min_length: 8 }
    else if (path === '/api/v1/me') data = signedIn ? user : undefined
    else if (path === '/api/v1/me/spaces') data = signedIn ? [space] : undefined
    else if (path === '/api/v1/plugins/effective') data = { plugins: {} }
    res.writeHead(data !== undefined ? 200 : path === '/api/v1/me' ? 401 : 404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(data ?? { detail: 'fixture' })) }
  const name = extname(path) ? path.slice(1) : 'index.html'
  try { let body = await readFile(join(dir, name)); const gz = process.env.THROTTLE && /\.(js|css|html)$/.test(name); if (gz) body = gzipSync(body)
    res.writeHead(200, { ...(gz ? { 'Content-Encoding': 'gzip' } : {}), 'Content-Type': mime[extname(name)] ?? 'application/octet-stream' }); res.end(body) } catch { res.writeHead(404); res.end() } })
  return new Promise(r => s.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${s.address().port}`, close: () => new Promise(d => { s.closeAllConnections(); s.close(d) }) }))) }
const browser = await chromium.launch(); const out = { cold: [], signIn: [], heading: null }
const homeH1 = page => page.waitForFunction(() => { const h = document.querySelector('.page-dashboard h1'); return h ? h.textContent : false }, null, { polling: 'raf', timeout: Number(process.env.WAIT ?? 60000) }).then(h => h.jsonValue()).catch(async e => { console.error('BODY', (await page.evaluate(() => document.body.innerText)).slice(0, 600)); throw e })
try { for (let i = 0; i < N; i++) for (const mode of ['cold', 'signIn']) {
  const app = await serve(mode === 'cold'); const ctx = await browser.newContext({ serviceWorkers: 'block' }); const page = await ctx.newPage()
  if (process.env.THROTTLE) { const cdp = await ctx.newCDPSession(page); await cdp.send('Network.enable'); await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 40, downloadThroughput: 1.6 * 1024 * 1024, uploadThroughput: 750 * 1024 }); await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 }) }
  try { if (mode === 'cold') { const t0 = performance.now(); await page.goto(`${app.url}/home`, { waitUntil: 'commit' }); out.heading = await homeH1(page); out.cold.push(Math.round(performance.now() - t0)) }
    else { await page.goto(`${app.url}/login`); await page.fill('input[type=email]', 'test@example.test'); await page.fill('input[type=password]', 'password-123'); await new Promise(r => setTimeout(r, Number(process.env.PAUSE ?? 0))); const t0 = performance.now(); await page.click('form button[type=submit]'); out.heading = await homeH1(page); out.signIn.push(Math.round(performance.now() - t0)) }
  } finally { await ctx.close(); await app.close() } } } finally { await browser.close() }
const med = v => [...v].sort((a, b) => a - b)[Math.floor((v.length - 1) / 2)]
console.log(JSON.stringify({ build: dir, throttle: !!process.env.THROTTLE, samples: N, coldHomeMedian: med(out.cold), cold: out.cold, signInToHomeMedian: med(out.signIn), signIn: out.signIn, heading: out.heading }))
