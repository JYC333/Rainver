import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { after, before, test } from 'node:test'
import { chromium } from 'playwright-core'
import { preview } from 'vite'
import { run, turn } from '../modules/agent_work/fixtures.test-support.ts'

// ADR 0030 owner-operable loop on the built app with synthetic APIs: the data
// owner (a Space member, not its owner) decides a sensitive plugin-data request
// from the Room conversation's Run controls, then sees content-free reads and
// revokes the Run's access on Run detail. A Space owner viewing the same
// request gets no decision controls.
const space = 'space-pd', now = '2026-11-16T09:00:00Z', member = 'user-member', owner = 'user-owner'
const shots = process.env.PLUGIN_DATA_SHOTS ?? '/tmp/rainver-plugin-data-shots'
const project = { id: 'project-pd', space_id: space, name: 'Weekly review', status: 'active', current_user_can_read: true, current_user_can_write: true, owner_user_id: owner }
const room = { id: 'room-pd', space_id: space, project_id: project.id, project_folder_id: null, title: 'Mainline', status: 'active', created_by_user_id: owner, created_at: now, updated_at: now }
const session = { id: 'session-pd', room_id: room.id, space_id: space, project_id: project.id, title: 'Summarise my week', status: 'active', created_at: now, updated_at: now }
const agent = { id: 'agent-pd', space_id: space, name: 'Weekly assistant', status: 'active', agent_kind: 'custom', description: '', model: null }
const waiting = run({ id: 'run-pd', space_id: space, agent_id: agent.id, session_id: session.id, run_type: 'conversation', status: 'waiting_for_review', owner_user_id: member, instructed_by_user_id: member, ended_at: null,
  error_message: 'Agent authorization request is pending review.', error_json: { error_code: 'authorization_request_pending', authorization_request_id: 'auth-pd' } })
const request = { id: 'auth-pd', space_id: space, run_id: waiting.id, agent_id: agent.id, instructed_by_user_id: member, policy_decision_record_id: 'pdr-pd', action_id: 'plugin.journal.entry.list', policy_action: 'plugin.journal.entry.list',
  project_id: project.id, resource_kind: 'plugin.journal', resource_id: space, reason: 'Read this week’s journal entries to draft the summary', status: 'pending', resulting_action_grant_id: null, decided_by_user_id: null,
  requested_at: now, decided_at: null, request_kind: 'plugin_data', approver: 'data_owner', resulting_plugin_data_grant_id: null }
const messages = [
  { id: 'question', session_id: session.id, space_id: space, role: 'user', sender_user_id: member, sender_agent_id: null, run_id: null, content: 'Summarise my week from my journal.', metadata_json: { run_ids: [waiting.id] }, created_at: now },
  { id: 'reply', session_id: session.id, space_id: space, role: 'assistant', sender_user_id: null, sender_agent_id: agent.id, run_id: waiting.id, content: '', metadata_json: {}, created_at: now },
]
const grant = { id: 'grant-pd', space_id: space, plugin_id: 'journal', toolset: 'read', data_class: 'sensitive', scope: 'run', data_owner_user_id: member, granted_by_user_id: member, target_run_id: waiting.id,
  plugin_version: '1.0.0', authority_hash: 'h', expanded: [], status: 'active', expires_at: '2026-11-16T10:00:00Z', revoked_at: null, created_at: now, reconsent: null }
const reads = [
  { id: 'read-1', run_id: waiting.id, agent_id: agent.id, action_id: 'plugin.journal.entry.list', resource_type: 'plugin.journal', resource_ids: ['e1', 'e2', 'e3'], data_class: 'sensitive', grant_id: grant.id, accessed_at: '2026-11-16T09:05:00Z' },
  { id: 'read-2', run_id: waiting.id, agent_id: agent.id, action_id: 'plugin.journal.tag.list', resource_type: 'plugin.journal', resource_ids: ['t1'], data_class: 'non_sensitive', grant_id: null, accessed_at: '2026-11-16T09:04:00Z' },
]
const pageOf = items => ({ items, total: items.length, limit: 100, offset: 0 })

async function fixtures(page, viewer, state) {
  const role = viewer === owner ? 'owner' : 'member'
  await page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname.replace('/api/v1', '')
    let data
    if (route.request().method() !== 'GET') state.writes.push(path)
    if (path === '/me') data = { id: viewer, name: viewer === owner ? 'Space owner' : 'Data owner', email: `${viewer}@example.test`, default_space_id: space, instance_role: 'user', is_instance_admin: false }
    else if (path === '/me/spaces') data = [{ id: space, name: 'Family', type: 'team', role }]
    else if (path === '/plugins/effective') data = { plugins: {} }
    else if (path === '/projects') data = pageOf([project])
    else if (path === `/projects/${project.id}`) data = project
    else if (path === `/projects/${project.id}/overview`) data = { project, brief: null, attention: [] }
    else if (path === '/rooms') data = pageOf([room])
    else if (path === '/rooms/pending-approvals') data = pageOf([])
    else if (path === `/rooms/${room.id}`) data = { room, viewer_can_write: true, other_member_names: [], agent_count: 1, agent_members: [{ agent_id: agent.id, agent_name: agent.name, status: 'active' }], user_members: [] }
    else if (path === `/rooms/${room.id}/conversations`) data = pageOf([session])
    else if (path === `/rooms/${room.id}/agent-candidates`) data = { agents: [], presets: [], total: 0, limit: 100, offset: 0 }
    else if (path === `/rooms/${room.id}/invitations`) data = pageOf([])
    else if (path.endsWith('/messages')) data = { ...pageOf(messages), conversation: session, queued: [] }
    else if (path === `/sessions/${session.id}`) data = session
    else if (path === `/sessions/${session.id}/workspace-changes`) data = { items: [], next_cursor: null }
    else if (path === `/sessions/${session.id}/execution-context`) data = { summary: { session_id: session.id, state: 'initialized', host: null, runtime: null, runtimes: [], primary: null, attachments: [], dispatch_locked: false, queue_paused_at: null, can_send: true, blocked_reason: null }, available_hosts: [], available_runtime_profiles: [], available_primary_locations: [] }
    else if (path === `/runtime-context/room-conversations/${session.id}/retrieval`) data = { work_context_scope_id: null, enabled: false, preferred_domains: [], setup_version: null }
    else if (path === '/personal-memory-grants') data = []
    else if (path === '/agents') data = [agent]
    else if (path === `/agents/${agent.id}`) data = agent
    else if (path.endsWith('/members')) data = [{ agent_id: agent.id, agent_name: agent.name, status: 'active' }]
    else if (path.endsWith('/quota')) data = { warn_pct: 80, logins: [], holds: [] }
    else if (path === `/runs/${waiting.id}` || path === `/runs/${waiting.id}/status`) data = state.run
    else if (path === `/runs/${waiting.id}/turn`) data = turn({ run_id: waiting.id, state: 'error', source: 'host_thread_events', parts: [] })
    else if (path === `/runs/${waiting.id}/turn/stream`) return route.fulfill({ headers: { 'content-type': 'text/event-stream' }, body: `event: turn.snapshot\ndata: ${JSON.stringify({ type: 'turn.snapshot', turn: turn({ run_id: waiting.id, state: 'error', source: 'host_thread_events', parts: [] }) })}\n\n` })
    else if (path === `/runs/${waiting.id}/live-input`) data = { available: false, binding_id: null }
    else if (path === `/runs/${waiting.id}/authorization-requests`) data = state.requests
    else if (path === `/runs/${waiting.id}/attempts`) data = { attempts: [], supervisor_decisions: [] }
    else if (path === `/runs/${waiting.id}/io`) data = { schema_version: 'run_io.v1', run_id: waiting.id, input: {}, output: null, events: [], artifact_refs: [] }
    else if (/\/runs\/[^/]+\/(evaluations|verifications|finalizations)$/.test(path)) data = []
    else if (/\/runs\/[^/]+\/(activities|artifacts|proposals)$/.test(path)) data = pageOf([])
    else if (path === '/authorization-requests/auth-pd/approve' || path === '/actions/policy.authorization_request.approve') {
      state.approved = true; state.requests = [{ ...request, status: 'approved', decided_by_user_id: viewer, resulting_plugin_data_grant_id: grant.id }]; state.run = { ...waiting, status: 'running', error_json: null, error_message: null }
      data = path.startsWith('/actions') ? { status: 'succeeded', data: { request_id: request.id, space_id: space, run_id: waiting.id, status: 'approved', resulting_action_grant_id: null, resulting_plugin_data_grant_id: grant.id } } : state.requests[0]
    }
    else if (path === '/queries/agent_data_read.list') data = { status: 'succeeded', data: { items: state.approved ? reads : [], has_more: false } }
    else if (path === '/queries/plugin_data_grant.list') data = { status: 'succeeded', data: { items: state.approved ? [state.grant] : [] } }
    else if (path === '/actions/plugin_data_grant.revoke') { state.grant = { ...state.grant, status: 'revoked', revoked_at: '2026-11-16T09:30:00Z' }; data = { status: 'succeeded', data: state.grant } }
    else if (path === '/actions/plugin_data_grant.revoke_run') { state.grant = { ...state.grant, status: 'revoked', revoked_at: '2026-11-16T09:30:00Z' }; data = { status: 'succeeded', data: { run_id: waiting.id, revoked_grant_ids: [grant.id] } } }
    else if (path === '/hosts') data = { items: [] }
    else if (path === '/hosts/runtime-definitions') data = { items: [] }
    else if (path === '/hosts/execution-targets') data = { targets: [] }
    else if (path === '/acp-agents' || path === '/acp-agents/registry') data = { items: [] }
    else if (path === '/me/agent-attention/snapshot') data = { type: 'attention.snapshot', seq: 1, version: 'pd', unread_count: 0, page: { items: [], total: 0, limit: 100, offset: 0 }, notices: [] }
    else if (path === '/me/agent-attention/stream') return route.fulfill({ status: 503, body: '' })
    else return route.fulfill({ status: 404, json: { detail: `Unavailable in plugin data fixture: ${path}` } })
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
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  assert.deepEqual(await page.getByText('Unavailable in plugin data fixture:', { exact: false }).allTextContents(), [], 'No fixture API errors on the visible surface')
  const size = await page.evaluate(() => ({ width: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }))
  assert.ok(size.content <= size.width + 1, JSON.stringify(size))
  await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true })
}
async function open(locale, theme, width, viewer) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block' })
  await context.addInitScript(({ locale, theme }) => { localStorage.setItem('rainver:locale', locale); localStorage.setItem('rainver:theme', theme) }, { locale, theme })
  const page = await context.newPage()
  page.setDefaultTimeout(10000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const state = { run: waiting, requests: [request], grant, approved: false, writes: [] }
  await fixtures(page, viewer, state)
  return { context, page, state, errors }
}
const L = { en: { approve: 'Approve authorization', revoke: "Revoke this Run's data access", confirm: 'Revoke', title: 'Plugin data this Run read for you', owner_only: 'Only the person whose data this is may decide this request.' },
  'zh-CN': { approve: '批准授权', revoke: '撤销此 Run 的数据访问', confirm: '撤销', title: '此 Run 代你读取的插件数据', owner_only: '仅数据所有者本人可决定此请求。' } }

for (const locale of ['en', 'zh-CN']) for (const theme of ['dark', 'light']) for (const width of [390, 1280]) {
  test(`data owner decides in the conversation, then reviews and revokes on Run detail: ${locale}/${theme}/${width}`, async () => {
    const { context, page, state, errors } = await open(locale, theme, width, member)
    try {
      await page.goto(`${baseUrl}/spaces/${space}/projects/${project.id}/rooms?room=${room.id}&conversation=${session.id}`)
      if (theme === 'light') await page.evaluate(() => document.documentElement.classList.add('theme-light'))
      const approve = page.getByRole('button', { name: L[locale].approve })
      await approve.waitFor()
      await approve.scrollIntoViewIfNeeded()
      await capture(page, `parent-conversation-${locale}-${theme}-${width}`)
      await approve.click()
      await page.waitForFunction(() => true)
      await page.goto(`${baseUrl}/spaces/${space}/runs/${waiting.id}`)
      if (theme === 'light') await page.evaluate(() => document.documentElement.classList.add('theme-light'))
      const panel = page.getByTestId('run-plugin-data-panel')
      await panel.getByText(L[locale].title).waitFor()
      await panel.scrollIntoViewIfNeeded()
      await capture(page, `run-detail-${locale}-${theme}-${width}`)
      assert.equal(await panel.getByText('e1').count(), 0, 'Resource identifiers are counted, not listed as content')
      await panel.getByRole('button', { name: L[locale].revoke }).click()
      await page.getByRole('button', { name: L[locale].confirm, exact: true }).click()
      await panel.getByRole('button', { name: L[locale].revoke }).waitFor({ state: 'detached' })
      await capture(page, `run-detail-revoked-${locale}-${theme}-${width}`)
      assert.ok(state.approved, 'Approval used the shared authorization command')
      assert.ok(state.writes.includes('/actions/plugin_data_grant.revoke_run'), JSON.stringify(state.writes))
      assert.deepEqual(errors, [], 'No uncaught browser errors')
    } catch (error) {
      await page.screenshot({ path: `${shots}/failure-${locale}-${theme}-${width}.png`, fullPage: true })
      throw error
    } finally { await context.close() }
  })
}

test('a Space owner sees the data owner’s request but cannot decide it', async () => {
  const { context, page, state } = await open('en', 'dark', 1280, owner)
  try {
    await page.goto(`${baseUrl}/spaces/${space}/projects/${project.id}/rooms?room=${room.id}&conversation=${session.id}`)
    await page.getByText(L.en.owner_only).waitFor()
    assert.equal(await page.getByRole('button', { name: L.en.approve }).count(), 0)
    await capture(page, 'parent-conversation-space-owner-en-dark-1280')
    await page.goto(`${baseUrl}/spaces/${space}/runs/${waiting.id}`)
    await page.getByText('Authorization requests').first().waitFor()
    assert.equal(await page.getByTestId('run-plugin-data-panel').count(), 0, 'Another person never sees this Run’s plugin data panel')
    assert.deepEqual(state.writes, [])
  } finally { await context.close() }
})

// A scheduled Run read through the owner's background consent: Run detail lists that consent
// (linked through this Run's reads) and revokes exactly it.
const scheduled = { ...grant, id: 'grant-bg', scope: 'background', target_run_id: null, expires_at: '2026-11-17T09:00:00Z' }
const LB = { en: { badge: 'Your scheduled Runs', stop: 'Stop background reads' }, 'zh-CN': { badge: '你的定时 Run', stop: '停止后台读取' } }
for (const [locale, theme, width] of [['en', 'dark', 1280], ['zh-CN', 'light', 390], ['en', 'light', 390], ['zh-CN', 'dark', 1280]]) {
  test(`owner sees and stops the background consent a scheduled Run used: ${locale}/${theme}/${width}`, async () => {
    const { context, page, state, errors } = await open(locale, theme, width, member)
    state.approved = true; state.grant = scheduled; state.run = { ...waiting, status: 'succeeded', trigger_origin: 'automation', error_json: null, error_message: null }
    try {
      await page.goto(`${baseUrl}/spaces/${space}/runs/${waiting.id}`)
      if (theme === 'light') await page.evaluate(() => document.documentElement.classList.add('theme-light'))
      const panel = page.getByTestId('run-plugin-data-panel')
      await panel.getByText(LB[locale].badge).waitFor()
      await panel.scrollIntoViewIfNeeded()
      await capture(page, `run-detail-background-${locale}-${theme}-${width}`)
      await panel.getByRole('button', { name: LB[locale].stop }).click()
      await panel.getByRole('button', { name: LB[locale].stop }).waitFor({ state: 'detached' })
      await capture(page, `run-detail-background-stopped-${locale}-${theme}-${width}`)
      assert.ok(state.writes.includes('/actions/plugin_data_grant.revoke'), JSON.stringify(state.writes))
      assert.ok(!state.writes.includes('/actions/plugin_data_grant.revoke_run'), 'Only the selected consent is revoked')
      assert.deepEqual(errors, [], 'No uncaught browser errors')
    } catch (error) {
      await page.screenshot({ path: `${shots}/failure-background-${locale}-${theme}-${width}.png`, fullPage: true })
      throw error
    } finally { await context.close() }
  })
}
