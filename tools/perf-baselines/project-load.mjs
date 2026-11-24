import { gzipSync } from 'node:zlib'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { extname, join, resolve } from 'node:path'

// ① Project page load against a production web build, with synthetic APIs only.
// See README.md in this directory for commands, environment and results.
const { chromium } = createRequire(new URL('../../apps/web/package.json', import.meta.url))('playwright-core')

const current = resolve(process.env.PWA_BUILD_DIR ?? 'dist')
const space = { id: 'space-pwa', name: 'PWA Space', type: 'personal', role: 'owner' }
const otherSpace = { ...space, id: 'space-other', name: 'Other Space' }
const project = { id: 'project-pwa', name: 'PWA project', title: 'PWA project', space_id: space.id, viewer_can_write: true }
const folder = { id: 'folder-pwa', name: 'Workspace' }
const user = { id: 'user-pwa', name: 'PWA tester', email: 'test@example.test', default_space_id: space.id, instance_role: 'member' }
const file = { path: 'README.md', content: 'Installed PWA editor fixture\n', size: 29, line_count: 2, sha256: 'a'.repeat(64), encoding: 'utf8', writable: true }
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' }
const now = '2026-11-10T09:00:00.000Z'
const mainline = { id: 'room-main', space_id: space.id, project_id: project.id, project_folder_id: null, created_by_user_id: user.id, title: 'Project conversation', status: 'active', created_at: now, updated_at: now, archived_at: null, is_mainline: true, roster_revision: 1 }
const conversation = { id: 'session-1', space_id: space.id, room_id: mainline.id, project_id: project.id, project_folder_id: null, title: 'Plan the sweep', status: 'active', created_at: now, updated_at: now }
const list = items => ({ items, total: items.length, limit: 50, offset: 0 })

function api(path, signedIn) {
  if (path === '/api/v1/me') return signedIn ? user : undefined
  if (path === '/api/v1/me/spaces') return signedIn ? [space, otherSpace] : undefined
  if (path === '/api/v1/plugins/effective') return { plugins: {} }
  if (path === '/api/v1/projects') return list([project])
  if (path === `/api/v1/projects/${project.id}`) return project
  if (path === `/api/v1/projects/${project.id}/mainline-room`) return { room: mainline, joined: false, viewer_can_write: true }
  if (path === `/api/v1/rooms/${mainline.id}/conversations`) return list([conversation])
  if (path.endsWith('/messages')) return { ...list([]), task_group_ids: [], queued: [] }
  if (path.endsWith('/overview')) return { project, brief: null, attention: [] }
  if (path.endsWith('/folders')) return list([folder])
  if (path.endsWith('/locations')) return [{ status: 'active', execution_ready: true, host_online: true }]
  if (path.endsWith('/tree')) return { name: 'Workspace', path: '.', type: 'dir', children: [{ name: file.path, path: file.path, type: 'file' }] }
  if (path.endsWith('/git/status')) return { is_repo: false, branch: null, files: [], truncated: false }
  if (path.endsWith('/file')) return file
  if (path.endsWith('/file/draft')) return null
  if (path.endsWith('/file/revisions')) return []
  return undefined
}

async function fixture(initialDir, signedIn = false) {
  let directory = initialDir
  const requests = []
  const activated = new Set()
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost')
    const path = url.pathname
    requests.push(path)
    if (path === '/__pwa-test-activated') {
      activated.add(url.searchParams.get('build'))
      response.writeHead(204)
      response.end()
      return
    }
    if (path.startsWith('/api/')) {
      const data = api(path, signedIn)
      const status = data !== undefined ? 200 : path === '/api/v1/me' ? 401 : 404
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      response.end(JSON.stringify(data === undefined ? { detail: 'Unavailable in fixture' } : data))
      return
    }
    const name = extname(path) ? path.slice(1) : 'index.html'
    try {
      const selectedBuild = directory
      let body = await readFile(join(selectedBuild, name))
      const gz = process.env.THROTTLE && /\.(js|css|html)$/.test(name)
      if (gz) body = gzipSync(body)
      response.writeHead(200, { ...(gz ? { 'Content-Encoding': 'gzip' } : {}), 'Content-Type': mime[extname(name)] ?? 'application/octet-stream',
        'Cache-Control': path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' })
      if (name === 'sw.js') {
        // Observe each generated worker's lifecycle even while there are no tabs.
        const report = `/__pwa-test-activated?build=${encodeURIComponent(selectedBuild)}`
        response.write(body)
        response.end(`\nself.addEventListener('activate', event => event.waitUntil(fetch(${JSON.stringify(report)})));\n`)
      } else response.end(body)
    } catch {
      response.writeHead(404)
      response.end()
    }
  })
  await new Promise((ready, reject) => server.listen(0, '127.0.0.1', ready).once('error', reject))
  return { url: `http://127.0.0.1:${server.address().port}`, requests, activated,
    signIn() { signedIn = true },
    update(newDir) { directory = newDir },
    async close() { await new Promise(ready => server.close(ready)) } }
}



const N = Number(process.env.SAMPLES ?? 7)
const chunks = process.env.CHUNKS ? JSON.parse(await readFile(process.env.CHUNKS, 'utf8')) : null
const browser = await chromium.launch()
const projectPath = `/spaces/${space.id}/projects/${project.id}`
const sizeCache = new Map()
async function sizes(path) {
  if (!sizeCache.has(path)) { const b = await readFile(join(current, path.slice(1))); sizeCache.set(path, { raw: b.length, gzip: gzipSync(b).length }) }
  return sizeCache.get(path)
}
const samples = []
let lastSets = null
try {
  for (let i = 0; i < N; i++) {
    const app = await fixture(current, true)
    const ctx = await browser.newContext({ serviceWorkers: 'block', ...(process.env.MOBILE ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : {}) })
    try {
      const page = await ctx.newPage()
      if (process.env.THROTTLE) {
        const cdp = await ctx.newCDPSession(page)
        await cdp.send('Network.enable')
        await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 40, downloadThroughput: 1.6 * 1024 * 1024, uploadThroughput: 750 * 1024 })
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
      }
      const t0 = performance.now()
      await page.goto(app.url + projectPath, { waitUntil: 'commit' })
      const headingPageMs = await page.waitForFunction(() => {
        const h = [...document.querySelectorAll('h1,h2,h3,h4,[role=heading]')].find(e => e.textContent.trim() === 'PWA project')
        return h ? performance.now() : false
      }, null, { polling: 'raf', timeout: 60000 }).then(h => h.jsonValue())
      const headingMs = Math.round(performance.now() - t0)
      if (!process.env.MOBILE) await page.locator('[data-testid="project-chat-sidecar"] [contenteditable="true"], [data-testid="project-chat-sidecar"] textarea').first().waitFor({ timeout: 60000 })
      const sidecarMs = Math.round(performance.now() - t0)
      // Stable: no new resource entries for 1500 ms.
      let count = -1, stableFor = 0
      while (stableFor < 1500) { const c = await page.evaluate(() => performance.getEntriesByType('resource').length); if (c === count) stableFor += 250; else { count = c; stableFor = 0 } await new Promise(r => setTimeout(r, 250)) }
      const entries = await page.evaluate(() => performance.getEntriesByType('resource').filter(r => /\.js($|\?)/.test(r.name)).map(r => ({ path: new URL(r.name).pathname, start: r.startTime, end: r.responseEnd })))
      const before = entries.filter(e => e.start <= headingPageMs), afterH = entries.filter(e => e.start > headingPageMs)
      const sum = async list => { let raw = 0, gzip = 0; for (const e of list) { const s = await sizes(e.path); raw += s.raw; gzip += s.gzip } return { n: list.length, raw, gzip } }
      samples.push({ headingMs, sidecarMs, headingPageMs: Math.round(headingPageMs), before: await sum(before), after: await sum(afterH), total: await sum(entries) })
      if (process.env.TIMELINE) { const tl = await page.evaluate(() => performance.getEntriesByType('resource').map(r => [Math.round(r.startTime), Math.round(r.responseEnd), new URL(r.name).pathname.replace('/assets/','')])); console.log('heading', Math.round(headingPageMs)); for (const r of tl) if (/api|ProjectAreaLayout|ProjectDetailPage|ProjectSidecar|ProjectsModule|app-|index-B|mermaid|Preflight/.test(r[2])) console.log(r.join(' ')) }
      lastSets = { before: before.map(e => e.path), after: afterH.map(e => e.path) }
    } finally { await ctx.close(); await app.close() }
  }
} finally { await browser.close() }
const med = k => { const v = samples.map(k).sort((a, b) => a - b); return v[Math.floor(v.length / 2)] }
console.log(JSON.stringify({ samples: N, headingMedianMs: med(s => s.headingMs), sidecarMedianMs: med(s => s.sidecarMs), allSidecar: samples.map(s => s.sidecarMs), headingMinMax: [Math.min(...samples.map(s => s.headingMs)), Math.max(...samples.map(s => s.headingMs))], before: samples.at(-1).before, after: samples.at(-1).after, total: samples.at(-1).total, beforeCounts: [...new Set(samples.map(s => s.before.n))], allHeading: samples.map(s => s.headingMs) }))
if (process.env.DETAIL) {
  const pkgOf = id => { const m = id.match(/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)/); if (m) return m[1]; const s = id.match(/\/(apps\/web\/src\/[^/]+\/[^/]+|packages\/[^/]+)/); return s ? s[1] : id.slice(-60) }
  for (const phase of ['before', 'after']) {
    const rows = []
    for (const p of lastSets[phase]) {
      const s = await sizes(p); const c = chunks?.[p.slice(1)]
      const pk = {}; if (c) for (const [id, len] of Object.entries(c.modules)) pk[pkgOf(id)] = (pk[pkgOf(id)] ?? 0) + len
      rows.push({ p, ...s, top: Object.entries(pk).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k}:${Math.round(v / 1024)}k`).join(' ') })
    }
    rows.sort((a, b) => b.gzip - a.gzip)
    console.log(`\n## ${phase} heading (${rows.length})`)
    for (const r of rows) console.log(`${String(Math.round(r.raw / 1024)).padStart(5)}k raw ${String(Math.round(r.gzip / 1024)).padStart(4)}k gz  ${r.p.replace('/assets/', '')}  ${r.top}`)
  }
}
