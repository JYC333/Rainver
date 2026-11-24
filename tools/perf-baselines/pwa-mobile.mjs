import { execFileSync } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'

// ⑤ PWA on mobile viewports: cold start, first-install cache, offline shell,
// weak network, release switches against the retained-assets volume, an
// uncached feature and a tab holding unsaved input. Synthetic APIs only; the
// release store runs apps/web/docker/retain-previous-assets.sh and the asset
// fallback mirrors nginx.conf's try_files. See README.md in this directory.
//
//   PWA_BUILDS=/tmp/b1,/tmp/b2,/tmp/b3  three production builds, oldest first
//   BROWSERS=webkit,chromium  SAMPLES=5  OUT=/tmp/pwa.json
//   CASES=network-drop-uncached,update  a bounded split: only these release
//   cases (and `update` for the update cost); SAMPLES=0 skips cold/weak
const { chromium, webkit, devices } = createRequire(new URL('../../apps/web/package.json', import.meta.url))('playwright-core')

const builds = (process.env.PWA_BUILDS ?? '').split(',').filter(Boolean).map(dir => resolve(dir))
if (builds.length !== 3) throw new Error('PWA_BUILDS needs three build directories, oldest first')
const samples = Number(process.env.SAMPLES ?? 5)
const browsers = (process.env.BROWSERS ?? 'webkit,chromium').split(',')
const RELEASE_CASES = ['first-release', 'one-switch', 'two-switches', 'network-drop-uncached', 'server-down-uncached']
const cases = process.env.CASES ? process.env.CASES.split(',') : [...RELEASE_CASES, 'update']
for (const name of cases) if (![...RELEASE_CASES, 'update'].includes(name)) throw new Error(`unknown case ${name}`)
const profiles = { webkit: [webkit, 'iPhone 13'], chromium: [chromium, 'Pixel 7'] }
const retainScript = new URL('../../apps/web/docker/retain-previous-assets.sh', import.meta.url).pathname
// Weak network: 150 ms before each response, then one shared 200 KB/s link.
const WEAK = { latency: 150, bytesPerSecond: 200 * 1024 }

const space = { id: 'space-pwa', name: 'PWA Space', type: 'personal', role: 'owner' }
const project = { id: 'project-pwa', name: 'PWA project', title: 'PWA project', space_id: space.id, viewer_can_write: true }
const folder = { id: 'folder-pwa', name: 'Workspace' }
const user = { id: 'user-pwa', name: 'PWA tester', email: 'test@example.test', default_space_id: space.id, instance_role: 'member' }
const file = { path: 'README.md', content: 'Installed PWA editor fixture\n', size: 29, line_count: 2, sha256: 'a'.repeat(64), encoding: 'utf8', writable: true }
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' }
const list = items => ({ items, total: items.length, limit: 50, offset: 0 })
const projectPath = `/spaces/${space.id}/projects/${project.id}`
const editorPath = `${projectPath}/files?folder=${folder.id}&path=${file.path}`
const sleep = ms => new Promise(done => setTimeout(done, ms))
const median = values => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null }
const range = values => values.length ? [Math.min(...values), Math.max(...values)] : null

function api(path, signedIn) {
  if (path === '/api/v1/me') return signedIn ? user : undefined
  if (path === '/api/v1/me/spaces') return signedIn ? [space] : undefined
  if (path === '/api/v1/plugins/effective') return { plugins: {} }
  if (path === '/api/v1/projects') return list([project])
  if (path === `/api/v1/projects/${project.id}`) return project
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

// One origin. `release(dir, store)` switches the served build like a new
// frontend container: with a store it first runs the retention script, and a
// missing /assets/ file falls back to `<store>.link/previous`.
async function origin({ signedIn = false, weak = false } = {}) {
  let directory = null
  let store = null
  let linkFree = 0
  const log = []
  const activated = new Set()
  async function send(response, body) {
    if (!weak) return response.end(body)
    for (let offset = 0; offset < body.length; offset += 16384) {
      const piece = body.subarray(offset, offset + 16384)
      const now = Date.now()
      linkFree = Math.max(now, linkFree) + piece.length * 1000 / WEAK.bytesPerSecond
      await sleep(linkFree - now)
      response.write(piece)
    }
    response.end()
  }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost')
    const path = url.pathname
    // Unreachable: the connection drops without a response.
    if (state.down || (state.dropAssets && path.startsWith('/assets/'))) { log.push({ path, status: 0, bytes: 0, at: Date.now() }); return request.socket.destroy() }
    if (path === '/__pwa-activated') { activated.add(url.searchParams.get('build')); response.writeHead(204); return response.end() }
    // Sec-Fetch-Dest tells a document's own script/style request from the worker's precache fetch (`empty`).
    const entry = { path, status: 200, bytes: 0, at: Date.now(), dest: request.headers['sec-fetch-dest'] ?? null }
    log.push(entry)
    if (weak) await sleep(WEAK.latency)
    if (path.startsWith('/api/')) {
      const data = api(path, signedIn)
      entry.status = data !== undefined ? 200 : path === '/api/v1/me' ? 401 : 404
      response.writeHead(entry.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      return response.end(JSON.stringify(data === undefined ? { detail: 'Unavailable in fixture' } : data))
    }
    const name = extname(path) ? path.slice(1) : 'index.html'
    try {
      let body = await readFile(join(directory, name)).catch(error => {
        if (!store || !path.startsWith('/assets/')) throw error
        return readFile(join(`${store}.link`, 'previous', name))
      })
      // Report each generated worker's activation, even with no tab open.
      if (name === 'sw.js') body = Buffer.concat([body, Buffer.from(`\nself.addEventListener('activate', e => e.waitUntil(fetch(${JSON.stringify(`/__pwa-activated?build=${encodeURIComponent(directory)}`)})));\n`)])
      entry.bytes = body.length
      response.writeHead(200, { 'Content-Type': mime[extname(name)] ?? 'application/octet-stream',
        'Cache-Control': path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' })
      await send(response, body)
    } catch {
      entry.status = 404
      response.writeHead(404)
      response.end()
    }
  })
  await new Promise((ready, reject) => server.listen(0, '127.0.0.1', ready).once('error', reject))
  const state = {
    url: `http://127.0.0.1:${server.address().port}`, log, activated, down: false, dropAssets: false,
    get directory() { return directory },
    release(dir, withStore) {
      store = withStore ?? null
      if (store) execFileSync('sh', [retainScript], { env: { ...process.env, RAINVER_WEB_ROOT: dir, RAINVER_WEB_ASSET_STORE: store, RAINVER_WEB_PREVIOUS_LINK: `${store}.link/previous` }, stdio: 'ignore' })
      directory = dir
    },
    bytes(since = 0) { return log.filter(item => item.at >= since).reduce((sum, item) => sum + item.bytes, 0) },
    close: () => new Promise(done => { server.closeAllConnections?.(); server.close(done) }),
  }
  return state
}

async function context(kind) {
  const [type, device] = profiles[kind]
  const browser = await type.launch(kind === 'chromium' && process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {})
  const ctx = await browser.newContext({ ...devices[device], serviceWorkers: 'allow' })
  return { browser, ctx, close: () => browser.close() }
}

const visible = (page, selector, timeout = 30_000) => page.waitForFunction(s => {
  const node = document.querySelector(s)
  return node && node.getBoundingClientRect().height > 0 ? performance.now() : false
}, selector, { timeout, polling: 'raf' }).then(handle => handle.jsonValue())

const swReady = page => page.evaluate(async () => {
  await navigator.serviceWorker.ready
  return performance.now()
})

// Cold start, install, offline reopen and warm reopen in one fresh context.
async function coldSample(kind, weak) {
  const app = await origin({ weak })
  app.release(builds[2])
  const { ctx, close } = await context(kind)
  try {
    const page = await ctx.newPage()
    const started = Date.now()
    await page.goto(`${app.url}/login`, { waitUntil: 'commit' })
    const login = await visible(page, 'input[type=password]')
    const bytesAtLogin = app.bytes(started)
    const requestsAtLogin = app.log.length
    const installed = await swReady(page)
    // Precache requests can still be in flight when `ready` resolves: settle.
    let settled = app.log.length
    for (;;) { await sleep(weak ? 1500 : 400); if (app.log.length === settled) break; settled = app.log.length }
    const installBytes = app.bytes(started)
    const counts = {}
    for (const item of app.log) if (item.bytes) counts[item.path] = (counts[item.path] ?? 0) + 1
    const twice = Object.entries(counts).filter(([, n]) => n > 1).map(([path]) => path)
    const duplicateBytes = app.log.filter((item, i) => twice.includes(item.path) && app.log.findIndex(other => other.path === item.path) !== i).reduce((sum, item) => sum + item.bytes, 0)
    // Each path fetched more than once: bytes per fetch and who asked (by Sec-Fetch-Dest), largest first.
    const duplicates = twice.map(path => { const fetches = app.log.filter(item => item.path === path && item.bytes)
      return { path, bytes: fetches[0].bytes, fetches: fetches.map(item => item.dest) } }).sort((a, b) => b.bytes - a.bytes)
    const cached = await page.evaluate(async () => {
      let entries = 0
      for (const name of await caches.keys()) entries += (await (await caches.open(name)).keys()).length
      const estimate = await navigator.storage?.estimate?.().catch(() => null)
      return { entries, usage: estimate?.usage ?? null }
    })
    await ctx.setOffline(true)
    const offline = await ctx.newPage()
    const offlineStart = Date.now()
    const nav = await offline.goto(`${app.url}/login`, { waitUntil: 'commit' }).catch(error => ({ error }))
    const offlineLogin = await visible(offline, 'input[type=password]', 15_000).catch(() => null)
    const offlineFromSw = nav && !nav.error ? nav.fromServiceWorker() : false
    const offlineError = nav?.error ? nav.error.message.split('\n')[0] : null
    await offline.close()
    await ctx.setOffline(false)
    // The server unreachable instead of the browser's offline emulation.
    app.down = true
    const down = await ctx.newPage()
    const downNav = await down.goto(`${app.url}/login`, { waitUntil: 'commit' }).catch(error => ({ error }))
    const downLogin = await visible(down, 'input[type=password]', 15_000).catch(() => null)
    const downFromSw = downNav && !downNav.error ? downNav.fromServiceWorker() : false
    await down.close()
    app.down = false
    const warm = await ctx.newPage()
    const warmStart = Date.now()
    await warm.goto(`${app.url}/login`, { waitUntil: 'commit' })
    const warmLogin = await visible(warm, 'input[type=password]')
    return { login, requestsAtLogin, bytesAtLogin, installed, installBytes, duplicateRequests: twice.length, duplicateBytes, duplicates, downLogin, downFromSw, cachedEntries: cached.entries, storageUsage: cached.usage,
      offlineLogin, offlineFromSw, offlineError, offlineWall: Date.now() - offlineStart, warmLogin, warmBytes: app.bytes(warmStart), warmWall: Date.now() - warmStart }
  } finally { await close(); await app.close() }
}

// WebKit occasionally closes the whole browser mid-sample (seen once in a
// 5-sample run as "Target page, context or browser has been closed" from the
// Cache Storage read; not reproducible in isolation). A closed browser is not
// a measurement: rerun the sample in a new browser, at most twice, and report
// how often it happened instead of aborting the run.
async function sampleWithRetry(run, crashes) {
  for (let attempt = 0; ; attempt++) {
    try { return await run() } catch (error) {
      if (attempt >= 2 || !/has been closed|crash/i.test(error.message)) throw error
      crashes.push(error.message.split('\n')[0])
    }
  }
}

async function loadControlled(page, url) {
  await page.goto(url)
  await swReady(page)
  await page.reload()
  if (!await page.evaluate(() => Boolean(navigator.serviceWorker.controller))) throw new Error(`no service-worker control at ${url}`)
}

const chunkOf = async (dir, prefix) => `/assets/${(await readdir(join(dir, 'assets'))).find(name => name.startsWith(prefix) && name.endsWith('.js'))}`

const editorOpens = (page, timeout) => page.locator('.cm-content').getByText(file.content.trim()).waitFor({ timeout }).then(() => true, () => false)
// WebKit keeps a failed module import across a reload of the same tab, while
// fetch() of that URL succeeds; a new tab (new document process) does not.
async function newTabOpens(ctx, app) {
  const tab = await ctx.newPage()
  try { await tab.goto(`${app.url}${editorPath}`); return await editorOpens(tab, 15_000) } finally { await tab.close() }
}

// A tab opened on builds[0] stays open while releases happen, then opens the
// not-yet-fetched editor through client-side navigation. When that fails, the
// person takes the action the page offers: first staying at the unsaved-input
// prompt (input kept, nothing activated, action still offered), then leaving
// (the tab must reach the served build and open the editor). Every case ends
// in `status: passed | limited | failed` with the failed checks, engine
// limits or the error; the run ends with one terminal line and exit code.
const NOT_FOUND = 'Project not found'
async function releaseCase(kind, name) {
  const store = await mkdtemp(join(tmpdir(), 'rainver-pwa-store-'))
  const app = await origin({ signedIn: true })
  const { ctx, close } = await context(kind)
  const dialogs = []
  const consoleErrors = []
  let leave = false
  const result = { opened: null, routeRequests: [], panel: null, draftKept: null, recovery: null }
  const failures = []
  const limits = []
  const check = (ok, label) => { if (!ok) failures.push(label) }
  try {
    // first-release: the tab's build ran before the volume existed.
    app.release(builds[0], name === 'first-release' ? null : store)
    const page = await ctx.newPage()
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 200)) })
    page.on('dialog', dialog => { dialogs.push(dialog.type()); void (leave ? dialog.accept() : dialog.dismiss()) })
    page.setDefaultTimeout(15_000)
    await loadControlled(page, `${app.url}${projectPath}`)
    await page.getByRole('heading', { name: project.name, exact: true }).waitFor()
    const notFound = page.getByText(NOT_FOUND, { exact: true })
    // A fixture gap renders this page instead of the Project: never a pass.
    if (await notFound.count()) throw new Error(`fixture: ${NOT_FOUND} before the release`)
    // Something unsaved that only lives in this tab, guarded the way the
    // editor and Reader comment drafts guard theirs.
    const token = await page.evaluate(() => {
      window.__pwaDocument = Math.random()
      window.__pwaDraft = 'unsaved'
      addEventListener('beforeunload', event => { if (window.__pwaDraft) { event.preventDefault(); event.returnValue = '' } })
      return window.__pwaDocument
    })
    const sameDocument = () => page.evaluate(t => window.__pwaDocument === t && window.__pwaDraft === 'unsaved', token).catch(() => false)
    const releases = { 'first-release': [1], 'one-switch': [1], 'two-switches': [1, 2], 'network-drop-uncached': [], 'server-down-uncached': [] }[name]
    for (const index of releases) app.release(builds[index], store)
    if (releases.length) {
      await page.evaluate(async () => { await (await navigator.serviceWorker.ready).update() })
      await page.waitForFunction(async () => (await navigator.serviceWorker.getRegistration())?.waiting?.state === 'installed', null, { timeout: 30_000 })
    }
    const served = app.directory
    if (name === 'server-down-uncached') app.down = true
    if (name === 'network-drop-uncached') app.dropAssets = true
    // The route chunk the Files page needs first, from the tab's own build.
    const oldRoute = await chunkOf(builds[0], 'ProjectFilesPage-')
    const at = Date.now()
    await page.evaluate(path => { history.pushState(null, '', path); dispatchEvent(new PopStateEvent('popstate')) }, editorPath)
    result.opened = await page.locator('.cm-content').getByText(file.content.trim()).waitFor({ timeout: 8_000 }).then(() => Date.now() - at, () => null)
    result.routeRequests = app.log.filter(item => item.path === oldRoute && item.at >= at).map(item => item.status)
    // With the server unreachable the Project page itself reports this; that
    // is the product's message for a failed load, not a fixture gap, and it
    // is recorded as a failed check. Otherwise the fixture is broken.
    if (await notFound.count()) {
      if (name !== 'server-down-uncached') throw new Error(`fixture: ${NOT_FOUND} after navigation`)
      result.notFoundWhileServerDown = true
      check(false, `an unreachable server is shown as "${NOT_FOUND}"`)
    }
    if (result.opened === null) {
      await page.getByRole('status').filter({ hasText: /updated after this tab opened|cannot be reached|download was interrupted/ }).first().waitFor({ timeout: 10_000 }).catch(() => {})
      result.panel = await page.evaluate(() => {
        const main = document.querySelector('main') ?? document.body
        return { text: main.innerText.replace(/\s+/g, ' ').trim().slice(0, 400), buttons: [...main.querySelectorAll('button')].map(b => b.innerText.trim()).filter(Boolean).slice(-6) }
      })
    }
    // Never reload a tab on its own: the draft marker must survive.
    await sleep(3000)
    result.draftKept = await sameDocument()
    check(result.draftKept, 'the tab kept its document and input on its own')
    if (result.opened === null) {
      app.down = false
      app.dropAssets = false
      const recovery = result.recovery = {}
      const again = page.getByRole('button', { name: 'Check again' })
      if (await again.isVisible().catch(() => false)) { recovery.checkedAgain = true; await again.click(); await sleep(1500) }
      const action = page.getByRole('button', { name: /^(Update and reload|Reload this tab)$/ })
      recovery.action = await action.innerText({ timeout: 5000 }).catch(() => null)
      if (!recovery.action && result.notFoundWhileServerDown) {
        // No panel to act on: the person reloads the tab once the server is back.
        leave = true
        await page.reload().catch(() => {})
        recovery.manualReload = true
        recovery.reopened = await editorOpens(page, 15_000)
        if (!recovery.reopened) recovery.newTabOpens = await newTabOpens(ctx, app)
        // The same WebKit engine limit as below, never a pass.
        if (!recovery.reopened && kind === 'webkit' && recovery.newTabOpens) limits.push('WebKit: the same-tab reload keeps the failed import; a new tab opens the editor')
        else check(recovery.reopened, 'the editor opened after a manual reload')
      } else check(recovery.action, 'the panel offers an update or reload')
      if (recovery.action) {
        const before = dialogs.length
        const wasActive = app.activated.has(served)
        await action.click({ noWaitAfter: true })
        await sleep(3500)
        recovery.promptedForDraft = dialogs.length > before
        recovery.keptAfterDismiss = await sameDocument()
        recovery.activatedWhileKept = !wasActive && app.activated.has(served)
        recovery.retryable = await action.isEnabled().catch(() => false)
        check(recovery.promptedForDraft, 'the browser asked before discarding input')
        check(recovery.keptAfterDismiss, 'staying kept the input')
        check(!recovery.activatedWhileKept, 'staying activated nothing')
        check(recovery.retryable, 'the action stays available after staying')
        leave = true
        const leftAt = Date.now()
        await action.click({ noWaitAfter: true })
        const expected = JSON.parse(await readFile(join(served, 'version.json'), 'utf8')).id
        recovery.reachedServedBuild = await page.waitForFunction(id => document.querySelector('meta[name="rainver-build-id"]')?.content === id, expected, { timeout: 20_000 }).then(() => true, () => false)
        recovery.reopened = await editorOpens(page, 15_000)
        recovery.notFound = await notFound.count().catch(() => 0) > 0
        if (!recovery.reopened) {
          // Whether the reloaded document asked for the route chunk at all,
          // and what it shows instead: tells an engine-kept failure from a
          // fixture or product gap.
          recovery.routeRequestsAfterLeave = app.log.filter(item => item.path === oldRoute && item.at >= leftAt).map(item => item.status)
          recovery.panelAfterLeave = await page.evaluate(() => (document.querySelector('main') ?? document.body).innerText.replace(/\s+/g, ' ').trim().slice(0, 300)).catch(() => null)
        }
        check(recovery.reachedServedBuild, 'leaving reached the served build')
        check(!recovery.notFound, `no ${NOT_FOUND} after recovery`)
        if (!recovery.reopened) {
          recovery.newTabOpens = await newTabOpens(ctx, app)
          // WebKit keeps a failed module import across a reload of the same
          // tab when its URL is unchanged (same build); only a new tab loads
          // it. Reported as an engine limit, never as a pass.
          if (kind === 'webkit' && recovery.newTabOpens && recovery.action === 'Reload this tab') limits.push('WebKit: the same-tab reload keeps the failed import; a new tab opens the editor')
          else check(false, 'the editor opened after leaving')
        }
      }
    }
    const status = failures.length ? 'failed' : limits.length ? 'limited' : 'passed'
    return { status, failures, limits, ...result, dialogs, consoleErrors: consoleErrors.slice(-8) }
  } catch (error) {
    return { status: 'failed', error: error.message.split('\n')[0], failures, limits, ...result, dialogs, consoleErrors: consoleErrors.slice(-8) }
  } finally {
    await close(); await app.close()
    await Promise.all([store, `${store}.link`].map(dir => rm(dir, { recursive: true, force: true })))
  }
}

// What an update downloads and keeps: builds[1] → builds[2] after installing builds[1].
async function updateCost(kind) {
  const app = await origin({ signedIn: false })
  const { ctx, close } = await context(kind)
  try {
    app.release(builds[1])
    const page = await ctx.newPage()
    await loadControlled(page, `${app.url}/login`)
    app.release(builds[2])
    const at = Date.now()
    await page.evaluate(async () => { await (await navigator.serviceWorker.ready).update() })
    await page.waitForFunction(async () => (await navigator.serviceWorker.getRegistration())?.waiting?.state === 'installed', null, { timeout: 30_000 })
    await sleep(500)
    const fetched = app.log.filter(item => item.at >= at && item.path.startsWith('/assets/'))
    return { assetRequests: fetched.length, bytes: fetched.reduce((sum, item) => sum + item.bytes, 0) }
  } finally { await close(); await app.close() }
}

async function assetStability() {
  const names = await Promise.all(builds.map(async dir => new Set(await readdir(join(dir, 'assets')))))
  const changed = (a, b) => [...b].filter(name => !a.has(name)).length
  const route = await Promise.all(builds.map(dir => chunkOf(dir, 'ProjectFilesPage-')))
  return { total: names.map(set => set.size), renamed_1_to_2: changed(names[0], names[1]), renamed_2_to_3: changed(names[1], names[2]), filesRouteChunkChanges: new Set(route).size > 1 }
}

const result = { builds, samples, weak: WEAK, at: new Date().toISOString(), assets: await assetStability(), browsers: {} }
// Samples that fail (after the closed-browser retries) are recorded, not thrown:
// the run always ends with a terminal summary line and a matching exit code.
const attempt = async run => { try { return await run() } catch (error) { return { failed: error.message.split('\n')[0] } } }
for (const kind of browsers) {
  const entry = result.browsers[kind] = { device: profiles[kind]?.[1] ?? null, version: null, cold: [], weak: [], releases: {}, browserClosures: [], failures: [] }
  try {
    const [type] = profiles[kind]
    const probe = await type.launch(); entry.version = probe.version(); await probe.close()
  } catch (error) { entry.failures.push(`launch: ${error.message.split('\n')[0]}`); continue }
  for (let i = 0; i < samples; i++) entry.cold.push(await attempt(() => sampleWithRetry(() => coldSample(kind, false), entry.browserClosures)))
  for (let i = 0; i < (samples ? Math.max(1, Math.ceil(samples / 2)) : 0); i++) entry.weak.push(await attempt(() => sampleWithRetry(() => coldSample(kind, true), entry.browserClosures)))
  for (const name of RELEASE_CASES) if (cases.includes(name)) entry.releases[name] = await releaseCase(kind, name)
  entry.update = cases.includes('update') ? await attempt(() => updateCost(kind)) : null
  const ok = rows => rows.filter(r => !r.failed)
  const summary = rows => Object.fromEntries(['login', 'installed', 'bytesAtLogin', 'installBytes', 'duplicateBytes', 'downLogin', 'cachedEntries', 'storageUsage', 'offlineLogin', 'warmLogin', 'warmBytes']
    .map(key => [key, { median: median(ok(rows).map(r => r[key]).filter(v => typeof v === 'number')), range: range(ok(rows).map(r => r[key]).filter(v => typeof v === 'number')) }]))
  entry.summary = { cold: summary(entry.cold), weak: summary(entry.weak), coldFailed: entry.cold.length - ok(entry.cold).length, weakFailed: entry.weak.length - ok(entry.weak).length,
    offlineFromSw: ok(entry.cold).every(r => r.offlineFromSw), offlineErrors: [...new Set(ok(entry.cold).map(r => r.offlineError).filter(Boolean))], downFromSw: ok(entry.cold).every(r => r.downFromSw) }
  for (const row of [...entry.cold, ...entry.weak, entry.update]) if (row?.failed) entry.failures.push(`sample: ${row.failed}`)
  entry.limits = []
  for (const [name, row] of Object.entries(entry.releases)) {
    if (row.status === 'failed') entry.failures.push(`${name}: ${row.error ?? row.failures.join('; ')}`)
    for (const text of row.limits) entry.limits.push(`${name}: ${text}`)
  }
  console.log(JSON.stringify({ [kind]: { version: entry.version, browserClosures: entry.browserClosures, summary: entry.summary, releases: entry.releases, update: entry.update } }, null, 1))
}
console.log(JSON.stringify({ assets: result.assets }))
const failed = Object.entries(result.browsers).flatMap(([kind, entry]) => entry.failures.map(text => `${kind} ${text}`))
const limited = Object.entries(result.browsers).flatMap(([kind, entry]) => (entry.limits ?? []).map(text => `${kind} ${text}`))
result.terminal = { state: failed.length ? 'failed' : limited.length ? 'limited' : 'passed', failed, limited }
if (process.env.OUT) await writeFile(process.env.OUT, JSON.stringify(result, null, 2))
console.log(JSON.stringify({ terminal: result.terminal }))
process.exitCode = failed.length ? 1 : 0
