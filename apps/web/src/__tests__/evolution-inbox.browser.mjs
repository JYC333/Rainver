import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { after, before, test } from 'node:test'
import { chromium } from 'playwright-core'
import { preview } from 'vite'

const space = 'space-bundle', now = '2026-11-06T12:00:00Z'
const bundle = { id: 'bundle-1', space_id: space, title: 'Reviewed changes', description: 'Patch and governed memory', status: 'pending_review', risk_level: 'high', member_count: 2, pending_count: 2, approved_count: 0, rollbackable: false, rollback_blockers: [], created_at: now, updated_at: now,
  members: ['code_patch', 'memory_create'].map((type, i) => ({ id: `member-${i}`, proposal_id: `proposal-${i}`, status: 'pending', before_snapshot_available: false, decided_at: null, proposal: { id: `proposal-${i}`, title: i ? 'Keep the reviewed finding' : 'Apply the reviewed file change', proposal_type: type } })) }
let server, browser, baseUrl
before(async () => {
  server = await preview({ configFile: false, preview: { host: '127.0.0.1', port: 0 } })
  baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE })
  await mkdir('/tmp/evolution-inbox-shots', { recursive: true })
})
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.httpServer.close(resolve)) })
for (const [locale, theme, width] of [['en', 'dark', 1280], ['zh-CN', 'light', 390]]) {
  test(`durable decision stays pending in both parent tabs and refreshes the receipt (${locale}/${theme})`, async () => {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block' })
    await context.addInitScript(({locale, theme}) => { localStorage.setItem('rainver:locale', locale); localStorage.setItem('rainver:theme', theme) }, {locale, theme})
    const page = await context.newPage(), errors = []
    page.on('pageerror', error => errors.push(error.message))
    let state = 'pending', decisions = 0
    await page.route('**/api/v1/**', async route => {
      const path = new URL(route.request().url()).pathname.replace('/api/v1', '')
      let data
      if (path === '/me') data = { id: 'owner', name: 'Bundle owner', email: 'owner@test.invalid', default_space_id: space, instance_role: 'admin', is_instance_admin: true }
      else if (path === '/me/spaces') data = [{ id: space, name: 'Review Space', type: 'personal', role: 'owner' }]
      else if (path === '/plugins/effective') data = { plugins: {} }
      else if (path === '/evolution/bundles') data = [bundle]
      else if (path === `/evolution/bundles/${bundle.id}/decide`) { decisions++; data = { ...bundle, decision: { id: 'intent', status: state, job_id: 'job', error: null, member_ids: ['proposal-0'] } } }
      else if (path === `/evolution/bundles/${bundle.id}`) data = { ...bundle, decision: { id: 'intent', status: state, job_id: 'job', error: null, member_ids: ['proposal-0'] } }
      else if (path === '/evolution/signals' || path === '/evolution/proposals' || path === '/evolution/assets') data = []
      else if (path === '/me/agent-attention/snapshot') data = { type: 'attention.snapshot', seq: 1, version: 'bundle', unread_count: 0, page: { items: [], total: 0, limit: 100, offset: 0 }, notices: [] }
      else if (path === '/me/agent-attention/stream') return route.fulfill({ status: 503, body: '' })
      else if (path === '/projects' || path === '/rooms/pending-approvals') data = { items: [], total: 0, limit: 100, offset: 0 }
      else return route.fulfill({ status: 404, json: { detail: 'Unavailable in this visual fixture' } })
      return route.fulfill({ status: path.endsWith('/decide') ? 202 : 200, json: data })
    })
    try {
      await page.goto(`${baseUrl}/evolution/inbox`)
      await page.getByRole('tab', { name: locale === 'en' ? /Bundles/ : /批次/ }).click()
      await page.getByRole('button', { name: /Reviewed changes/ }).click()
      const pending = locale === 'en' ? 'Decision queued; members remain pending.' : '决定已排队，成员仍待处理。'
      await page.getByText(pending).waitFor()
      const approve = page.getByRole('button', { name: locale === 'en' ? 'Approve' : '批准', exact: true })
      assert.equal(await approve.count(), 2)
      for (const button of await approve.all()) assert.equal(await button.isDisabled(), true)
      await page.screenshot({ path: `/tmp/evolution-inbox-shots/${locale}-pending.png`, fullPage: true })
      await page.getByRole('tab', { name: locale === 'en' ? /Approval/ : /批准/ }).click()
      await page.getByText(pending).waitFor()
      state = 'compensation_failed'
      await page.getByRole('button', { name: locale === 'en' ? 'Refresh decision' : '刷新决定', exact: true }).click()
      await page.getByText(locale === 'en' ? 'Restoration needs attention. The bundle was not approved as a whole.' : '恢复需要处理，整批并未获批完成。').waitFor()
      await page.screenshot({ path: `/tmp/evolution-inbox-shots/${locale}-compensation.png`, fullPage: true })
      assert.equal(decisions, 0)
      assert.deepEqual(errors, [])
    } finally { await context.close() }
  })
}
