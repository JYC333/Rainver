import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { before, after, test } from 'node:test'
import { chromium } from 'playwright-core'
import { preview } from 'vite'

const shots = '/tmp/rainver-browser-accounts-shots'
const space = 'accounts-space'
const people = {
  'session-a': { id: 'user-a', display_name: 'Ada Lovelace', email: 'ada.lovelace@example.invalid', avatar_url: null, default_space_id: space, created_at: '2026-01-01T00:00:00.000Z', last_login_at: null },
  'session-b': { id: 'user-b', display_name: 'Ben Okafor-Lindqvist with a long display name', email: 'ben.okafor-lindqvist.long.address@example.invalid', avatar_url: null, default_space_id: space, created_at: '2026-01-01T00:00:00.000Z', last_login_at: null },
}
let server, browser, baseUrl
before(async () => {
  await mkdir(shots, { recursive: true })
  server = await preview({ configFile: false, preview: { host: '127.0.0.1', port: 0 } })
  baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE })
})
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.httpServer.close(resolve)) })

/**
 * One browser's server: the active account is shared by every tab of the
 * context, as the selector cookie is. `selected` is what the browser itself
 * last selected; `lateRevoked` a session a sign-out revoked whose late
 * answer selected it anyway, undone on the next request as the server does.
 */
function browserState() { return { active: 'session-a', selected: 'session-a', lateRevoked: null, logouts: 0, switches: [], stale: [], staleTabs: [], signIns: [], requests: [] } }

const attentionFrame = { type: 'attention.snapshot', seq: 1, version: 'v1', page: null, unread_count: 0, notices: [] }

async function fixtures(page, state, tab = 'page') {
  await page.route('**/api/v1/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace('/api/v1', '')
    const handle = request.headers()['x-rainver-account']
    state.requests.push({ tab, method: request.method(), path, handle })
    if (state.lateRevoked && state.active === state.lateRevoked) state.active = state.selected
    if (handle !== undefined && handle !== state.active && path !== '/auth/logout') {
      state.stale.push(path)
      state.staleTabs.push(tab)
      return route.fulfill({ status: 409, headers: { 'x-rainver-account-switched': '1' }, json: { code: 'account_switched', message: 'switched' } })
    }
    let data
    if (path === '/me' && state.active === '-') return route.fulfill({ status: 401, json: { code: 'authentication_required', message: 'Authentication required' } })
    if (path === '/me') data = { ...people[state.active], account_handle: state.active }
    else if (path === '/auth/logout') { state.active = state.selected = '-'; state.logouts += 1; return route.fulfill({ status: 204 }) }
    else if (path === '/me/spaces') data = [{ id: space, name: 'Accounts Space', type: 'personal', role: 'owner' }]
    else if (path === '/auth/config') data = { google_auth_available: true, bootstrap_registration_available: false, password_min_length: 15, password_max_length: 128 }
    else if (path === '/plugins/effective') data = { plugins: {} }
    else if (path === '/auth/browser-accounts') data = { accounts: Object.entries(people).map(([session, person]) => ({ user_id: person.id, email: person.email, display_name: person.display_name, avatar_url: null, active: session === state.active, remembered: true })), limit: 5 }
    else if (path === '/auth/browser-accounts/switch') {
      const target = Object.entries(people).find(([, person]) => person.id === request.postDataJSON().user_id)
      state.switches.push(handle)
      state.active = state.selected = target[0]
      data = { ok: true, account_handle: target[0] }
    }
    else if (path === '/auth/sign-in/email') {
      state.signIns.push({ ...request.postDataJSON(), handle })
      if (request.postDataJSON().password !== 'the right password') return route.fulfill({ status: 401, json: { code: 'invalid_credentials', message: 'Invalid email or password' } })
      state.active = state.selected = 'session-b'
      data = { user: people['session-b'], account_handle: 'session-b' }
    }
    else if (path === '/auth/accounts') data = [{ id: 'credential-a', provider: 'credential', account_id: 'user-a', created_at: '2026-01-01T00:00:00.000Z' }]
    else if (path === '/auth/reauth/status') data = { expires_at: new Date(Date.now() + 600_000).toISOString() }
    else if (path === '/auth/sessions') data = []
    else if (path === '/auth/password/change') {
      // Held until the test answers: Better Auth rotated the session, and the answer selects the new one in the browser.
      const logouts = state.logouts
      await new Promise(resolve => { state.answerChange = resolve })
      state.active = 'session-a2'
      if (state.logouts !== logouts) state.lateRevoked = 'session-a2'
      else state.selected = 'session-a2'
      // A tab that reloaded meanwhile no longer reads the answer; the browser still applied its cookies.
      return route.fulfill({ json: { ok: true, account_handle: 'session-a2' } }).catch(() => {})
    }
    else if (path === '/me/agent-attention/snapshot') data = attentionFrame
    else if (path === '/me/agent-attention/stream') return route.fulfill({ headers: { 'content-type': 'text/event-stream' }, body: `data: ${JSON.stringify(attentionFrame)}\n\n` })
    else if (path === '/hosts') data = { items: [] }
    else data = { items: [], total: 0, limit: 100, offset: 0 }
    return route.fulfill({ json: data })
  })
}

/** Waits for a fixture-side condition, failing after a few seconds. */
async function until(condition) {
  const deadline = Date.now() + 5000
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'condition not reached')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

async function capture(page, name) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), 'No horizontal overflow')
  await page.screenshot({ path: `${shots}/${name}.png` })
}

for (const locale of ['en', 'zh-CN']) for (const theme of ['dark', 'light']) for (const width of [390, 1280]) {
  test(`avatar menu: switch and add an account ${locale}/${theme}/${width}`, async () => {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' })
    await context.addInitScript(({ locale, theme }) => {
      localStorage.setItem('rainver:locale', locale)
      localStorage.setItem('rainver:theme', theme)
    }, { locale, theme })
    const state = browserState(), errors = []
    const en = locale === 'en'
    const page = await context.newPage(), other = await context.newPage()
    for (const [name, tab] of [['page', page], ['other', other]]) { tab.on('pageerror', error => errors.push(error.message)); tab.setDefaultTimeout(10000); await fixtures(tab, state, name) }
    try {
      await page.goto(`${baseUrl}/spaces/${space}/command-center`)
      await other.goto(`${baseUrl}/spaces/${space}/command-center`)
      const avatar = page.getByTitle('Ada Lovelace', { exact: true })
      await avatar.click()
      const switchTo = page.getByRole('menuitem', { name: new RegExp(people['session-b'].display_name) })
      await switchTo.waitFor()
      await page.getByRole('menuitem', { name: en ? 'Sign out of all accounts' : '退出所有账号' }).waitFor()
      await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running'))
      await capture(page, `menu-${locale}-${theme}-${width}`)

      // Adding: a refused password leaves the dialog open and the account unchanged.
      await page.getByRole('menuitem', { name: en ? 'Add another account' : '添加其他账号' }).click()
      const dialog = page.getByRole('dialog')
      await dialog.getByRole('button', { name: en ? 'Continue with Google' : '使用 Google 继续' }).waitFor()
      await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running'))
      await capture(page, `add-${locale}-${theme}-${width}`)
      await dialog.getByLabel(en ? 'Email' : '邮箱').fill('ben@example.invalid')
      await dialog.getByLabel(en ? 'Password' : '密码').fill('not the password')
      await dialog.getByRole('button', { name: en ? 'Sign in and switch' : '登录并切换' }).click()
      await dialog.getByRole('alert').waitFor()
      await capture(page, `add-refused-${locale}-${theme}-${width}`)
      assert.equal(state.signIns[0].add_account, true)
      assert.equal(state.active, 'session-a')
      await page.keyboard.press('Escape')

      // Switching reloads this tab as Ben, and the other tab follows instead of writing as Ada.
      await other.evaluate(() => sessionStorage.setItem('rainver:conversation-draft:v1:room-1', 'an unsent draft of Ada'))
      const switchedAt = state.requests.length
      const reloaded = other.waitForEvent('load')
      await avatar.click()
      await page.getByRole('menuitem', { name: new RegExp(people['session-b'].display_name) }).click()
      await page.getByTitle(people['session-b'].display_name, { exact: true }).waitFor()
      await reloaded
      await other.getByTitle(people['session-b'].display_name, { exact: true }).waitFor()
      assert.deepEqual(state.switches, ['session-a'])
      // The other tab dropped its own draft, and nothing it sent after the switch wrote without naming its account.
      assert.equal(await other.evaluate(() => sessionStorage.getItem('rainver:conversation-draft:v1:room-1')), null)
      assert.deepEqual(state.requests.slice(switchedAt).filter(entry => entry.method !== 'GET' && entry.handle === undefined && entry.path !== '/auth/logout'), [])
      await capture(page, `switched-${locale}-${theme}-${width}`)
      assert.deepEqual(errors, [])
    } finally { await context.close() }
  })
}

test('a tab that missed the announcement is refused, then reloads as the current account', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' })
  const state = browserState()
  const page = await context.newPage()
  page.setDefaultTimeout(10000)
  await fixtures(page, state)
  try {
    await page.goto(`${baseUrl}/spaces/${space}/command-center`)
    await page.getByTitle('Ada Lovelace', { exact: true }).waitFor()
    // Switched from a tab of this browser this one never heard from.
    state.active = 'session-b'
    // Its next request — a background read, or opening the menu — is refused and the tab reloads.
    await page.getByTitle('Ada Lovelace', { exact: true }).click({ timeout: 2000 }).catch(() => {})
    await page.getByTitle(people['session-b'].display_name, { exact: true }).waitFor()
    assert.ok(state.stale.length > 0)
  } finally { await context.close() }
})

test('a tab whose reload was cancelled keeps naming its account, so it is refused, and asks only once', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' })
  const state = browserState()
  const page = await context.newPage(), other = await context.newPage()
  for (const [name, tab] of [['page', page], ['other', other]]) { tab.setDefaultTimeout(10000); await fixtures(tab, state, name) }
  try {
    await page.goto(`${baseUrl}/spaces/${space}/command-center`)
    await other.goto(`${baseUrl}/spaces/${space}/command-center`)
    await other.getByTitle('Ada Lovelace', { exact: true }).waitFor()
    // Unsaved work: the person is asked before the tab leaves, and chooses to stay.
    await other.evaluate(() => window.addEventListener('beforeunload', event => { event.preventDefault(); event.returnValue = '' }))
    await other.locator('body').click()
    const prompts = []
    other.on('dialog', dialog => { prompts.push(dialog.type()); void dialog.dismiss() })

    await page.getByTitle('Ada Lovelace', { exact: true }).click()
    await page.getByRole('menuitem', { name: new RegExp(people['session-b'].display_name) }).click()
    await page.getByTitle(people['session-b'].display_name, { exact: true }).waitFor()
    await other.waitForFunction(() => true)
    await new Promise(resolve => setTimeout(resolve, 500))
    assert.deepEqual(prompts, ['beforeunload'])

    // Still on Ada's page: its next request names Ada and is refused, never served as Ben, and it does not ask again.
    const before = state.requests.length
    await other.getByTitle('Ada Lovelace', { exact: true }).click()
    await other.waitForFunction(() => true)
    await new Promise(resolve => setTimeout(resolve, 500))
    const after = state.requests.slice(before).filter(entry => entry.tab === 'other')
    assert.ok(after.length > 0, 'the tab made a request')
    assert.ok(after.every(entry => entry.handle === 'session-a' || entry.path === '/auth/logout'), JSON.stringify(after))
    assert.deepEqual(prompts, ['beforeunload'])
  } finally { await context.close() }
})

test('the avatar menu opens from the keyboard and Escape returns focus to it', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' })
  const state = browserState()
  const page = await context.newPage()
  page.setDefaultTimeout(10000)
  await fixtures(page, state)
  try {
    await page.goto(`${baseUrl}/spaces/${space}/command-center`)
    await page.getByRole('button', { name: 'Account menu for Ada Lovelace' }).waitFor()
    // While the menu is open the rest of the page is hidden from assistive technology, so hold the element itself.
    const trigger = page.getByTitle('Ada Lovelace', { exact: true })
    assert.equal(await trigger.getAttribute('aria-haspopup'), 'menu')
    await trigger.focus()
    await page.keyboard.press('Enter')
    await page.getByRole('menu').waitFor()
    assert.equal(await trigger.getAttribute('aria-expanded'), 'true')
    await page.keyboard.press('Escape')
    await page.getByRole('menu').waitFor({ state: 'detached' })
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false')
    assert.ok(await trigger.evaluate(element => element === document.activeElement))
    // The add-account dialog is not mounted with the shell: nothing reads the sign-in configuration yet.
    assert.equal(state.requests.filter(entry => entry.path === '/auth/config').length, 0)
  } finally { await context.close() }
})

test('signs out, then signs in again on the same page without being refused as the account it left', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' })
  const state = browserState(), errors = []
  const page = await context.newPage()
  page.setDefaultTimeout(10000)
  page.on('pageerror', error => errors.push(error.message))
  await fixtures(page, state)
  try {
    await page.goto(`${baseUrl}/spaces/${space}/command-center`)
    await page.getByTitle('Ada Lovelace', { exact: true }).click()
    let loads = 0
    page.on('load', () => { loads += 1 })
    await page.getByRole('menuitem', { name: 'Sign out of all accounts' }).click()
    await page.getByPlaceholder('Email').fill('ben@example.invalid')
    await page.getByPlaceholder('Password').fill('the right password')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await page.getByTitle(people['session-b'].display_name, { exact: true }).waitFor()
    // Signed in from the page it signed out on: nothing refused, no reload, and it names the new account.
    assert.deepEqual(state.stale, [])
    assert.equal(loads, 0)
    assert.equal(state.signIns.at(-1).handle, '-')
    assert.ok(state.requests.filter(entry => entry.path === '/me').at(-1).handle === 'session-b')
    await capture(page, 'signed-in-again')
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})

test('stays signed out when a password change answers after the sign-out, then signs in on the same page', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' })
  const state = browserState(), errors = []
  const page = await context.newPage()
  page.setDefaultTimeout(10000)
  page.on('pageerror', error => errors.push(error.message))
  await fixtures(page, state)
  try {
    await page.goto(`${baseUrl}/settings/security`)
    await page.getByLabel('Current password').fill('the right password')
    await page.getByLabel(/^New password/).fill('a new password of enough length')
    let loads = 0
    page.on('load', () => { loads += 1 })
    await page.getByRole('button', { name: 'Save password' }).click()
    await until(() => state.answerChange)
    await page.getByTitle('Ada Lovelace', { exact: true }).click()
    await page.getByRole('menuitem', { name: 'Sign out of all accounts' }).click()
    await page.getByPlaceholder('Email').waitFor()
    const signOuts = () => state.requests.filter(entry => entry.path === '/auth/logout').length
    assert.equal(signOuts(), 1)
    // The change's answer lands now and selects the rotated session the sign-out already revoked.
    state.answerChange()
    await until(() => state.active === 'session-a2')
    await page.getByPlaceholder('Email').fill('ben@example.invalid')
    await page.getByPlaceholder('Password').fill('the right password')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await page.getByTitle(people['session-b'].display_name, { exact: true }).waitFor()
    // Still signed out until then, never refused as a tab of the rotated session, and no reload.
    assert.deepEqual(state.stale, [])
    assert.equal(loads, 0)
    assert.equal(state.signIns.at(-1).handle, '-')
    // The browser was not signed out again for that answer.
    assert.equal(signOuts(), 1)
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})

test('an account another tab signed in after the sign-out stays signed in when the password change answers late', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' })
  const state = browserState(), errors = []
  const page = await context.newPage()
  const other = await context.newPage()
  for (const tab of [page, other]) {
    tab.setDefaultTimeout(10000)
    tab.on('pageerror', error => errors.push(error.message))
  }
  await fixtures(page, state, 'page')
  await fixtures(other, state, 'other')
  try {
    await page.goto(`${baseUrl}/settings/security`)
    await other.goto(`${baseUrl}/spaces/${space}/command-center`)
    await other.getByTitle('Ada Lovelace', { exact: true }).waitFor()
    await page.getByLabel('Current password').fill('the right password')
    await page.getByLabel(/^New password/).fill('a new password of enough length')
    await page.getByRole('button', { name: 'Save password' }).click()
    await until(() => state.answerChange)
    await page.getByTitle('Ada Lovelace', { exact: true }).click()
    await page.getByRole('menuitem', { name: 'Sign out of all accounts' }).click()
    await page.getByPlaceholder('Email').waitFor()
    // The other tab signs in as Ben; the page that changed the password follows it.
    await other.getByPlaceholder('Email').fill('ben@example.invalid')
    await other.getByPlaceholder('Password').fill('the right password')
    await other.getByRole('button', { name: 'Sign in', exact: true }).click()
    await other.getByTitle(people['session-b'].display_name, { exact: true }).waitFor()
    await page.getByTitle(people['session-b'].display_name, { exact: true }).waitFor()
    // The change's answer lands now and selects the rotated session the sign-out revoked, over Ben's.
    const answeredAt = state.requests.length
    const staleBefore = state.staleTabs.length
    state.answerChange()
    await until(() => state.active === 'session-a2')
    // Ben's tab keeps working as Ben and is never refused; a reload of either tab is Ben.
    const avatar = other.getByTitle(people['session-b'].display_name, { exact: true })
    await avatar.click()
    await other.getByRole('menuitem', { name: 'Sign out of all accounts' }).waitFor()
    await other.keyboard.press('Escape')
    await other.reload()
    await other.getByTitle(people['session-b'].display_name, { exact: true }).waitFor()
    await page.reload()
    await page.getByTitle(people['session-b'].display_name, { exact: true }).waitFor()
    assert.ok(state.requests.slice(answeredAt).some(entry => entry.tab === 'other' && entry.handle === 'session-b'))
    assert.deepEqual(state.staleTabs.slice(staleBefore).filter(tab => tab === 'other'), [], `refused after the answer: ${state.stale.slice(staleBefore)}`)
    // Ben was never signed out for that answer.
    assert.equal(state.requests.filter(entry => entry.path === '/auth/logout').length, 1)
    assert.equal(state.active, 'session-b')
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})

test('a tab that missed a switch and then switches itself reloads as the current account instead of reporting a failure', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' })
  const state = browserState()
  const page = await context.newPage()
  page.setDefaultTimeout(10000)
  await fixtures(page, state)
  try {
    await page.goto(`${baseUrl}/spaces/${space}/command-center`)
    await page.getByTitle('Ada Lovelace', { exact: true }).click()
    const switchTo = page.getByRole('menuitem', { name: new RegExp(people['session-b'].display_name) })
    await switchTo.waitFor()
    // Another tab this one never heard from switched the browser to Ben meanwhile.
    state.active = 'session-b'
    // Whether the page, before it left, told the person the account was gone.
    let reported = false
    await page.exposeFunction('reportFailureShown', () => { reported = true })
    await page.evaluate(() => {
      new MutationObserver(() => {
        if (document.body.textContent?.includes('no longer signed in here')) void window.reportFailureShown()
      }).observe(document.body, { childList: true, subtree: true, characterData: true })
    })
    const reloaded = page.waitForEvent('load')
    await switchTo.click()
    await reloaded
    await page.getByTitle(people['session-b'].display_name, { exact: true }).waitFor()
    // Its own switch was refused as stale, never run: the server saw no switch from it.
    assert.deepEqual(state.switches, [])
    assert.ok(state.stale.includes('/auth/browser-accounts/switch'))
    assert.equal(reported, false)
  } finally { await context.close() }
})
