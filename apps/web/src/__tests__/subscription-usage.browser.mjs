import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { before, after, test } from 'node:test'
import { chromium } from 'playwright-core'
import { preview } from 'vite'

const shots = '/tmp/rainver-subscription-usage-shots'
const space = 'quota-space', now = '2026-11-06T12:00:00.000Z'
const account = { provider: 'anthropic', product: 'claude', account_id: 'a'.repeat(64), organization_id: 'b'.repeat(64) }
const account_display = { email: 'person.long-account-name@example.invalid', workspace_name: 'Personal workspace' }
const quota = { account, account_display, available: true, session_pct: 42, session_resets: 'Resets 2026-11-07T12:00:00Z', week_pct: 68, week_resets: 'Resets 2026-11-10T12:00:00Z', error: null }
const copies = ['own', 'managed:1.0.0'].map(id => ({ id, version: '1.0.0', runtime_version: '2.1.232', logged_in: true, reports_subscription_quota: true, options: { config_options: [], cli_login_available: true } }))
const host = { id: 'desk', owner_user_id: 'quota-user', machine_id: 'desk-machine', machine_name: 'Desk', environment_kind: 'linux_native', name: 'Desk workstation', kind: 'remote', status: 'online', last_heartbeat_at: now, platform: 'linux', arch: 'x64', daemon_version: '0.4.7', created_at: now, updated_at: now, capabilities_json: { runtimes: ['claude'], installations: { claude_code: copies } } }
const pool = { id: 'shared-pool', account, account_display, label: `Claude · ${account_display.email} · ${account_display.workspace_name}`, windows: [
  { id: 'session', label: 'Session', used_pct: 42, resets: quota.session_resets, checked_at: now },
  { id: 'week', label: 'Weekly', used_pct: 68, resets: quota.week_resets, checked_at: now },
], connections: copies.map(copy => ({ host_id: host.id, host_name: host.name, runtime_key: 'claude_code', runtime_name: 'Claude Code', installation: copy.id, online: true, can_refresh: true, checked_at: now, error: null })) }
const usage = copies.map(copy => ({ host_id: host.id, runtime_key: 'claude_code', installation: copy.id, pool_id: pool.id, quota, checked_at: now }))
let server, browser, baseUrl
before(async () => {
  await mkdir(shots, { recursive: true })
  server = await preview({ configFile: false, preview: { host: '127.0.0.1', port: 0 } })
  baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE })
})
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.httpServer.close(resolve)) })

async function fixtures(page, state) {
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname.replace('/api/v1', '')
    let data
    if (path === '/me') data = { id: 'quota-user', name: 'Quota tester', email: 'test@example.invalid', default_space_id: space, instance_role: 'admin', is_instance_admin: true }
    else if (path === '/me/spaces') data = [{ id: space, name: 'Quota Space', type: 'personal', role: 'owner' }]
    else if (path === '/plugins/effective') data = { plugins: {} }
    else if (path === '/hosts') data = { items: [host] }
    else if (path === '/hosts/subscription-usage') {
      if (state.denied) return route.fulfill({ status: 403, json: { detail: 'Access denied' } })
      data = { items: state.unavailable ? [{ ...pool, account: null, windows: [], connections: pool.connections.map(c => ({ ...c, online: false, error: 'Host offline' })) }] : [pool] }
    }
    else if (path === '/hosts/runtime-definitions') data = { items: [{ runtime_key: 'claude_code', display_name: 'Claude Code', command: 'claude', remote_eligible: true, reports_managed_cli_version: true, supports_runtime_native: true, supports_model_provider: false }] }
    else if (path === '/hosts/desk/usage') data = { items: usage }
    else if (path === '/hosts/desk/cli-tools') data = { tools: [], operations: [], installable: false, availability: 'online' }
    else if (path === '/hosts/desk/tool-operations') data = { items: [] }
    else if (path.endsWith('/usage') && route.request().method() === 'POST') { state.refreshes++; data = usage[0] }
    else if (path.endsWith('/attention')) data = { items: [], counts: { needs_you: 0, unread: 0 } }
    else if (path.endsWith('/quota')) data = { warn_pct: 70, reserve_pct: 100, logins: [], holds: [] }
    else if (state.settingsNavigation) return route.fulfill({ status: 503, json: { detail: 'Settings data unavailable in navigation fixture' } })
    else data = { items: [], total: 0, limit: 100, offset: 0 }
    return route.fulfill({ json: data })
  })
}
async function capture(page, name) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), 'No horizontal overflow')
  await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true })
}

for (const locale of ['en', 'zh-CN']) for (const theme of ['dark', 'light']) for (const width of [390, 1280]) {
  test(`same account: Command Center entry, quota detail and return ${locale}/${theme}/${width}`, async () => {
    const context = await browser.newContext({ viewport: { width, height: 960 }, serviceWorkers: 'block' })
    await context.addInitScript(({ locale }) => { localStorage.setItem('rainver:locale', locale) }, { locale })
    const page = await context.newPage(), state = { refreshes: 0 }, errors = []
    page.on('pageerror', error => errors.push(error.message))
    page.setDefaultTimeout(10000)
    await fixtures(page, state)
    try {
      await page.goto(`${baseUrl}/spaces/${space}/command-center?host=desk`)
      if (theme === 'light') await page.evaluate(() => document.documentElement.classList.add('theme-light'))
      const links = page.getByRole('link', { name: locale === 'en' ? 'View quota' : '查看额度', exact: true })
      await links.first().waitFor()
      assert.equal(await links.count(), 2)
      assert.equal(await links.first().getAttribute('href'), await links.last().getAttribute('href'))
      assert.equal(await page.getByRole('progressbar').count(), 0)
      assert.equal(await page.getByText(`${account_display.email} · ${account_display.workspace_name}`, { exact: true }).count(), 2)
      await capture(page, `entry-${locale}-${theme}-${width}`)
      await links.first().click()
      await page.getByRole('heading', { name: pool.label }).waitFor()
      assert.equal(await page.getByRole('progressbar').count(), 2)
      await page.getByText(locale === 'en' ? '2 connections' : '2 个关联连接', { exact: true }).click()
      await capture(page, `detail-${locale}-${theme}-${width}`)
      const refreshed = page.waitForResponse(response => response.url().includes('/hosts/subscription-usage'))
      await page.getByRole('button', { name: locale === 'en' ? 'Refresh quota' : '刷新额度', exact: true }).click()
      await refreshed
      assert.equal(state.refreshes, 1)
      await page.getByRole('link', { name: /Desk workstation · Claude Code · own/ }).click()
      await page.getByTestId('host-agent-desk-claude_code').waitFor()
      assert.deepEqual(errors, [])
    } finally { await context.close() }
  })
}
test('unavailable quotas and permission failures stay distinct from zero usage', async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 960 }, serviceWorkers: 'block' })
  const page = await context.newPage(), state = { unavailable: true, refreshes: 0 }
  await fixtures(page, state)
  try {
    await page.goto(`${baseUrl}/spaces/${space}/usage?tab=quotas`)
    await page.getByText(/Account not identified/).waitFor()
    assert.equal(await page.getByRole('progressbar').count(), 0)
    assert.equal(await page.getByRole('button', { name: 'Refresh quota', exact: true }).isDisabled(), true)
    await capture(page, 'unavailable-en-dark-390')
    state.denied = true
    await page.getByRole('button', { name: 'Reload accounts' }).click()
    await page.getByRole('alert').waitFor()
    assert.equal(await page.getByRole('heading', { name: pool.label }).count(), 0)
    await capture(page, 'denied-en-dark-390')
  } finally { await context.close() }
})

// Navigation remains usable even while individual settings APIs are unavailable.
for (const { locale, theme, width } of [
  { locale: 'en', theme: 'dark', width: 1280 }, { locale: 'zh-CN', theme: 'light', width: 390 },
  { locale: 'en', theme: 'light', width: 390 }, { locale: 'zh-CN', theme: 'dark', width: 1280 },
]) test(`settings parents and return links ${locale}/${theme}/${width}`, async () => {
  const context = await browser.newContext({ viewport: { width, height: 960 }, serviceWorkers: 'block' })
  await context.addInitScript(({ locale, theme }) => { localStorage.setItem('rainver:locale', locale); localStorage.setItem('rainver:theme', theme) }, { locale, theme })
  const page = await context.newPage(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.setDefaultTimeout(10000)
  await fixtures(page, { refreshes: 0, settingsNavigation: true })
  const navName = locale === 'en' ? 'Settings navigation' : '设置导航'
  try {
    await page.goto(`${baseUrl}/settings`)
    if (theme === 'light') await page.evaluate(() => document.documentElement.classList.add('theme-light'))
    await page.locator('main h1, main h2').first().waitFor()
    assert.equal(await page.getByRole('navigation', { name: navName }).count(), 0)
    await capture(page, `settings-root-${locale}-${theme}-${width}`)
    for (const target of [`/spaces/${space}/usage`, `/spaces/${space}/providers`, '/settings/security']) {
      await page.locator(`main a[href="${target}"]`).first().click()
      const back = page.getByRole('navigation', { name: navName }).getByRole('link', { name: locale === 'en' ? 'Back to Settings' : '返回设置', exact: true })
      await back.waitFor()
      await page.locator('main h1, main h2').first().waitFor()
      if (target.endsWith('/usage')) {
        if (width >= 768) assert.equal(await page.getByRole('navigation', { name: locale === 'en' ? 'Global navigation' : '全局导航' }).getByRole('link', { name: locale === 'en' ? 'Settings' : '设置', exact: true }).getAttribute('aria-current'), 'page')
        if (width < 768) {
          await page.getByRole('button', { name: locale === 'en' ? 'More' : '更多', exact: true }).click()
          assert.equal(await page.getByRole('dialog').getByRole('link', { name: locale === 'en' ? 'Settings' : '设置', exact: true }).getAttribute('aria-current'), 'page')
          await page.keyboard.press('Escape')
          await page.getByRole('dialog').waitFor({ state: 'hidden' })
        }
        await capture(page, `settings-usage-${locale}-${theme}-${width}`)
      }
      await back.click()
      await page.waitForURL(`${baseUrl}/settings`)
      await page.locator('main h1, main h2').first().waitFor()
    }
    await page.goto(`${baseUrl}/spaces/${space}/space-settings`)
    await page.locator('main h1, main h2').first().waitFor()
    assert.equal(await page.getByRole('navigation', { name: navName }).count(), 0)
    for (const child of ['plugins', 'network-profiles', 'retrieval-settings', 'prompts']) {
      await page.locator(`main a[href="/spaces/${space}/${child}"]`).first().click()
      const back = page.getByRole('navigation', { name: navName }).getByRole('link', { name: locale === 'en' ? 'Back to Space Settings' : '返回空间设置', exact: true })
      await back.waitFor()
      await page.locator('main h1, main h2').first().waitFor()
      if (child === 'prompts') assert.equal(await page.locator('main a[href*="library/reading?settings=reading"]').count(), 0)
      await capture(page, `settings-${child}-${locale}-${theme}-${width}`)
      await back.click()
      await page.waitForURL(`${baseUrl}/spaces/${space}/space-settings`)
    }
    await page.goto(`${baseUrl}/spaces/${space}/prompts?reading_method=1&item_id=item-a&project_id=project-a`)
    await page.locator('main h1, main h2').first().waitFor()
    assert.equal(await page.getByRole('navigation', { name: navName }).count(), 0)
    assert.equal(await page.locator('main a[href*="library/items/item-a"]').count(), 1)
    await page.goto(`${baseUrl}/instance-settings`)
    await page.locator('main h1, main h2').first().waitFor()
    assert.equal(await page.getByRole('navigation', { name: navName }).count(), 0)
    await capture(page, `instance-settings-${locale}-${theme}-${width}`)
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})
