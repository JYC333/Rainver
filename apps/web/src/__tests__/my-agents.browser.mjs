import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { after, before, test } from 'node:test'
import { chromium } from 'playwright-core'
import { preview } from 'vite'

// My Agents on the built app with synthetic APIs: reached from the Global
// Rail (desktop) or the More menu (phone), here from Settings; Agents from two Spaces, by Space;
// the Room summary for zero, one and several Rooms (expanded by Project); a
// Room-only entry with no detail; a plugin assistant unavailable in one
// Project; then a managed Agent's detail is stopped through the confirmation
// and shows what stopping keeps, and an Agent the person does not manage
// opens read-only with the reason, keeps its view controls and fits a long name.
// The page is also opened directly and refreshed (cold start, no Space yet):
// its read never carries a browsed Space, which the fixture refuses like a
// stale one, and the Agents scene navigation stays on it. "Show more" after two
// entries traded places across pages re-reads the range and shows each once.
const home = 'space-home', team = 'space-team', me = 'user-me', now = '2026-11-25T09:00:00Z'
const LONG = 'Literature scout for the computational linguistics reading group and its weekly cross-lab review'
const shots = process.env.MY_AGENTS_SHOTS ?? '/tmp/rainver-my-agents-shots'
const room = (room_id, title) => ({ room_id, title, is_mainline: false })
const base = { description: null, status: 'active', access: 'owner', management: 'manage', can_open_detail: true, can_direct_chat: true, plugin_id: null, home_project: null, usable_room_count: 0, locations: [] }
const agents = [
  { ...base, agent_id: 'a-own', space_id: home, space_name: 'Personal', name: 'Writing coach', description: 'Reviews drafts and suggests clearer structure.' },
  { ...base, agent_id: 'a-busy', space_id: team, space_name: 'Lab team', name: 'Literature scout', description: 'Finds and summarizes related work for the group.', access: 'shared', management: 'owner_only', usable_room_count: 3,
    locations: [
      { project_id: 'p-apps', project_name: 'PhD applications', plugin_state: null, rooms: [room('r-drafts', 'Statement drafts'), room('r-review', 'Reviews')] },
      { project_id: 'p-thesis', project_name: 'Thesis', plugin_state: null, rooms: [room('r-writing', 'Writing group')] },
    ] },
  { ...base, agent_id: 'a-room', space_id: team, space_name: 'Lab team', name: 'Advisor helper', access: 'room_only', management: 'room_only', can_open_detail: false, can_direct_chat: false, usable_room_count: 1,
    locations: [{ project_id: 'p-thesis', project_name: 'Thesis', plugin_state: null, rooms: [room('r-weekly', 'Weekly check-in')] }] },
  { ...base, agent_id: 'a-phd', space_id: team, space_name: 'Lab team', name: 'PhD Application Assistant', description: 'Tracks programs, deadlines and materials.', plugin_id: 'phd_application', can_direct_chat: false, usable_room_count: 1,
    home_project: { project_id: 'p-apps', project_name: 'PhD applications', plugin_state: 'ready' },
    locations: [
      { project_id: 'p-apps', project_name: 'PhD applications', plugin_state: 'ready', rooms: [room('r-drafts', 'Statement drafts')] },
      { project_id: 'p-thesis', project_name: 'Thesis', plugin_state: 'unbound', rooms: [room('r-writing', 'Writing group')] },
    ] },
  { ...base, agent_id: 'a-old', space_id: team, space_name: 'Lab team', name: 'Grant reviewer', status: 'disabled', can_direct_chat: false },
]
const detail = (id, patch = {}) => ({ id, space_id: id === 'a-own' ? home : team, project_id: null, created_by_user_id: id === 'a-own' ? me : 'user-other', name: agents.find(a => a.agent_id === id).name,
  description: agents.find(a => a.agent_id === id).description, visibility: 'private', access_level: 'full', role_instruction: null, status: 'active', agent_kind: 'standard',
  current_version_id: `v-${id}`, source_role_id: null, source_role_version_id: null, model: null, runtime_key: 'opencode', system_prompt: 'Be concise and specific.',
  created_at: now, updated_at: now, can_manage: id === 'a-own', ...patch })
const version = id => ({ id: `v-${id}`, agent_id: id, space_id: home, version_label: 'v1', system_prompt: 'Be concise and specific.', prompt_provenance_json: null, risk_level: 'medium', max_run_time_seconds: 300,
  context_policy_json: {}, memory_policy_json: {}, capabilities_json: [], tool_permissions_json: {}, tool_policy_json: {}, output_policy_json: {}, schedule_config_json: {}, output_schema_json: {}, created_at: now })

async function fixtures(page, state, { spaceless = false } = {}) {
  await page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname.replace('/api/v1', ''), method = route.request().method()
    let data
    if (method !== 'GET') state.writes.push(path)
    if (path === '/me') data = { id: me, name: 'Jamie', email: `${me}@example.test`, default_space_id: spaceless ? null : home, instance_role: 'user', is_instance_admin: false }
    else if (path === '/me/spaces' && spaceless) data = []
    else if (path === '/me/agents' && spaceless) data = { items: [], total: 0, limit: 50, offset: 0, revision: 'empty' }
    else if (path === '/me/spaces') data = [{ id: home, name: 'Personal', type: 'personal', role: 'owner' }, { id: team, name: 'Lab team', type: 'team', role: 'member' }]
    else if (path === '/plugins/effective') data = { plugins: {} }
    else if (path === '/queries/plugin_data_grant.list') data = { status: 'succeeded', data: { items: [], consentable: [] } }
    else if (path === '/me/agents') {
      // A browsed Space header on this person-scoped read is refused, as a stale or left Space would be.
      if (route.request().headers()['x-rainver-space-id']) { state.spaceHeaders.push(route.request().headers()['x-rainver-space-id']); return route.fulfill({ status: 403, json: { detail: 'Space access denied' } }) }
      state.queries.push(url.search); data = { items: agents, total: agents.length, limit: 50, offset: 0, revision: 'r1' }
    }
    else if (path === '/me/agent-attention/snapshot') data = { type: 'attention.snapshot', seq: 1, version: 'ma', unread_count: 0, page: { items: [], total: 0, limit: 100, offset: 0 }, notices: [] }
    else if (path === '/me/agent-attention/stream') return route.fulfill({ status: 503, body: '' })
    else if (path === '/actions/agent.update') { state.status = JSON.parse(route.request().postData() ?? '{}').status; data = { status: 'succeeded', data: { agent_id: 'a-own', space_id: home } } }
    else if (/^\/agents\/[^/]+$/.test(path)) { const id = path.split('/')[2]; data = detail(id, id === 'a-own' && state.status ? { status: state.status } : id === 'a-busy' ? { name: LONG } : {}) }
    else if (/^\/agents\/[^/]+\/versions$/.test(path)) data = [version(path.split('/')[2])]
    // A Run on the read-only Agent: its Overview's two cards are laid out with real content at 390px.
    else if (path === '/agents/a-busy/runs') data = [{ id: 'run-busy', agent_id: 'a-busy', space_id: team, status: 'succeeded', created_at: now, started_at: now, ended_at: now }]
    else if (/^\/agents\/[^/]+\/(runs|runtime-profiles|proposals)$/.test(path)) data = []
    else if (path === '/hosts') data = { items: [] }
    else return route.fulfill({ status: 404, json: { detail: `Unavailable in my agents fixture: ${path}` } })
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
  await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running'))
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  assert.deepEqual(await page.getByText('Unavailable in my agents fixture:', { exact: false }).allTextContents(), [], 'No fixture API errors on the visible surface')
  const size = await page.evaluate(() => ({ width: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }))
  assert.ok(size.content <= size.width + 1, JSON.stringify(size))
  await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true })
}
const L = {
  en: { nav: 'Agents', more: 'More', title: 'My agents', many: 'Available in 3 Rooms', none: 'No Room available', one: 'Room: Thesis · Weekly check-in', unbound: 'Thesis: plugin unbound from this Project', details: 'Details', stop: 'Stop', kept: 'history are kept', stopped: 'This agent is stopped', restore: 'Restore', readOnly: 'View only. Only its owner can edit or manage it.', manage: 'Management', manageable: 'I can manage' },
  'zh-CN': { nav: '智能体', more: '更多', title: '我的智能体', many: '可在 3 个房间使用', none: '暂无可用房间', one: '房间：Thesis · Weekly check-in', unbound: 'Thesis：插件已从此项目解绑', details: '详情', stop: '停用', kept: '历史都会保留', stopped: '此智能体已停用', restore: '恢复', readOnly: '仅可查看。只有它的所有者可以编辑和管理。', manage: '管理权限', manageable: '我可管理' },
}

for (const locale of ['en', 'zh-CN']) for (const theme of ['dark', 'light']) for (const width of [390, 1280]) {
  test(`My Agents across Spaces, then stop and read-only detail: ${locale}/${theme}/${width}`, async () => {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block' })
    await context.addInitScript(({ locale, theme }) => { localStorage.setItem('rainver:locale', locale); localStorage.setItem('rainver:theme', theme) }, { locale, theme })
    const page = await context.newPage()
    page.setDefaultTimeout(10000)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    const state = { writes: [], queries: [], status: null, spaceHeaders: [] }
    await fixtures(page, state)
    const light = async () => { if (theme === 'light') await page.evaluate(() => document.documentElement.classList.add('theme-light')) }
    const t = L[locale]
    try {
      // Opened directly, then refreshed: no browsed Space is sent, and the list loads.
      await page.goto(`${baseUrl}/my-agents`)
      await light()
      await page.getByTestId('my-agents-page').getByText('Lab team', { exact: true }).waitFor()
      await page.reload()
      await light()
      await page.getByTestId('my-agents-page').getByText('Lab team', { exact: true }).waitFor()
      assert.deepEqual(state.spaceHeaders, [], 'My Agents never sends a browsed Space')
      // The Agents scene stays: its in-Space areas link through the preferred Space.
      const skills = page.locator('a[href$="/skills"]:visible')
      assert.equal(await skills.count(), 1, 'Agents scene navigation is shown on My Agents')
      assert.equal(await skills.getAttribute('href'), `/spaces/${home}/skills`)
      assert.equal(await page.locator('a[href$="/runs"]:visible').count(), 1)
      await capture(page, `direct-${locale}-${theme}-${width}`)

      await page.goto(`${baseUrl}/settings`)
      await light()
      // The entry in its parent navigation.
      if (width < 768) {
        await page.getByRole('button', { name: t.more }).click()
        await page.getByRole('dialog').getByRole('link', { name: t.nav, exact: true }).click()
      } else {
        await page.getByRole('navigation').getByRole('link', { name: t.nav, exact: true }).click()
      }
      await page.waitForURL(/\/my-agents$/)
      const list = page.getByTestId('my-agents-page')
      await list.getByRole('heading', { name: t.title }).waitFor()
      await list.getByText('Lab team', { exact: true }).waitFor()
      await capture(page, `list-${locale}-${theme}-${width}`)
      const card = name => list.getByTestId('my-agent-card').filter({ hasText: name })
      await card('Writing coach').getByText(t.none).waitFor()
      await card('Advisor helper').getByRole('link', { name: t.one }).waitFor()
      assert.equal(await card('Advisor helper').getByRole('link', { name: t.details }).count(), 0, 'A Room-only entry has no detail')
      await card('PhD Application Assistant').getByText(t.unbound, { exact: false }).waitFor()
      await card('Literature scout').getByRole('button', { name: t.many }).click()
      await card('Literature scout').getByRole('link', { name: 'Writing group' }).waitFor()
      await card('Literature scout').scrollIntoViewIfNeeded()
      await capture(page, `rooms-expanded-${locale}-${theme}-${width}`)
      // A filter is the server's: the next read carries it.
      await list.getByRole('button', { name: t.manage }).click()
      await page.getByRole('option', { name: t.manageable }).click()
      await page.waitForFunction(() => true)
      await list.getByTestId('my-agent-card').first().waitFor()
      assert.ok(state.queries.some(query => query.includes('manage=manageable')), JSON.stringify(state.queries))

      // A managed Agent's detail in its own Space: stop through the confirmation.
      await card('Writing coach').getByRole('link', { name: t.details }).click()
      await page.waitForURL(new RegExp(`/spaces/${home}/agents/a-own$`))
      await page.getByRole('button', { name: t.stop, exact: true }).click()
      const dialog = page.getByRole('dialog')
      await dialog.getByText(t.kept, { exact: false }).waitFor()
      await capture(page, `stop-confirm-${locale}-${theme}-${width}`)
      await dialog.getByRole('button', { name: t.stop, exact: true }).click()
      await page.getByText(t.stopped, { exact: false }).waitFor()
      await page.getByRole('button', { name: t.restore }).waitFor()
      await dialog.waitFor({ state: 'detached' })
      await capture(page, `stopped-${locale}-${theme}-${width}`)
      assert.equal(state.status, 'disabled')

      // An Agent the person does not manage: read-only, with who does.
      await page.goto(`${baseUrl}/spaces/${team}/agents/a-busy`)
      await light()
      await page.getByText(t.readOnly).waitFor()
      assert.equal(await page.getByRole('button', { name: t.stop, exact: true }).count(), 0)
      await page.getByRole('heading', { name: LONG }).waitFor()
      await capture(page, `read-only-${locale}-${theme}-${width}`)
      // View controls stay usable; only writes are disabled.
      await page.getByRole('tab', { name: 'Versions' }).click()
      await page.getByRole('button', { name: 'View config' }).click()
      await page.getByText('"system_prompt": "Be concise and specific."').waitFor()
      await page.getByRole('tab', { name: 'Overview' }).click()
      assert.equal(await page.getByRole('button', { name: 'Edit', exact: true }).isDisabled(), true)
      assert.deepEqual(state.writes, ['/actions/agent.update'])
      assert.deepEqual(errors, [], 'No uncaught browser errors')
    } catch (error) {
      await page.screenshot({ path: `${shots}/failure-${locale}-${theme}-${width}.png`, fullPage: true })
      throw error
    } finally { await context.close() }
  })
}

// A signed-in person with no active Space: the page answers empty, and nothing in it or in its
// navigation is a link into a Space it cannot reach (it would land on Home).
for (const width of [390, 1280]) {
  test(`My Agents with no active Space: ${width}`, async () => {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' })
    await context.addInitScript(() => { localStorage.setItem('rainver:locale', 'en') })
    const page = await context.newPage()
    page.setDefaultTimeout(10000)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    const state = { writes: [], queries: [], status: null, spaceHeaders: [] }
    await fixtures(page, state, { spaceless: true })
    try {
      await page.goto(`${baseUrl}/my-agents`)
      const list = page.getByTestId('my-agents-page')
      await list.getByRole('heading', { name: 'My agents' }).waitFor()
      await list.getByText('No agents', { exact: false }).waitFor()
      assert.equal(await list.getByRole('link', { name: 'New agent' }).count(), 0)
      assert.equal(await list.locator('[aria-disabled="true"]', { hasText: 'New agent' }).count(), 1)
      // Scene and global navigation: no unscoped in-Space href anywhere on the page.
      const hrefs = await page.locator('a[href]').evaluateAll(links => links.map(link => link.getAttribute('href')))
      const userScoped = ['/home', '/agent-work', '/my-agents', '/settings', '/instance-settings', '/time', '/cards', '/evolution', '/login']
      const dead = hrefs.filter(href => href.startsWith('/') && !href.startsWith('/spaces/') && !userScoped.some(p => href === p || href.startsWith(`${p}/`) || href.startsWith(`${p}?`)))
      assert.deepEqual(dead, [], 'No link into a Space that does not exist')
      const inert = page.locator('[aria-disabled="true"]:visible', { hasText: width < 768 ? 'Skills' : 'Skills' })
      assert.ok(await inert.count() >= 1, 'The Agents scene keeps its in-Space areas visible but inert')
      await capture(page, `spaceless-${width}`)
      assert.ok(page.url().endsWith('/my-agents'))
      assert.deepEqual(errors, [], 'No uncaught browser errors')
    } catch (error) {
      await page.screenshot({ path: `${shots}/failure-spaceless-${width}.png`, fullPage: true })
      throw error
    } finally { await context.close() }
  })
}

// "Show more" after two entries traded places across the page boundary (the boundary entries stay
// put): the next page carries another revision, so the shown range and the new page are read
// again and the list shows every entry once, in the server's order.
for (const width of [390, 1280]) {
  test(`My Agents "Show more" re-reads a list that moved across pages: ${width}`, async () => {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' })
    await context.addInitScript(() => { localStorage.setItem('rainver:locale', 'en') })
    const page = await context.newPage()
    page.setDefaultTimeout(10000)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    const state = { writes: [], queries: [], status: null, spaceHeaders: [] }
    await fixtures(page, state)
    let list = Array.from({ length: 70 }, (_, i) => ({ ...base, agent_id: `h${i}`, space_id: home, space_name: 'Personal', name: `Helper ${String(i).padStart(2, '0')}` }))
    const reads = []
    // Registered last, so it answers My Agents reads before the shared fixture.
    await page.route(url => url.pathname === '/api/v1/me/agents', route => {
      const url = new URL(route.request().url()), limit = Number(url.searchParams.get('limit')), offset = Number(url.searchParams.get('offset'))
      reads.push([limit, offset])
      return route.fulfill({ json: { items: list.slice(offset, offset + limit), total: list.length, limit, offset, revision: list.map(item => `${item.agent_id}:${item.name}`).join('|') } })
    })
    try {
      await page.goto(`${baseUrl}/my-agents`)
      const shown = page.getByTestId('my-agent-card')
      await page.getByText('Helper 49', { exact: true }).waitFor()
      assert.equal(await shown.count(), 50)
      const next = [...list]
      next[10] = { ...list[60], name: 'Helper 60 renamed' }
      next[60] = { ...list[10], name: 'Helper 10 renamed' }
      list = next
      await page.getByRole('button', { name: 'Show more' }).click()
      await page.getByText('Helper 69', { exact: true }).waitFor()
      assert.deepEqual(reads.slice(-2), [[50, 50], [100, 0]])
      const names = await shown.evaluateAll(cards => cards.map(card => card.querySelector('p > span')?.textContent))
      assert.deepEqual(names, list.map(item => item.name))
      assert.equal(await page.getByText('Helper 10', { exact: true }).count(), 0)
      assert.equal(await page.getByRole('button', { name: 'Show more' }).count(), 0)
      await capture(page, `show-more-moved-${width}`)
      assert.deepEqual(errors, [], 'No uncaught browser errors')
    } catch (error) {
      await page.screenshot({ path: `${shots}/failure-show-more-moved-${width}.png`, fullPage: true })
      throw error
    } finally { await context.close() }
  })
}
