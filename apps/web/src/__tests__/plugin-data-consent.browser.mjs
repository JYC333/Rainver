import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { after, before, test } from 'node:test'
import { chromium } from 'playwright-core'
import { preview } from 'vite'

// ADR 0030 standing consent from the person's own Settings, on the built app
// with synthetic APIs: a Space member allows their own read-only background
// consent for a sensitive plugin, sees it active with its expiry, and revokes
// it. The options shown are exactly what the server offers this person; the
// create echoes the option's package identity. Once the plugin is turned off
// no option remains, yet the active consent stays listed with its frozen tools
// and revocable.
const space = 'space-pc', member = 'user-member', now = '2026-11-17T09:00:00Z'
const shots = process.env.PLUGIN_CONSENT_SHOTS ?? '/tmp/rainver-plugin-consent-shots'
const pin = action_id => ({ action_id, action_version: 1, data_class: 'sensitive', side_effects: 'none', gate_class: null })
const option = { plugin_id: 'journal', plugin_name: 'Journal', plugin_version: '1.0.0', toolset: 'read', data_class: 'sensitive', scope: 'background', authority_hash: 'contract-1', tools: [pin('plugin.journal.entry.list'), pin('plugin.journal.mood.list')], default_expires_in_seconds: 86400, active_grant_id: null, changes: { added: ['plugin.journal.mood.list'], removed: [], changed: [] } }
const grant = { id: 'grant-pc', space_id: space, plugin_id: 'journal', toolset: 'read', data_class: 'sensitive', scope: 'background', data_owner_user_id: member, granted_by_user_id: member, target_run_id: null,
  plugin_version: '1.0.0', authority_hash: 'contract-1', expanded: option.tools, status: 'active', expires_at: '2026-11-18T09:00:00Z', revoked_at: null, created_at: now, reconsent: null }

async function fixtures(page, state) {
  await page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname.replace('/api/v1', '')
    let data
    if (route.request().method() !== 'GET') state.writes.push(path)
    if (path === '/me') data = { id: member, name: 'Data owner', email: `${member}@example.test`, default_space_id: space, instance_role: 'user', is_instance_admin: false }
    else if (path === '/me/spaces') data = [{ id: space, name: 'Family', type: 'team', role: 'member' }]
    else if (path === '/plugins/effective') data = { plugins: {} }
    else if (path === '/queries/plugin_data_grant.list') data = { status: 'succeeded', data: { items: state.active ? [grant] : [], consentable: state.disabled ? [] : [{ ...option, active_grant_id: state.active ? grant.id : null, changes: state.active ? null : option.changes }] } }
    else if (path === '/actions/plugin_data_grant.create') { state.active = true; state.created = JSON.parse(route.request().postData() ?? '{}'); data = { status: 'succeeded', data: grant } }
    else if (path === '/actions/plugin_data_grant.revoke') { state.active = false; data = { status: 'succeeded', data: { ...grant, status: 'revoked', revoked_at: now } } }
    else if (path === '/me/agent-attention/snapshot') data = { type: 'attention.snapshot', seq: 1, version: 'pc', unread_count: 0, page: { items: [], total: 0, limit: 100, offset: 0 }, notices: [] }
    else if (path === '/me/agent-attention/stream') return route.fulfill({ status: 503, body: '' })
    else return route.fulfill({ status: 404, json: { detail: `Unavailable in plugin consent fixture: ${path}` } })
    return route.fulfill({ json: data })
  })
}

let server, browser, baseUrl = process.env.LAYOUT_BASE_URL
before(async () => {
  await mkdir(shots, { recursive: true })
  if (!baseUrl) { server = await preview({ configFile: false, preview: { host: '127.0.0.1', port: 0 } }); baseUrl = `http://127.0.0.1:${server.httpServer.address().port}` }
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE })
})
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.httpServer.close(resolve)) })
async function capture(page, name) {
  // Dialog open/close transitions finish before the frame is judged.
  await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running'))
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  assert.deepEqual(await page.getByText('Unavailable in plugin consent fixture:', { exact: false }).allTextContents(), [], 'No fixture API errors on the visible surface')
  const size = await page.evaluate(() => ({ width: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }))
  assert.ok(size.content <= size.width + 1, JSON.stringify(size))
  await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true })
}
const L = { en: { title: 'Agent access to plugin data', language: 'Language', allow: 'Allow Journal · read', confirm: 'Allow', revoke: 'Revoke Journal · read', active: 'Allowed', changed: 'Changed since your last consent', revokeOff: 'Revoke journal · read', frozen: 'Frozen when you allowed it (v1.0.0)', notOffered: 'not offered for new consent right now' },
  'zh-CN': { title: 'Agent 访问插件数据', language: '语言', allow: '允许 Journal · 读取', confirm: '允许', revoke: '撤销 Journal · 读取', active: '已允许', changed: '自上次同意后有变化', revokeOff: '撤销 journal · 读取', frozen: '允许时已冻结（v1.0.0）', notOffered: '当前不提供新授权' } }

for (const locale of ['en', 'zh-CN']) for (const theme of ['dark', 'light']) for (const width of [390, 1280]) {
  test(`data owner allows and revokes their background consent from Settings: ${locale}/${theme}/${width}`, async () => {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block' })
    await context.addInitScript(({ locale, theme }) => { localStorage.setItem('rainver:locale', locale); localStorage.setItem('rainver:theme', theme) }, { locale, theme })
    const page = await context.newPage()
    page.setDefaultTimeout(10000)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    const state = { active: false, disabled: false, writes: [], created: null }
    await fixtures(page, state)
    try {
      await page.goto(`${baseUrl}/settings`)
      if (theme === 'light') await page.evaluate(() => document.documentElement.classList.add('theme-light'))
      const panel = page.getByTestId('plugin-data-consent-panel')
      await panel.getByText(L[locale].title).waitFor()
      await panel.getByText(L[locale].changed, { exact: false }).waitFor()
      // The entry in its parent: beside the neighbouring Language card.
      await page.getByText(L[locale].language, { exact: true }).first().scrollIntoViewIfNeeded()
      await capture(page, `settings-entry-${locale}-${theme}-${width}`)
      await panel.getByRole('button', { name: L[locale].allow }).click()
      await page.getByRole('dialog').waitFor()
      await capture(page, `settings-confirm-${locale}-${theme}-${width}`)
      await page.getByRole('dialog').getByRole('button', { name: L[locale].confirm, exact: true }).click()
      await panel.getByText(L[locale].active, { exact: true }).waitFor()
      await page.getByRole('dialog').waitFor({ state: 'detached' })
      await panel.scrollIntoViewIfNeeded()
      await capture(page, `settings-active-${locale}-${theme}-${width}`)
      assert.deepEqual(state.created, { plugin_id: 'journal', toolset: 'read', data_class: 'sensitive', scope: 'background', authority_hash: 'contract-1', expires_in_seconds: 86400 })
      // The plugin is turned off: nothing to allow, the consent still revocable with what it froze.
      state.disabled = true
      await page.reload()
      if (theme === 'light') await page.evaluate(() => document.documentElement.classList.add('theme-light'))
      await panel.getByText(L[locale].frozen, { exact: false }).waitFor()
      await panel.getByText(L[locale].notOffered, { exact: false }).waitFor()
      assert.equal(await panel.getByRole('button', { name: L[locale].allow }).count(), 0)
      await panel.scrollIntoViewIfNeeded()
      await capture(page, `settings-disabled-${locale}-${theme}-${width}`)
      await panel.getByRole('button', { name: L[locale].revokeOff }).click()
      await panel.waitFor({ state: 'detached' })
      assert.deepEqual(state.writes, ['/actions/plugin_data_grant.create', '/actions/plugin_data_grant.revoke'])
      assert.deepEqual(errors, [], 'No uncaught browser errors')
    } catch (error) {
      await page.screenshot({ path: `${shots}/failure-${locale}-${theme}-${width}.png`, fullPage: true })
      throw error
    } finally { await context.close() }
  })
}
