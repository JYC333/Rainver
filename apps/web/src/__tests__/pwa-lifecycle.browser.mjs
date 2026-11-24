import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'
import { chromium, webkit } from 'playwright-core'

const current = resolve(process.env.PWA_BUILD_DIR ?? 'dist')
const previous = process.env.PWA_PREVIOUS_BUILD_DIR ? resolve(process.env.PWA_PREVIOUS_BUILD_DIR) : null
const space = { id: 'space-pwa', name: 'PWA Space', type: 'personal', role: 'owner' }
const project = { id: 'project-pwa', name: 'PWA project', title: 'PWA project', space_id: space.id, viewer_can_write: true }
const folder = { id: 'folder-pwa', name: 'Workspace' }
const user = { id: 'user-pwa', name: 'PWA tester', email: 'test@example.test', default_space_id: space.id, instance_role: 'member' }
const file = { path: 'README.md', content: 'Installed PWA editor fixture\n', size: 29, line_count: 2, sha256: 'a'.repeat(64), encoding: 'utf8', writable: true }
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' }
const list = items => ({ items, total: items.length, limit: 50, offset: 0 })
const retainScript = resolve(dirname(fileURLToPath(import.meta.url)), '../../docker/retain-previous-assets.sh')

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

// `store` stands in for the frontend volume and `<store>.link` for the
// container's own fallback pointer: each start runs the production image's
// retention script, and a missing /assets/ file falls back to the previous
// build exactly as nginx.conf's try_files does.
async function fixture(initialDir, signedIn = false, store = null) {
  let directory = initialDir
  const start = dir => { if (store) execFileSync('sh', [retainScript], { env: { ...process.env, RAINVER_WEB_ROOT: dir, RAINVER_WEB_ASSET_STORE: store, RAINVER_WEB_PREVIOUS_LINK: `${store}.link/previous` }, stdio: 'ignore' }) }
  start(directory)
  const requests = []
  const responses = []
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
      responses.push({ path, status })
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      response.end(JSON.stringify(data === undefined ? { detail: 'Unavailable in fixture' } : data))
      return
    }
    const name = extname(path) ? path.slice(1) : 'index.html'
    try {
      const selectedBuild = directory
      const body = await readFile(join(selectedBuild, name)).catch(error => {
        if (!store || !path.startsWith('/assets/')) throw error
        return readFile(join(`${store}.link`, 'previous', name))
      })
      responses.push({ path, status: 200 })
      response.writeHead(200, { 'Content-Type': mime[extname(name)] ?? 'application/octet-stream',
        'Cache-Control': path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' })
      if (name === 'sw.js') {
        // Observe each generated worker's lifecycle even while there are no tabs.
        const report = `/__pwa-test-activated?build=${encodeURIComponent(selectedBuild)}`
        response.write(body)
        response.end(`\nself.addEventListener('activate', event => event.waitUntil(fetch(${JSON.stringify(report)})));\n`)
      } else response.end(body)
    } catch {
      responses.push({ path, status: 404 })
      response.writeHead(404)
      response.end()
    }
  })
  await new Promise((ready, reject) => server.listen(0, '127.0.0.1', ready).once('error', reject))
  return { url: `http://127.0.0.1:${server.address().port}`, requests, responses, activated,
    signIn() { signedIn = true },
    update(newDir) { start(newDir); directory = newDir },
    async close() { await new Promise(ready => server.close(ready)) } }
}

let browser
before(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE }) })
after(async () => { await browser?.close() })

async function loadControlled(page, url) {
  page.setDefaultTimeout(10_000)
  await page.goto(url)
  await page.evaluate(async () => {
    let timer
    try {
      await Promise.race([navigator.serviceWorker.ready, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Service worker did not activate')), 10_000)
      })])
    } finally { clearTimeout(timer) }
  })
  await page.reload()
  assert.ok(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)), `Expected service-worker control for ${page.url()}`)
}

async function cacheContents(page, nameIncludes) {
  return page.evaluate(async name => {
    const names = (await caches.keys()).filter(key => key.includes(name))
    const keys = await Promise.all(names.map(async key => (await caches.open(key)).keys()))
    return keys.flat().map(request => new URL(request.url).pathname)
  }, nameIncludes)
}

test('a clean install caches the offline shell and optional features warm on first use', async () => {
  // The signed-in app (Shell, routes, their strings) is not part of the
  // sign-in shell: it loads, and is cached, on first sign-in.
  const app = await fixture(current)
  const context = await browser.newContext()
  const page = await context.newPage()
  const assetNames = await readdir(join(current, 'assets'))
  const optional = ['mermaid-', 'CodeMirrorEditor-', 'xterm-', 'AuthenticatedApp-'].map(prefix => {
    const name = assetNames.find(asset => asset.startsWith(prefix) && asset.endsWith('.js'))
    assert.ok(name, `${prefix} chunk missing from the fixture build`)
    return `/assets/${name}`
  })
  try {
    await loadControlled(page, `${app.url}/login`)
    const precache = await cacheContents(page, 'precache')
    assert.ok(precache.includes('/index.html'))
    assert.ok(precache.includes('/theme.js'))
    assert.ok(precache.some(path => path.endsWith('.css')))
    assert.ok(precache.some(path => /\/inter-latin-wght-normal-.*\.woff2$/.test(path)))
    const optionalFont = assetNames.find(name => /^inter-cyrillic-wght-normal-.*\.woff2$/.test(name))
    assert.ok(optionalFont)
    const optionalFontPath = `/assets/${optionalFont}`
    assert.ok(!precache.includes(optionalFontPath))
    for (const path of optional) assert.ok(!precache.includes(path) && !app.requests.includes(path), `${path} loaded at install`)
    // The build id lives in the HTML only: inlined into a chunk, it renamed
    // most hashed assets on every release, even with no source change.
    const { id } = JSON.parse(await readFile(join(current, 'version.json'), 'utf8'))
    for (const name of assetNames.filter(asset => asset.endsWith('.js'))) {
      assert.ok(!(await readFile(join(current, 'assets', name), 'utf8')).includes(id), `${name} embeds the build id`)
    }

    await context.setOffline(true)
    const offline = await context.newPage()
    const navigation = await offline.goto(`${app.url}/login`)
    assert.ok(navigation.fromServiceWorker())
    await offline.locator('input[type=password]').waitFor({ timeout: 10_000 })
    await offline.close()
    await context.setOffline(false)
    assert.equal(await page.evaluate(async path => (await fetch(path)).status, optionalFontPath), 200)
    await page.waitForFunction(async path => Boolean(await (await caches.open('hashed-static-v1')).match(path)), optionalFontPath)
    app.signIn()
    await page.goto(`${app.url}/spaces/${space.id}/projects/${project.id}/files?folder=${folder.id}&path=${file.path}`)
    await page.locator('.cm-content').getByText(file.content.trim()).waitFor()
    await page.evaluate(paths => Promise.all(paths.map(path => import(path))).then(() => true), [optional[0], optional[2]])
    await page.waitForFunction(async paths => {
      const cached = await caches.open('hashed-static-v1')
      return (await Promise.all(paths.map(path => cached.match(path)))).every(Boolean)
    }, optional)
    for (const path of optional) assert.ok(app.requests.includes(path), `${path} never fetched from the active build`)
    assert.deepEqual(await cacheContents(page, 'api-cache'), [])
  } finally {
    await context.close()
    await app.close()
  }
})

test('a background update leaves open tabs intact and activates after they close', { skip: !previous }, async () => {
  const app = await fixture(previous)
  const context = await browser.newContext()
  try {
    const source = dir => readFile(join(dir, 'index.html'), 'utf8').then(html => /<script type="module" [^>]*src="([^"]+)"/.exec(html)[1])
    const expected = await source(current)
    const old = await source(previous)
    assert.notEqual(old, expected, 'use two distinct builds')
    const urls = `${app.url}/login`
    const first = await context.newPage()
    const second = await context.newPage()
    await loadControlled(first, urls)
    await second.goto(urls)
    await second.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, { timeout: 10_000 })
    const password = page => page.locator('input[type=password]')
    await password(first).fill('unsaved input')
    await password(second).fill('another draft')
    app.update(current)
    await first.evaluate(async () => { await (await navigator.serviceWorker.ready).update() })
    await first.waitForFunction(async () => (await navigator.serviceWorker.getRegistration())?.waiting?.state === 'installed')
    await second.waitForFunction(async () => (await navigator.serviceWorker.getRegistration())?.waiting?.state === 'installed', null, { timeout: 10_000 })
    assert.equal(await password(first).inputValue(), 'unsaved input')
    assert.equal(await password(second).inputValue(), 'another draft')
    await first.close()
    assert.equal(await password(second).inputValue(), 'another draft')
    const controllingShell = await second.evaluate(async () => (await fetch('/index.html')).text())
    assert.ok(controllingShell.includes(old), 'the remaining tab still uses the previous installation')
    assert.ok(!app.activated.has(current), 'the update waits while a previous tab remains')
    await second.close()
    // The browser activates the queued worker when no client keeps the old one.
    const deadline = Date.now() + 10_000
    while (!app.activated.has(current)) {
      assert.ok(Date.now() < deadline, 'waiting worker did not activate')
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    const reopened = await context.newPage()
    await reopened.goto(urls)
    assert.equal(await reopened.locator('script[type=module]').getAttribute('src'), expected)
  } finally {
    await context.close()
    await app.close()
  }
})

test('Settings applies an update and reloads only the requesting tab', { skip: !previous }, async () => {
  const app = await fixture(previous, true)
  const context = await browser.newContext()
  try {
    const oldId = JSON.parse(await readFile(join(previous, 'version.json'), 'utf8')).id
    const newId = JSON.parse(await readFile(join(current, 'version.json'), 'utf8')).id
    assert.notEqual(oldId, newId)
    const settings = await context.newPage()
    await loadControlled(settings, `${app.url}/settings`)
    await settings.getByText(oldId, { exact: true }).waitFor()
    const editing = await context.newPage()
    await editing.goto(`${app.url}/login`)
    await editing.evaluate(() => { window.pwaDraftFixture = 'still editing' })
    app.update(current)
    await settings.getByRole('button', { name: 'Check for updates' }).click()
    await settings.getByRole('button', { name: 'Update and reload' }).click()
    await settings.getByText(newId, { exact: true }).waitFor()
    assert.equal(await editing.evaluate(() => window.pwaDraftFixture), 'still editing')
  } finally {
    await context.close()
    await app.close()
  }
})

async function openPreviousBuildEditorAfterSwitch(retained) {
  const store = retained ? await mkdtemp(join(tmpdir(), 'rainver-web-assets-')) : null
  const app = await fixture(previous, true, store)
  const context = await browser.newContext()
  const chunk = async dir => `/assets/${(await readdir(join(dir, 'assets'))).find(name => name.startsWith('CodeMirrorEditor-') && name.endsWith('.js'))}`
  try {
    const [oldEditor, newEditor] = [await chunk(previous), await chunk(current)]
    assert.notEqual(oldEditor, newEditor, 'use two builds whose editor chunks differ')
    const page = await context.newPage()
    await loadControlled(page, `${app.url}/spaces/${space.id}/projects/${project.id}`)
    await page.getByRole('heading', { name: project.name, exact: true }).waitFor()
    await page.evaluate(() => { window.pwaDraftFixture = 'still editing' })
    assert.ok(!app.requests.includes(oldEditor), 'the editor must still be unloaded when the release switches')
    app.update(current)
    await page.evaluate(async () => { await (await navigator.serviceWorker.ready).update() })
    await page.waitForFunction(async () => (await navigator.serviceWorker.getRegistration())?.waiting?.state === 'installed')
    // Client-side navigation in the still-open tab: its router asks for the previous build's lazy chunks.
    await page.evaluate(path => { history.pushState(null, '', path); dispatchEvent(new PopStateEvent('popstate')) },
      `/spaces/${space.id}/projects/${project.id}/files?folder=${folder.id}&path=${file.path}`)
    const editor = page.locator('.cm-content')
    const opened = await editor.getByText(file.content.trim()).waitFor({ timeout: 5_000 }).then(() => true, () => false)
    if (opened) {
      await editor.click()
      await page.keyboard.press('End')
      await page.keyboard.type(' unsaved draft')
      assert.ok((await editor.textContent()).includes('unsaved draft'))
    }
    // A failed feature download never reloads the tab by itself.
    await new Promise(resolve => setTimeout(resolve, 1_000))
    assert.equal(await page.evaluate(() => window.pwaDraftFixture), 'still editing')
    assert.ok(app.requests.includes(oldEditor), 'the previous build asked the origin for its own editor chunk')
    assert.ok(!app.requests.includes(newEditor), 'the open tab never mixed in the new build')
    assert.ok(!app.activated.has(current), 'the new worker still waits for the previous tab')
    assert.equal(await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.waiting?.state), 'installed')
    return opened
  } finally {
    await context.close()
    await app.close()
    if (store) await Promise.all([store, `${store}.link`].map(dir => rm(dir, { recursive: true, force: true })))
  }
}

test('a tab left on the previous build opens its uncached editor after the release switch', { skip: !previous }, async () => {
  assert.equal(await openPreviousBuildEditorAfterSwitch(true), true)
})

test('without the retained previous build that same editor cannot load', { skip: !previous }, async () => {
  assert.equal(await openPreviousBuildEditorAfterSwitch(false), false)
})

// The tab's own lazy route is gone (no retained build), the panel offers the
// update, and the person holds unsaved input: staying at the browser's prompt
// must keep that input and activate nothing; leaving then applies the update.
const engines = { chromium, webkit }
async function withEngine(name, run) {
  assert.ok(engines[name], `unknown PWA_ENGINES entry ${name}`)
  const engine = await engines[name].launch(name === 'chromium' ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {})
  const context = await engine.newContext({ serviceWorkers: 'allow' })
  try { await run(context) } finally { await context.close(); await engine.close() }
}
const guardDraft = page => page.evaluate(() => {
  window.pwaDocument = Math.random()
  window.pwaDraft = 'unsaved'
  addEventListener('beforeunload', event => { if (window.pwaDraft) { event.preventDefault(); event.returnValue = '' } })
  return window.pwaDocument
})
for (const name of (process.env.PWA_ENGINES ?? 'chromium,webkit').split(',')) {
  test(`${name}: Settings keeps unsaved input when the person stays, and updates when they leave`, { skip: !previous }, async () => {
    const app = await fixture(previous, true)
    try {
      await withEngine(name, async context => {
        const [oldId, newId] = await Promise.all([previous, current].map(async dir => JSON.parse(await readFile(join(dir, 'version.json'), 'utf8')).id))
        const page = await context.newPage()
        const dialogs = []
        let leave = false
        page.on('dialog', dialog => { dialogs.push(dialog.type()); void (leave ? dialog.accept() : dialog.dismiss()) })
        await loadControlled(page, `${app.url}/settings`)
        await page.getByText(oldId, { exact: true }).waitFor()
        const token = await guardDraft(page)
        app.update(current)
        await page.getByRole('button', { name: 'Check for updates' }).click()
        const updateButton = page.getByRole('button', { name: 'Update and reload' })
        await updateButton.click({ noWaitAfter: true })
        await page.getByText(/Reload cancelled\. Your unsaved input is still on this page/).waitFor({ timeout: 15_000 })
        assert.deepEqual(dialogs, ['beforeunload'])
        assert.deepEqual(await page.evaluate(() => [window.pwaDocument, window.pwaDraft]), [token, 'unsaved'])
        assert.ok(!app.activated.has(current), 'staying must not have activated the new worker')
        leave = true
        await updateButton.click({ noWaitAfter: true })
        await page.getByText(newId, { exact: true }).waitFor({ timeout: 20_000 })
        assert.ok(app.activated.has(current))
      })
    } finally { await app.close() }
  })

  test(`${name}: staying at the unsaved-input prompt keeps the tab recoverable, leaving updates it`, { skip: !previous }, async () => {
    const app = await fixture(previous, true)
    const route = async dir => `/assets/${(await readdir(join(dir, 'assets'))).find(file => file.startsWith('ProjectFilesPage-') && file.endsWith('.js'))}`
    const buildId = async dir => JSON.parse(await readFile(join(dir, 'version.json'), 'utf8')).id
    try { await withEngine(name, async context => {
      const [oldRoute, newRoute] = [await route(previous), await route(current)]
      assert.notEqual(oldRoute, newRoute, 'use two builds whose Files route chunks differ')
      const page = await context.newPage()
      const dialogs = []
      let leave = false
      page.on('dialog', dialog => { dialogs.push(dialog.type()); void (leave ? dialog.accept() : dialog.dismiss()) })
      await loadControlled(page, `${app.url}/spaces/${space.id}/projects/${project.id}`)
      await page.getByRole('heading', { name: project.name, exact: true }).waitFor()
      const notFound = page.getByText('Project not found', { exact: true })
      assert.equal(await notFound.count(), 0, 'the fixture must serve the Project')
      assert.ok(app.responses.some(r => r.path === `/api/v1/projects/${project.id}` && r.status === 200))
      // Unsaved input, guarded the way the editor and comment drafts guard theirs.
      const documentToken = await guardDraft(page)
      app.update(current)
      await page.evaluate(async () => { await (await navigator.serviceWorker.ready).update() })
      await page.waitForFunction(async () => (await navigator.serviceWorker.getRegistration())?.waiting?.state === 'installed', null, { timeout: 15_000 })

      await page.evaluate(path => { history.pushState(null, '', path); dispatchEvent(new PopStateEvent('popstate')) },
        `/spaces/${space.id}/projects/${project.id}/files?folder=${folder.id}&path=${file.path}`)
      const status = page.getByRole('status').filter({ hasText: /Rainver was updated after this tab opened|Reload cancelled/ })
      await status.waitFor({ timeout: 15_000 })
      assert.deepEqual(app.responses.filter(r => r.path === oldRoute).map(r => r.status), [404], 'the tab asked for its own, deleted route chunk')
      assert.ok(!app.requests.includes(newRoute), 'the open tab never mixed in the new build')
      assert.equal(await notFound.count(), 0)

      const updateButton = page.getByRole('button', { name: 'Update and reload' })
      await updateButton.click({ noWaitAfter: true })
      await page.getByText(/Reload cancelled\. Your unsaved input is still on this page/).waitFor({ timeout: 15_000 })
      assert.deepEqual(dialogs, ['beforeunload'], 'the browser asked before discarding the input')
      assert.deepEqual(await page.evaluate(() => [window.pwaDocument, window.pwaDraft]), [documentToken, 'unsaved'])
      assert.ok(!app.activated.has(current), 'staying must not have activated the new worker')
      assert.equal(await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.waiting?.state), 'installed')
      assert.equal(await page.evaluate(() => sessionStorage.getItem('rainver:update-after-reload')), null)
      assert.ok(await updateButton.isEnabled(), 'the update can be tried again')

      leave = true
      await updateButton.click({ noWaitAfter: true })
      const newId = await buildId(current)
      await page.waitForFunction(id => document.querySelector('meta[name="rainver-build-id"]')?.content === id, newId, { timeout: 20_000 })
      await page.locator('.cm-content').getByText(file.content.trim()).waitFor({ timeout: 15_000 })
      assert.deepEqual(dialogs, ['beforeunload', 'beforeunload'])
      assert.ok(app.activated.has(current), 'the update was applied')
      assert.ok(app.requests.includes(newRoute), 'the reloaded tab opened the new build\'s route')
      assert.equal(await notFound.count(), 0)
      assert.equal(await page.evaluate(() => window.pwaDraft), undefined, 'a new document')
    }) } finally { await app.close() }
  })
}
