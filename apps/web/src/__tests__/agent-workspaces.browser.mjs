import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { after, before, test } from 'node:test'
import { chromium } from 'playwright-core'
import { preview } from 'vite'
import { run } from '../modules/agent_work/fixtures.test-support.ts'

// Built app, synthetic APIs: one request with an explicit delegation shows a
// single collapsed workspace summary under the main Agent's final reply even
// when the announcing request is on an earlier page (the child's server
// delegation record groups it), the conversation's other unfinished work stays
// reachable across pending pages, and Files & Code opens the paged Agent
// workspace overview and returns.
const space = 'space-aw', now = '2026-11-09T09:00:00Z', user = 'user-aw'
const shots = process.env.AGENT_WORKSPACE_SHOTS ?? '/tmp/rainver-agent-workspace-shots'
const project = { id: 'project-aw', space_id: space, name: 'Login service', status: 'active', current_user_can_read: true, current_user_can_write: true, owner_user_id: user }
const room = { id: 'room-aw', space_id: space, project_id: project.id, project_folder_id: null, title: 'Mainline', status: 'active', is_mainline: true, created_by_user_id: user, created_at: now, updated_at: now }
const session = { id: 'session-aw', room_id: room.id, space_id: space, project_id: project.id, title: 'Refactor the login flow', status: 'active', created_at: now, updated_at: now }
const manager = { id: 'agent-manager', space_id: space, name: 'Lead engineer', status: 'active', agent_kind: 'custom', description: '', model: null }
const helper = { id: 'agent-helper', space_id: space, name: 'Test writer', status: 'active', agent_kind: 'custom', description: '', model: null }
const folder = { id: 'folder-aw', space_id: space, project_id: project.id, name: 'login-service', kind: 'code', status: 'active', protected: false, system_managed: false, created_at: now, updated_at: now, snapshot_retention_days: null, snapshot_max_count: null }
const base = { generation: 1, revision: 3, workspace_location_id: 'location-aw', summary: null, base_commit: 'a'.repeat(40), source_commit: 'b'.repeat(40), workspace_state: 'ready', baseline_mode: 'committed', cleanup_state: 'cleaned', cleanup_errors: [], can_manage: true, integration_id: null, integration_revision: null, integration_status: null, attempt_id: null, onto_commit: null, candidate_commit: null, merged_commit: 'c'.repeat(40), integration_detail: null, native_integration: true }
const reclaimed = { state: 'grace', reason: 'merged', reclaim_after: '2026-11-09T10:00:00Z', hold_until: null, reclaimed_at: null, assessed_at: now, retained_refs: 0, unclaimed_refs: 3 }
const parentChange = { ...base, change_set_id: 'change-parent', workspace_id: 'ws-parent', parent_workspace_id: null, target_ref: 'refs/heads/dev', state: 'integrated', landing: 'target', summary: 'Split the login handler and kept the session API unchanged.', retention: reclaimed }
const childChange = { ...base, change_set_id: 'change-child', workspace_id: 'ws-child', parent_workspace_id: 'ws-parent', target_ref: 'refs/heads/rainver/workspace-ws-parent-g1', state: 'integrated', landing: 'parent', summary: 'Added regression tests for expired sessions.' }
const retainedChange = { ...base, change_set_id: 'change-old', workspace_id: 'ws-old', parent_workspace_id: null, target_ref: 'refs/heads/dev', state: 'blocked', workspace_state: 'ready', source_commit: 'd'.repeat(40), merged_commit: null, integration_id: 'merge-old', integration_revision: 4, integration_status: 'conflict', integration_detail: { error: 'integration_requires_semantic_decision', conflicted_files: ['src/session.ts'] }, cleanup_state: 'pending', summary: 'Earlier cookie migration.' }
const parent = run({ id: 'run-parent', space_id: space, agent_id: manager.id, session_id: session.id, run_type: 'conversation', status: 'succeeded', owner_user_id: user, instructed_by_user_id: user, contract_snapshot_json: { execution_workspace_version: 1 }, workspace_changes: [parentChange] })
const child = run({ id: 'run-child', space_id: space, agent_id: helper.id, session_id: session.id, parent_run_id: parent.id, delegation_id: 'delegation-aw', run_type: 'conversation', status: 'succeeded', owner_user_id: user, instructed_by_user_id: user, contract_snapshot_json: { execution_workspace_version: 1, workspace_access: 'write' }, workspace_changes: [childChange] })
const runs = { [parent.id]: parent, [child.id]: child }
// The request that announced the delegation (run_ids + delegated_run_ids) is on
// an earlier, unloaded page: only the two replies are on this one.
const messages = [
  { id: 'child-reply', session_id: session.id, space_id: space, role: 'assistant', user_id: null, sender_agent_id: helper.id, run_id: child.id, content: 'Tests for expired sessions are in place.', metadata_json: {}, created_at: '2026-11-09T09:05:00Z' },
  { id: 'final', session_id: session.id, space_id: space, role: 'assistant', user_id: null, sender_agent_id: manager.id, run_id: parent.id, content: 'The login flow is refactored, the new tests pass, and the change is merged into dev.', metadata_json: {}, created_at: '2026-11-09T09:10:00Z' },
]
const laterChange = { ...retainedChange, change_set_id: 'change-later', workspace_id: 'ws-later', integration_id: 'merge-later', summary: 'Retained password reset work.' }
const listItem = (o) => ({ generation: 1, owner_kind: 'conversation', folder: { id: folder.id, name: folder.name }, host: { name: 'Desk workstation', online: true }, conversation: { id: session.id, title: session.title, room_id: room.id }, task: null, agent: { id: manager.id, name: manager.name }, batch_count: 1, retention: null, created_at: now, activity_at: now, ...o })
const current = [
  listItem({ workspace_id: 'ws-old', work_state: 'attention', run: { id: 'run-old', status: 'failed' }, conversation: { id: session.id, title: 'Cookie migration', room_id: room.id }, batch_count: 2 }),
  listItem({ workspace_id: 'ws-running', work_state: 'running', owner_kind: 'delegation', agent: { id: helper.id, name: helper.name }, run: { id: 'run-live', status: 'running' }, host: { name: 'Build box', online: false } }),
]
const history = [listItem({ workspace_id: 'ws-parent', work_state: 'merged', run: { id: parent.id, status: 'succeeded' }, retention: reclaimed })]
const pageOf = items => ({ items, total: items.length, limit: 100, offset: 0 })

async function fixtures(page, seen) {
  await page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname.replace('/api/v1', '')
    if (route.request().method() !== 'GET') seen.writes.push(path)
    let data
    if (path === '/me') data = { id: user, name: 'Workspace tester', email: 'aw@example.test', default_space_id: space, instance_role: 'admin', is_instance_admin: true }
    else if (path === '/me/spaces') data = [{ id: space, name: 'Workspace Space', type: 'personal', role: 'owner' }]
    else if (path === '/plugins/effective') data = { plugins: {} }
    else if (path === '/projects') data = pageOf([project])
    else if (path === `/projects/${project.id}`) data = project
    else if (path === `/projects/${project.id}/overview`) data = { project, brief: null, attention: [] }
    else if (path === `/projects/${project.id}/mainline-room`) data = { room, viewer_can_write: true, other_member_names: [], agent_count: 1, agent_members: [{ agent_id: manager.id, agent_name: manager.name, role: 'manager', status: 'active' }], user_members: [] }
    else if (path === `/projects/${project.id}/folders`) data = pageOf([folder])
    else if (path === `/projects/${project.id}/folders/${folder.id}/locations`) data = [{ id: 'location-aw', project_folder_id: folder.id, execution_host_id: 'desk', execution_host_kind: 'remote', host_name: 'Desk workstation', display_path: '~/src/login-service', root_path: null, status: 'active', execution_ready: true, host_online: true }]
    else if (path === `/projects/${project.id}/folders/${folder.id}/tree`) data = { name: folder.name, path: '', type: 'dir', children: [{ name: 'README.md', path: 'README.md', type: 'file' }, { name: 'src', path: 'src', type: 'dir', children: [] }] }
    else if (path === `/projects/${project.id}/folders/${folder.id}/git/status`) data = { is_repo: true, branch: 'dev', files: [], truncated: false }
    else if (path === `/projects/${project.id}/agent-workspaces`) {
      const view = url.searchParams.get('view'), cursor = url.searchParams.get('cursor'); seen.views.push(cursor ? `${view}+` : view)
      data = view === 'history' ? { items: history, next_cursor: null } : cursor === 'c2' ? { items: current.slice(1), next_cursor: null } : { items: current.slice(0, 1), next_cursor: 'c2' }
    }
    else if (path === `/projects/${project.id}/agent-workspaces/ws-old`) data = { workspace_id: 'ws-old', items: [{ change: retainedChange, run: { id: 'run-old', status: 'failed', agent_id: manager.id } }] }
    else if (path === '/rooms') data = pageOf([room])
    else if (path === '/rooms/pending-approvals') data = pageOf([])
    else if (path === `/rooms/${room.id}`) data = { room, viewer_can_write: true, other_member_names: [], agent_count: 2, agent_members: [{ agent_id: manager.id, agent_name: manager.name, role: 'manager', status: 'active' }, { agent_id: helper.id, agent_name: helper.name, role: 'specialist', status: 'active' }], user_members: [] }
    else if (path === `/rooms/${room.id}/conversations`) data = pageOf([session])
    else if (path === `/rooms/${room.id}/agent-candidates`) data = { agents: [], presets: [], total: 0, limit: 100, offset: 0 }
    else if (path === `/rooms/${room.id}/invitations`) data = pageOf([])
    else if (path.endsWith('/messages')) data = { ...pageOf(messages), queued: [] }
    else if (path === `/sessions/${session.id}`) data = session
    else if (path === `/sessions/${session.id}/workspace-changes`) data = url.searchParams.get('cursor') === 'p2'
      ? { items: [{ change: laterChange, run: { id: 'run-later', status: 'failed', agent_id: manager.id } }], next_cursor: null }
      : { items: [
        { change: parentChange, run: { id: parent.id, status: 'succeeded', agent_id: manager.id } },
        { change: retainedChange, run: { id: 'run-old', status: 'failed', agent_id: manager.id } },
      ], next_cursor: 'p2' }
    else if (path === `/sessions/${session.id}/execution-context`) data = { summary: { session_id: session.id, state: 'initialized', host: null, runtime: null, runtimes: [], primary: null, attachments: [], dispatch_locked: false, queue_paused_at: null, can_send: true, blocked_reason: null }, available_hosts: [], available_runtime_profiles: [], available_primary_locations: [] }
    else if (path === `/runtime-context/room-conversations/${session.id}/retrieval`) data = { work_context_scope_id: null, enabled: false, preferred_domains: [], setup_version: null }
    else if (path === '/personal-memory-grants') data = []
    else if (path === '/agents') data = [manager, helper]
    else if (path === '/agents/system-assistant') data = { assistant: null }
    else if (path.endsWith('/conversation-backends')) data = { options: [], binding: null }
    else if (path.endsWith('/members')) data = [{ agent_id: manager.id, agent_name: manager.name, status: 'active' }]
    else if (path.endsWith('/quota')) data = { warn_pct: 80, logins: [], holds: [] }
    else if (runs[path.replace('/runs/', '')]) data = runs[path.replace('/runs/', '')]
    else if (/^\/runs\/[^/]+\/turn$/.test(path)) { const id = path.split('/')[2]; data = { schema_version: 'run_turn.v1', source: 'run_events', cursor: 1, updated_at: now, run_id: id, state: 'done', blocked_on: null, parts: [{ type: 'tool_call', index: 0, name: 'edit_file', status: 'succeeded', input_summary: 'src/login.ts' }, { type: 'text', index: 1, text: messages.find(m => m.run_id === id)?.content ?? '' }] } }
    else if (/\/runs\/[^/]+\/(evaluations|verifications|finalizations|authorization-requests)$/.test(path)) data = []
    else if (/\/runs\/[^/]+\/(activities|artifacts|proposals)$/.test(path)) data = pageOf([])
    else if (/\/runs\/[^/]+\/live-input$/.test(path)) data = { available: false, binding_id: null }
    else if (path === '/hosts') data = { items: [] }
    else if (path === '/hosts/runtime-definitions') data = { items: [] }
    else if (path === '/hosts/execution-targets' || path.endsWith('/host-execution-targets')) data = { targets: [] }
    else if (path === '/acp-agents' || path === '/acp-agents/registry') data = { items: [] }
    else if (path === '/me/agent-attention/snapshot') data = { type: 'attention.snapshot', seq: 1, version: 'aw', unread_count: 0, page: { items: [], total: 0, limit: 100, offset: 0 }, notices: [] }
    else if (path === '/me/agent-attention/stream') return route.fulfill({ status: 503, body: '' })
    else return route.fulfill({ status: 404, json: { detail: `Unavailable in agent workspace fixture: ${path}` } })
    return route.fulfill({ json: data })
  })
}

let server, browser, baseUrl = process.env.LAYOUT_BASE_URL
before(async () => { await mkdir(shots, { recursive: true }); if (!baseUrl) { server = await preview({ configFile: false, preview: { host: '127.0.0.1', port: 0 } }); baseUrl = `http://127.0.0.1:${server.httpServer.address().port}` } browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE }) })
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.httpServer.close(resolve)) })
async function settle(page) { await page.evaluate(() => document.getAnimations().filter(a => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity).forEach(a => a.finish())); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))) }
async function capture(page, name, full = true) { await settle(page); const size = await page.evaluate(() => ({ width: document.documentElement.clientWidth, content: document.documentElement.scrollWidth })); assert.ok(size.content <= size.width + 1, `${name}: ${JSON.stringify(size)}`); await page.screenshot({ path: `${shots}/${name}.png`, fullPage: full }) }
async function open(locale, theme, width) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' })
  await context.addInitScript(locale => localStorage.setItem('rainver:locale', locale), locale)
  const page = await context.newPage(), seen = { writes: [], views: [], errors: [] }
  page.setDefaultTimeout(10000); page.on('pageerror', e => seen.errors.push(e.message))
  await fixtures(page, seen)
  return { context, page, seen, light: async () => { if (theme === 'light') await page.evaluate(() => document.documentElement.classList.add('theme-light')) } }
}
const L = (locale, en, zh) => locale === 'en' ? en : zh

for (const locale of ['en', 'zh-CN']) for (const theme of ['dark', 'light']) for (const width of [390, 1280]) {
  const tag = `${locale}-${theme}-${width}`
  test(`one collapsed summary per delegated request and reachable pending work: ${tag}`, async () => {
    const { context, page, seen, light } = await open(locale, theme, width)
    try {
      await page.goto(`${baseUrl}/spaces/${space}/projects/${project.id}/rooms?room=${room.id}&conversation=${session.id}`); await light()
      const summary = page.getByTestId('turn-workspace-summary')
      await summary.first().waitFor()
      assert.equal(await summary.count(), 1, 'one summary for the request and its delegation')
      // It sits under the main Agent's final reply, after the folded child result.
      const order = await page.evaluate(() => { const nodes = [...document.querySelectorAll('[data-role="agent"], [data-testid="turn-workspace-summary"]')]; return nodes.map(n => n.dataset.testid ?? n.textContent?.slice(0, 40)) })
      assert.equal(order.at(-1), 'turn-workspace-summary', JSON.stringify(order))
      assert.equal(await summary.evaluate(e => e.open), false)
      const line = await summary.locator('summary').first().innerText()
      assert.match(line, L(locale, /Merged into dev[\s\S]*Adopted by parent/, /已合入 dev[\s\S]*已被父级采用/))
      const pending = page.getByTestId('conversation-pending-work')
      assert.match(await pending.locator('summary').first().innerText(), L(locale, /1\+ unfinished workspace change/, /1\+ 项未完成/))
      await page.getByText(messages[1].content).first().evaluate(e => e.scrollIntoView({ block: 'center' }))
      await capture(page, `group-entry-${tag}`, false)
      await summary.locator('summary').first().click()
      assert.equal(await summary.getByTestId(/^workspace-change-/).count(), 2)
      assert.equal(await summary.getByRole('link', { name: L(locale, 'Run details', '运行详情'), exact: true }).count(), 2)
      await summary.evaluate(e => e.scrollIntoView({ block: 'start' }))
      await capture(page, `group-expanded-${tag}`, false)
      await pending.locator('summary').first().click()
      await pending.getByRole('button', { name: L(locale, 'Check whether already integrated', '核对是否已合入'), exact: true }).first().waitFor()
      await pending.getByRole('button', { name: L(locale, 'Load more', '加载更多'), exact: true }).click()
      await pending.getByTestId('workspace-change-change-later').waitFor()
      assert.match(await pending.locator('summary').first().innerText(), L(locale, /2 unfinished workspace changes/, /2 项未完成/))
      await pending.evaluate(e => e.scrollIntoView({ block: 'center' }))
      await capture(page, `pending-expanded-${tag}`, false)
      await summary.getByRole('link', { name: L(locale, 'All Agent workspaces', '全部 Agent 工作区'), exact: true }).click()
      await page.waitForURL(`**/projects/${project.id}/files/workspaces`)
      await page.getByRole('heading', { name: L(locale, 'Agent workspaces', 'Agent 工作区'), exact: true }).waitFor()
      assert.deepEqual(seen.writes.filter(p => p !== '/me/agent-attention/views'), [])
      assert.deepEqual(seen.errors, [])
    } finally { await context.close() }
  })

  test(`Files & Code entry, Agent workspace overview, details and return: ${tag}`, async () => {
    const { context, page, seen, light } = await open(locale, theme, width)
    try {
      await page.goto(`${baseUrl}/spaces/${space}/projects/${project.id}/files`); await light()
      const entry = page.getByRole('link', { name: L(locale, 'Agent workspaces', 'Agent 工作区'), exact: true }).first()
      await entry.waitFor(); await page.getByText('README.md').first().waitFor()
      await capture(page, `files-entry-${tag}`, false)
      await entry.click()
      await page.waitForURL(`**/projects/${project.id}/files/workspaces`)
      const row = page.getByTestId('agent-workspace-ws-old'); await row.waitFor()
      await page.getByRole('button', { name: L(locale, 'Load more', '加载更多'), exact: true }).click()
      await page.getByTestId('agent-workspace-ws-running').waitFor()
      assert.match(await row.innerText(), L(locale, /Cookie migration[\s\S]*Needs attention/, /Cookie migration[\s\S]*需要处理/))
      assert.match(await page.getByTestId('agent-workspace-ws-running').innerText(), L(locale, /Delegated work[\s\S]*Build box offline/, /委派工作[\s\S]*Build box 离线/))
      await capture(page, `overview-current-${tag}`)
      await row.getByRole('button', { name: L(locale, 'Details', '详情'), exact: true }).click()
      await row.getByRole('button', { name: L(locale, 'Check whether already integrated', '核对是否已合入'), exact: true }).waitFor()
      assert.equal(await row.getByText('src/session.ts').count(), 1)
      await capture(page, `overview-detail-${tag}`)
      await page.getByRole('tab', { name: L(locale, 'History', '历史'), exact: true }).click()
      await page.getByTestId('agent-workspace-ws-parent').waitFor()
      await capture(page, `overview-history-${tag}`)
      assert.deepEqual(seen.views, ['current', 'current+', 'history'])
      await page.getByRole('link', { name: L(locale, 'Files & Code', '文件与代码'), exact: true }).first().click()
      await page.waitForURL(`**/projects/${project.id}/files`)
      await page.getByText('README.md').first().waitFor()
      assert.deepEqual(seen.writes.filter(p => p !== '/me/agent-attention/views'), [])
      assert.deepEqual(seen.errors, [])
    } finally { await context.close() }
  })
}
