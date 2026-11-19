import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { after, before, test } from 'node:test'
import { chromium } from 'playwright-core'
import { preview } from 'vite'
import { work as attentionWork, page as attentionPage } from '../modules/agent_work/fixtures.test-support.ts'

// The built app's Project Agents and Rooms entries, with synthetic APIs only.
// Each surface is opened from the Project navigation, in both themes and both
// bundled locales, at a phone and a desktop width. Screenshots go to
// COLLAB_SHOTS (default /tmp/rainver-collab-shots) for visual inspection;
// the assertions only guard overflow and the presence of each entry.
const shots = process.env.COLLAB_SHOTS ?? '/tmp/rainver-collab-shots'
mkdirSync(shots, { recursive: true })
const now = '2026-11-10T09:00:00.000Z'
const space = { id: 'space-collab', name: 'Team Space', type: 'team', role: 'owner' }
const project = { id: 'project-collab', space_id: space.id, name: 'Atlas research', status: 'active', current_user_can_read: true, current_user_can_write: true }
const room = (id, title, mainline) => ({ id, space_id: space.id, project_id: project.id, project_folder_id: null, created_by_user_id: 'user-collab',
  title, status: 'active', created_at: now, updated_at: now, archived_at: null, is_mainline: mainline, roster_revision: 1 })
const mainline = room('room-main', 'Project conversation', true)
const limited = room('room-review', 'Paper review with a deliberately long Room name', false)
const conversation = { id: 'session-1', space_id: space.id, room_id: mainline.id, project_id: project.id, project_folder_id: null,
  title: 'Plan the literature sweep', status: 'active', created_at: now, updated_at: now }
const runningConversation = { ...conversation, id: 'session-running', title: 'Running review',
  created_at: '2026-11-09T09:00:00.000Z', last_message_at: '2026-11-11T09:00:00.000Z', is_running: true }
const unreadWork = attentionWork({ identity: { kind: 'session', source_id: runningConversation.id },
  space_id: space.id, project_id: project.id, unread_session_ids: [runningConversation.id] })
const attentionFrame = { type: 'attention.snapshot', seq: 1, version: 'fixture', unread_count: 1,
  notices: [], page: attentionPage([unreadWork]) }
const pageOf = items => ({ items, total: items.length, limit: 50, offset: 0 })
const members = [
  { id: 'm-1', space_id: space.id, room_id: mainline.id, user_id: 'user-collab', role: 'owner', status: 'active', created_at: now, updated_at: now },
  { id: 'm-2', space_id: space.id, room_id: mainline.id, user_id: 'user-dana', role: 'member', status: 'active', created_at: now, updated_at: now },
]
const agentMember = (agentId, name, role) => ({ id: `am-${agentId}`, space_id: space.id, room_id: mainline.id, agent_id: agentId, agent_name: name,
  agent_kind: role === 'manager' ? 'system_assistant' : 'standard', role, status: 'active', trigger_policy: 'owner_only', created_at: now, updated_at: now })
const detail = { room: mainline, viewer_can_write: true, other_member_names: ['Dana Li'], agent_count: 2,
  user_members: members.map(member => ({ ...member, role: member.user_id === 'user-collab' ? 'member' : 'owner' })), agent_members: [agentMember('assistant', 'Project Assistant', 'manager'), agentMember('agent-reviewer', 'Critical Reviewer', 'member'), agentMember('agent-room-only','Room-authorized Codex','member')] }
const projectAgents = {
  items: [
    { agent_id: 'agent-reviewer', name: 'Critical Reviewer', description: 'Reads drafts and diffs and names the weakest claim first.', agent_kind: 'standard',
      visibility: 'space_shared', status: 'active', private: false, viewer_is_owner: true, added_at: now,
      rooms: [{ room_id: mainline.id, title: mainline.title, is_mainline: true }] },
    { agent_id: 'agent-scout', name: 'Literature Scout', description: null, agent_kind: 'standard', visibility: 'private', status: 'active',
      private: true, viewer_is_owner: true, added_at: now, rooms: [] },
  ], total: 2, limit: 50, offset: 0, viewer_can_write: true,
}
const roomsIndex = { items: [
  { room: mainline, other_member_names: ['Dana Li'], person_count: 2, agent_count: 2, conversation_count: 1, last_activity_at: now },
  { room: limited, other_member_names: [], person_count: 1, agent_count: 0, conversation_count: 0, last_activity_at: null },
], total: 2, limit: 50, offset: 0, viewer_can_write: true }

async function mockApi(page) {
  const activity = { finished: false, added: [], emptyRooms: false }
  await page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url())
    const path = url.pathname.replace('/api/v1', '')
    let data
    if (path === '/me') data = { id: 'user-collab', name: 'Avery', email: 'avery@example.test', default_space_id: space.id, instance_role: 'member' }
    else if (path === '/me/agent-attention') data = attentionPage([unreadWork])
    else if (path === '/me/agent-attention/snapshot') data = attentionFrame
    else if (path === '/me/agent-attention/stream') return route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify(attentionFrame)}\n\n` })
    else if (path === '/me/spaces') data = [space]
    else if (path === '/plugins/effective') data = { plugins: {} }
    else if (path === '/projects') data = pageOf([project])
    else if (path === `/projects/${project.id}`) data = project
    else if (path === `/projects/${project.id}/overview`) data = { project, brief: null, attention: [] }
    else if (path === `/projects/${project.id}/agents`) data = { ...projectAgents, total: 3, items: [...projectAgents.items,
      { agent_id: 'agent-room-only', name: 'Room-authorized Codex', description: null, agent_kind: 'standard', visibility: 'space_shared', status: 'active',
        private: true, viewer_is_owner: false, room_only: true, added_at: now, rooms: activity.emptyRooms ? [] : [{room_id:mainline.id,title:mainline.title,is_mainline:true}] }] }
    // The single-entry read the chat page asks; the list above is never consulted for it.
    else if (path === `/projects/${project.id}/agents/agent-reviewer`) data = projectAgents.items[0]
    else if (path === '/agents/agent-reviewer') data = { id: 'agent-reviewer', space_id: space.id, name: 'Critical Reviewer', description: null,
      agent_kind: 'standard', status: 'active', visibility: 'space_shared', owner_user_id: 'user-collab', created_at: now, updated_at: now }
    else if (path === `/projects/${project.id}/agent-candidates`) data = pageOf([
      { agent_id: 'agent-reviewer', name: 'Critical Reviewer', description: null, visibility: 'space_shared', private: false, linked: true },
      { agent_id: 'agent-analyst', name: 'Data Analyst', description: 'Checks numbers against their sources.', visibility: 'space_shared', private: false, linked: false },
      { agent_id: 'agent-mine', name: 'My drafting helper', description: null, visibility: 'private', private: true, linked: false },
    ])
    else if (path === `/projects/${project.id}/rooms`) data = roomsIndex
    else if (path === `/projects/${project.id}/conversations`) data = { items: [{ id: conversation.id, room_id: mainline.id, room_title: mainline.title, room_is_mainline: true,
      room_other_member_names: ['Dana Li'], room_agent_count: 2, title: conversation.title, created_at: now, last_message_at: now, last_message_role: 'user',
      last_message_preview: 'Start with the 2024 surveys', message_count: 3 }], empty_rooms: [], total: 1, limit: 3, offset: 0, viewer_can_write: true }
    else if (path === `/projects/${project.id}/mainline-room`) data = { room: mainline, joined: false, viewer_can_write: true }
    else if (path === `/projects/${project.id}/readers`) data = { readers: [{ user_id: 'user-dana', display_name: 'Dana Li', email: null, avatar_url: null }] }
    else if (path === '/actions/room.agent.add' && route.request().method() === 'POST') {
      activity.added.push(route.request().postDataJSON())
      data = {status:'succeeded',data:{room_id:mainline.id,space_id:space.id}}
    }
    else if (path === `/rooms/${mainline.id}`) data = detail
    else if (path === `/rooms/${mainline.id}/conversations`) data = pageOf([conversation, { ...runningConversation, is_running: !activity.finished }])
    else if (path.endsWith('/messages')) data = { ...pageOf([]), task_group_ids: [], queued: [] }
    else if (path.endsWith('/agent-candidates')) data = { agents: [
      {agent_id:'agent-room-only',name:'Room-authorized Codex',agent_kind:'standard',owner_user_id:'user-collab',visibility:'space_shared',in_room:true,in_project:true,private:true,shared_with_user_ids:['user-collab']},
      { agent_id: 'agent-scout', name: 'Literature Scout', agent_kind: 'standard', owner_user_id: 'user-collab', visibility: 'space_shared', in_room: false, in_project: true, member_status: null, private: true, shared_with_user_ids: [] },
      { agent_id: 'agent-analyst', name: 'Data Analyst', agent_kind: 'standard', owner_user_id: null, visibility: 'space_shared', in_room: false, in_project: false, member_status: null, private: false, shared_with_user_ids: [] },
    ], presets: [{ preset_id: 'reviewer', name: 'Reviewer', description: 'Reviews the work' }], total: 2, limit: 100, offset: 0 }
    else if (path.endsWith('/invitations')) data = pageOf([])
    else if (path === '/agents') data = []
    else if (path.endsWith('/members')) data = [{ user_id: 'user-collab', display_name: 'Avery', email: 'avery@example.test' }, { user_id: 'user-dana', display_name: 'Dana Li', email: null }]
    else if (path.endsWith('/quota')) data = { warn_pct: 80, reserve_pct: 90, logins: [], holds: [] }
    else if (path === '/rooms/pending-approvals' || path === '/proposals') data = pageOf([])
    else return route.fulfill({ status: 404, json: { detail: 'Unavailable in collaboration fixture' } })
    return route.fulfill({ json: data })
  })
  return activity
}

let server, browser
let baseUrl = process.env.LAYOUT_BASE_URL
before(async () => {
  if (!baseUrl) {
    server = await preview({ configFile: false, preview: { host: '127.0.0.1', port: 0 } })
    baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`
  }
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE })
})
after(async () => {
  await browser?.close()
  if (server) await new Promise(resolve => server.httpServer.close(resolve))
})

const base = `/spaces/${space.id}/projects/${project.id}`
const surfaces = [
  { name: 'agents', path: `${base}/agents`, ready: '[data-testid="project-agent-agent-reviewer"]', dialog: 'main button:has(svg.lucide-plus)' },
  { name: 'rooms', path: `${base}/rooms`, ready: '[data-testid="room-card-room-main"]' },
  { name: 'room-conversations', path: `${base}/rooms?room=${mainline.id}`, ready: '[role="tablist"]' },
  { name: 'room-members', path: `${base}/rooms?room=${mainline.id}&view=members`, ready: 'text=Critical Reviewer', dialog: 'button:has(svg.lucide-user-plus)' },
  { name: 'conversation', path: `${base}/rooms?room=${mainline.id}&conversation=${conversation.id}`, ready: '[aria-label="Conversation"]' },
  { name: 'agent-chat', path: `${base}/agents/agent-reviewer/chat`, ready: 'h1:has-text("Critical Reviewer")', noWarning: true },
]

for (const locale of ['en', 'zh-CN']) {
  for (const theme of ['dark', 'light']) {
    test(`Project Agents and Rooms render without overflow (${locale}, ${theme})`, async () => {
      for (const width of [390, 1280]) {
        const page = await browser.newPage({ viewport: { width, height: 900 }, serviceWorkers: 'block' })
        try {
          await page.addInitScript(([nextLocale, nextTheme]) => {
            localStorage.setItem('rainver:locale', nextLocale)
            if (nextTheme === 'light') localStorage.setItem('rainver:theme', 'light')
          }, [locale, theme])
          const activity = await mockApi(page)
          for (const surface of surfaces) {
            await page.goto(baseUrl + surface.path)
            await page.locator(surface.ready).first().waitFor({ timeout: 15_000 })
            await page.evaluate(() => document.fonts.ready)
            if (width < 1024 && surface.name === 'agents') {
              // The Project navigation is a disclosure on a phone: open it so the
              // entry is inspected beside its neighbours.
              await page.locator('[aria-controls="project-navigation-items"]').click()
            }
            const overflow = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth }))
            assert.ok(overflow.document <= overflow.viewport + 1, JSON.stringify({ surface: surface.name, width, locale, theme, ...overflow }))
            await page.screenshot({ path: `${shots}/${surface.name}-${locale}-${theme}-${width}.png`, fullPage: false })
            if (surface.name === 'room-conversations') {
              const rows = page.getByRole('navigation', { name: locale === 'en' ? 'Conversations' : '对话' }).getByRole('button')
              assert.match(await rows.first().innerText(), /Running review/)
              await rows.first().getByRole('status', { name: locale === 'en' ? 'Conversation running' : '对话运行中' }).waitFor()
              assert.equal(await rows.first().getByRole('status').count(), 1)
              assert.equal(await rows.first().getByRole('status', { name: locale === 'en' ? 'Unread conversation' : '对话有未读内容' }).count(), 0)
              activity.finished = true
              await page.getByRole('button', { name: locale === 'en' ? 'Refresh' : '刷新', exact: true }).click()
              await rows.first().getByRole('status', { name: locale === 'en' ? 'Unread conversation' : '对话有未读内容' }).waitFor()
              assert.equal(await rows.first().getByRole('status').count(), 1)
              await page.screenshot({ path: `${shots}/completed-unread-${locale}-${theme}-${width}.png`, fullPage: false })
              activity.finished = false
            }
            // An Agent on the Project's list (answered by its single-entry read) gets no "not on the list" notice.
            if (surface.noWarning) assert.equal(await page.getByTestId('not-in-project').count(), 0, `${surface.name} ${locale} ${theme} ${width}`)
            if (surface.dialog) {
              if (width < 1024 && surface.name === 'agents') await page.locator('[aria-controls="project-navigation-items"]').click()
              await page.locator(surface.dialog).first().click()
              await page.getByRole('dialog').waitFor()
              await page.waitForTimeout(300)
              await page.screenshot({ path: `${shots}/${surface.name}-dialog-${locale}-${theme}-${width}.png`, fullPage: false })
              if (surface.name === 'room-members') {
                const add = page.getByRole('dialog').getByText('Literature Scout').locator('../../..').getByRole('button', {name: locale === 'en' ? 'Add' : '添加', exact:true})
                await add.click()
                const confirmation = page.getByRole('dialog').filter({hasText: locale === 'en' ? 'Original Project instructions' : '跨项目运行不带入'})
                await confirmation.waitFor()
                await page.screenshot({path:`${shots}/room-use-confirm-${locale}-${theme}-${width}.png`,fullPage:false,animations:'disabled'})
                const submitted = page.waitForResponse(response => response.url().endsWith('/actions/room.agent.add'))
                await confirmation.getByRole('button',{name:locale==='en'?'Share and add':'共享并添加',exact:true}).click()
                await submitted
                await page.getByRole('dialog').waitFor({state:'hidden'})
                assert.deepEqual(activity.added.at(-1),{room_id:mainline.id,agent_id:'agent-scout',share_private_with_member_ids:['user-dana'],confirm_room_share:true,restore_workspace:false})
                const authorize = page.getByRole('button',{name:locale==='en'?'Authorize members':'授权成员',exact:true})
                await authorize.click()
                const renewed = page.getByRole('dialog').filter({hasText:locale==='en'?'Original Project instructions':'跨项目运行不带入'})
                await renewed.waitFor()
                await page.screenshot({path:`${shots}/room-member-authorization-${locale}-${theme}-${width}.png`,fullPage:false,animations:'disabled'})
                const authorized = page.waitForResponse(response => response.url().endsWith('/actions/room.agent.add'))
                await renewed.getByRole('button',{name:locale==='en'?'Share and add':'共享并添加',exact:true}).click()
                await authorized
                await page.getByRole('dialog').waitFor({state:'hidden'})
                assert.equal(activity.added.at(-1).agent_id,'agent-room-only')
              } else {
                await page.keyboard.press('Escape')
              }
            }
          }
          // A vanished Room never produces an empty room= deep link.
          activity.emptyRooms = true
          await page.goto(baseUrl + `${base}/agents`)
          const emptyRoomEntry = page.getByTestId('project-agent-agent-room-only')
          await emptyRoomEntry.waitFor()
          assert.equal(await emptyRoomEntry.getByRole('link').first().getAttribute('href'), `${base}/rooms`)
          await emptyRoomEntry.getByRole('link').first().click()
          await page.getByText('Paper review with a deliberately long Room name', {exact:true}).waitFor()
          activity.emptyRooms = false
          // The two entries sit side by side in the Project navigation.
          await page.goto(baseUrl + `${base}/agents`)
          await page.locator(surfaces[0].ready).first().waitFor({ timeout: 15_000 })
          const nav = page.locator('#project-navigation-items nav')
          assert.equal(await nav.locator(`a[href$="${base}/agents"]`).count(), 1)
          assert.equal(await nav.locator(`a[href$="${base}/rooms"]`).count(), 1)
          // Agents comes immediately before Rooms.
          const order = await nav.locator('a').evaluateAll(links => links.map(link => link.getAttribute('href')))
          assert.equal(order.indexOf(`${base}/rooms`) - order.indexOf(`${base}/agents`), 1, JSON.stringify(order))
          if (width === 1280) {
            await page.getByRole('button', { name: 'Conversation', exact: true }).click()
            const options = page.getByRole('option')
            assert.match(await options.first().innerText(), /Running review/)
            await options.first().getByRole('status', { name: locale === 'en' ? 'Conversation running' : '对话运行中' }).waitFor()
            assert.equal(await options.first().getByRole('status').count(), 1)
            assert.equal(await options.first().getByRole('status', { name: locale === 'en' ? 'Unread conversation' : '对话有未读内容' }).count(), 0)
            await page.screenshot({ path: `${shots}/conversation-picker-${locale}-${theme}.png`, fullPage: false })
            activity.finished = true
            await options.first().getByRole('status', { name: locale === 'en' ? 'Unread conversation' : '对话有未读内容' }).waitFor({ timeout: 10_000 })
            assert.equal(await options.first().getByRole('status').count(), 1)
          }
        } finally {
          await page.close()
        }
      }
    })
  }
}

for (const locale of ['en', 'zh-CN']) {
  for (const theme of ['dark', 'light']) {
    test(`Imported history folds tools and retains record picks (${locale}, ${theme})`, async () => {
      for (const width of [390, 1280]) {
        const page = await browser.newPage({ viewport: { width, height: 900 }, serviceWorkers: 'block' })
        try {
          await page.addInitScript(([locale, theme]) => {
            localStorage.setItem('rainver:locale', locale)
            localStorage.setItem('rainver:theme', theme)
            localStorage.setItem('project.sidecar.project-collab.open', 'false')
          }, [locale, theme])
          await mockApi(page)
          const imported = { id: 'imported-folding', space_id: space.id, project_id: project.id, title: 'Review the parser',
            runtime_key: 'codex_cli', cwd: '/work/atlas', visibility: 'space_shared', access_level: 'full',
            load_state: 'complete', source_state: 'present', record_count: 5, last_record_at: now }
          const record = (id, kind, overrides = {}) => ({ id, kind, sequence: 0, text: null, tool_name: null, tool_status: null,
            tool_input: null, tool_output: null, raw_json: null, truncated: false, ...overrides })
          const records = [
            record('user', 'user_message', { text: 'Please review the parser and check its tests.' }),
            record('tool-read', 'tool_call', { tool_name: 'Read', tool_status: 'completed', tool_input: JSON.stringify({ file_path: 'src/parser.ts' }), tool_output: 'Parser contents' }),
            record('tool-test', 'tool_call', { tool_name: 'Bash', tool_status: 'completed', tool_input: 'pnpm test', tool_output: 'All parser tests passed.' }),
            record('answer', 'agent_message', { text: 'The parser handles the tested cases correctly.' }),
            record('plan', 'plan', { raw_json: '[{"step":"Check edge cases","status":"completed"}]' }),
          ]
          await page.route('**/api/v1/projects/*/imported-sessions', route => route.fulfill({ json: { sessions: [imported] } }))
          await page.route('**/api/v1/projects/*/imported-sessions/extraction', route => route.fulfill({ json: { records: 0, sessions: 0 } }))
          await page.route('**/api/v1/imported-sessions/imported-folding', route => route.fulfill({ json: { session: imported, records, truncated: false } }))
          await page.goto(`${baseUrl}${base}/conversations`)
          const entry = page.getByTestId('imported-session-imported-folding')
          await entry.waitFor()
          await entry.scrollIntoViewIfNeeded()
          await page.screenshot({ path: `${shots}/imported-entry-${locale}-${theme}-${width}.png` })
          await entry.click()
          await page.getByRole('heading', { name: imported.title }).waitFor()
          const activity = page.getByTestId('imported-activity').first()
          const toggle = activity.getByRole('button').first()
          assert.equal(await toggle.getAttribute('aria-expanded'), 'false')
          await page.getByText('The parser handles the tested cases correctly.', { exact: true }).waitFor()
          assert.equal(await page.getByText('All parser tests passed.', { exact: true }).count(), 0)
          await page.screenshot({ path: `${shots}/imported-collapsed-${locale}-${theme}-${width}.png` })
          await toggle.focus()
          await page.keyboard.press('Enter')
          const tool = activity.getByRole('button', { name: /Read/ })
          assert.equal(await tool.getAttribute('aria-expanded'), 'false')
          await tool.focus()
          await page.keyboard.press('Space')
          await activity.getByText('Parser contents', { exact: true }).waitFor()
          const pickLabel = locale === 'en' ? 'Pick this record' : '选择这条记录'
          const pick = activity.getByRole('checkbox', { name: pickLabel }).first()
          await pick.focus()
          await page.keyboard.press('Space')
          assert.equal(await pick.isChecked(), true)
          await page.screenshot({ path: `${shots}/imported-expanded-${locale}-${theme}-${width}.png` })
          await toggle.click()
          assert.match(await toggle.innerText(), /1/)
          assert.equal(await toggle.getAttribute('aria-expanded'), 'false')
          await toggle.click()
          assert.equal(await activity.getByRole('checkbox', { name: pickLabel }).first().isChecked(), true)
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no horizontal overflow')
          await page.getByRole('link', { name: 'Conversations', exact: true }).click()
          await entry.waitFor()
        } finally { await page.close() }
      }
    })
  }
}

for (const [locale, theme, width] of [['en', 'dark', 1280], ['zh-CN', 'light', 1280], ['en', 'light', 390], ['zh-CN', 'dark', 390]]) {
  test(`Codex import explains writer locks beside retry controls (${locale} ${theme} ${width})`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, serviceWorkers: 'block' })
    try {
      await page.addInitScript(([locale, theme]) => {
        localStorage.setItem('rainver:locale', locale)
        localStorage.setItem('rainver:theme', theme)
        localStorage.setItem('project.sidecar.project-collab.open', 'false')
      }, [locale, theme])
      await mockApi(page)
      const imported = { id: 'imported-busy', space_id: space.id, project_id: project.id, title: 'Codex parser review', runtime_key: 'codex_cli',
        cwd: '/work/parser', visibility: 'space_shared', access_level: 'full', source_state: 'present', load_state: 'partial', record_count: 1,
        last_record_at: now, last_error: '{"data":{"reason":"thread_active_writer"}}' }
      const folder = { id: 'folder-busy', name: 'Parser workspace', status: 'active', kind: 'code', created_at: now,
        snapshot_retention_days: null, snapshot_max_count: null }
      const location = { id: 'location-busy', execution_host_kind: 'remote', execution_ready: true, status: 'active', display_path: '/work/parser' }
      await page.route('**/api/v1/projects/*/folders/folder-busy', route => route.fulfill({ json: folder }))
      await page.route('**/api/v1/projects/*/folders/folder-busy/locations', route => route.fulfill({ json: [location] }))
      await page.route('**/api/v1/workspace-locations/location-busy/ambient-sessions/offer', route => route.fulfill({ json: { policy: { entries: [] },
        counts: [{ location_id: location.id, runtime_key: 'codex_cli', installation: 'own', session_count: 1, error: null }] } }))
      await page.route('**/api/v1/workspace-locations/location-busy/ambient-sessions', route => route.fulfill({ json: { sessions: [imported] } }))
      await page.route('**/api/v1/imported-sessions/imported-busy', route => route.fulfill({ json: { session: imported,
        records: [{ id: 'kept', kind: 'user_message', text: 'Existing history remains readable', sequence: 0 }], truncated: false } }))
      await page.goto(`${baseUrl}${base}/folders/folder-busy`)
      const panel = page.getByTestId('ambient-import-panel')
      const notice = panel.getByRole('alert')
      await notice.waitFor()
      await notice.scrollIntoViewIfNeeded()
      assert.match(await notice.innerText(), locale === 'en' ? /Deleting imported history will not release/ : /删除已导入的历史不会解除占用/)
      assert.equal(await panel.getByRole('button', { name: 'Import now' }).isEnabled(), true)
      assert.ok(await panel.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'import settings fit within their card')
      await page.screenshot({ path: `${shots}/import-busy-settings-${locale}-${theme}-${width}.png` })
      await page.goto(`${baseUrl}${base}/imported-sessions/imported-busy`)
      await page.getByRole('alert').waitFor()
      await page.getByText('Existing history remains readable', { exact: true }).waitFor()
      await page.screenshot({ path: `${shots}/import-busy-transcript-${locale}-${theme}-${width}.png` })
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
    } finally { await page.close() }
  })
}

for (const [locale, theme, width] of [['en', 'dark', 1280], ['zh-CN', 'light', 1280], ['en', 'light', 390], ['zh-CN', 'dark', 390]]) {
  test(`History reminder keeps a manual entry and folder controls (${locale} ${theme} ${width})`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, serviceWorkers: 'block' })
    try {
      await page.addInitScript(([locale, theme]) => {
        localStorage.setItem('rainver:locale', locale)
        localStorage.setItem('rainver:theme', theme)
        localStorage.setItem('project.sidecar.project-collab.open', 'false')
      }, [locale, theme])
      await mockApi(page)
      const folder = { id: 'folder-history', name: 'Parser workspace', status: 'active', kind: 'code', created_at: now }
      const location = { id: 'location-history', project_folder_id: folder.id, execution_host_kind: 'remote', execution_ready: true, status: 'active', display_path: '/work/parser' }
      let reminder = { enabled: true, snoozed_until: null }
      await page.route(/\/api\/v1\/projects\/[^/]+\/folders(?:\?.*)?$/, route => route.fulfill({ json: pageOf([folder]) }))
      await page.route('**/api/v1/projects/*/folders/folder-history', route => route.fulfill({ json: folder }))
      await page.route('**/api/v1/projects/*/folders/folder-history/locations', route => route.fulfill({ json: [location] }))
      await page.route('**/api/v1/workspace-locations/location-history/ambient-sessions/offer', route => route.fulfill({ json: {
        policy: { entries: [], offered_at: now, reminder }, counts: [],
        attention: { new_sessions: 2, updated_sessions: 1, incomplete_sessions: 1, uncertain: false },
      } }))
      await page.route('**/api/v1/workspace-locations/location-history/ambient-sessions', route => route.fulfill({ json: { sessions: [] } }))
      await page.route('**/api/v1/workspace-locations/location-history/ambient-sessions/reminder', async route => {
        const { mode } = route.request().postDataJSON()
        reminder = { enabled: mode !== 'never', snoozed_until: mode === 'later' ? '2999-01-01T00:00:00Z' : null }
        await route.fulfill({ json: { status: 'succeeded', data: { policy: { entries: [], offered_at: now, reminder } } } })
      })
      await page.goto(`${baseUrl}${base}`)
      const banner = page.getByTestId('ambient-import-banner')
      await banner.waitFor()
      await banner.scrollIntoViewIfNeeded()
      assert.ok(await banner.evaluate(el => el.scrollWidth <= el.clientWidth + 1))
      await page.screenshot({ path: `${shots}/history-reminder-${locale}-${theme}-${width}.png` })
      await banner.getByRole('button', { name: locale === 'en' ? 'Don’t remind for this folder' : '此文件夹不再提醒' }).click()
      await banner.waitFor({ state: 'detached' })
      await page.goto(`${baseUrl}${base}/conversations`)
      const manual = page.getByTestId('ambient-import-entry')
      await manual.getByRole('button').waitFor()
      await page.screenshot({ path: `${shots}/history-entry-${locale}-${theme}-${width}.png` })
      await manual.getByRole('button').click()
      await page.getByRole('dialog').getByRole('link').click()
      const panel = page.getByTestId('ambient-import-panel')
      const enable = panel.getByRole('button', { name: locale === 'en' ? 'Enable reminders' : '开启提醒' })
      await enable.waitFor()
      await enable.click()
      await panel.getByRole('button', { name: locale === 'en' ? 'Turn off reminders' : '关闭提醒' }).waitFor()
      await panel.scrollIntoViewIfNeeded()
      await page.screenshot({ path: `${shots}/history-settings-${locale}-${theme}-${width}.png` })
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
    } finally { await page.close() }
  })
}

for (const [locale, theme, width, count] of [['en', 'dark', 1280, 1], ['zh-CN', 'light', 390, 1], ['en', 'light', 390, 2], ['zh-CN', 'dark', 1280, 2]]) {
  test(`Conversation settings use one closed entry (${locale} ${theme} ${width} ${count} Agents)`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, serviceWorkers: 'block' })
    try {
      await page.addInitScript(([locale, theme]) => {
        localStorage.setItem('rainver:locale', locale)
        localStorage.setItem('rainver:theme', theme)
        localStorage.setItem('project.sidecar.project-collab.open', 'false')
      }, [locale, theme])
      await mockApi(page)
      const agents = detail.agent_members.slice(0, count)
      await page.route('**/api/v1/rooms/room-main', route => route.fulfill({ json: { ...detail, agent_members: agents } }))
      // An initialized conversation reports its participants; N in the entry counts them.
      const pins = agents.map(member => ({ agent_id: member.agent_id, runtime_profile_id: 'runtime-settings', runtime_key: 'codex_cli', runtime_installation: 'codex' }))
      await page.route(`**/api/v1/sessions/${conversation.id}/execution-context`, route => route.fulfill({ json: {
        summary: { session_id: conversation.id, state: 'initialized', participant_agent_ids: agents.map(member => member.agent_id), host: null, runtime: pins[0], runtimes: pins,
          primary: null, attachments: [], dispatch_locked: false, queue_paused_at: null, can_send: true, blocked_reason: null },
        available_hosts: [], available_runtime_profiles: [], available_primary_locations: [],
      } }))
      await page.route(`**/api/v1/runtime-context/room-conversations/${conversation.id}/retrieval`, route => route.fulfill({ json: {
        work_context_scope_id: null, enabled: false, preferred_domains: [], setup_version: null,
      } }))
      await page.route('**/api/v1/agents/*/conversation-backends?*', route => route.fulfill({ json: {
        options: [{ runtime_profile_id: 'runtime-settings', runtime_key: 'codex_cli', name: 'Codex CLI', usable: true, model_name: null,
          session_config_options: [
            { id: 'model', name: 'Model', description: null, category: 'model', type: 'select', current_value: 'sol', options: [
              { value: 'sol', name: '6.1 Sol', description: null, group: null }, { value: 'other', name: 'Other model', description: null, group: null },
            ] },
            { id: 'fast', name: 'Fast mode', description: null, category: 'model_config', type: 'boolean', current_value: false },
          ] }], binding: { runtime_profile_id: 'runtime-settings', runtime_key: 'codex_cli' }, session_config: [],
      } }))
      await page.goto(`${baseUrl}${base}/rooms?room=room-main&conversation=${conversation.id}`)
      const trigger = page.getByRole('button', { name: locale === 'en' ? `Conversation settings · ${count}` : `对话设置 · ${count}`, exact: true })
      await trigger.waitFor()
      assert.equal(await page.getByRole('switch', { name: 'Fast mode' }).count(), 0)
      await trigger.scrollIntoViewIfNeeded()
      await page.screenshot({ path: `${shots}/run-settings-entry-${locale}-${theme}-${width}-${count}.png` })
      await trigger.click()
      const dialog = page.getByRole('dialog', { name: locale === 'en' ? 'Conversation settings' : '对话设置', exact: true })
      await dialog.waitFor()
      await dialog.evaluate(el => Promise.all(el.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {}))))
      assert.ok(await dialog.evaluate(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight }))
      // Every participant keeps its model control mounted; a single participant opens with all parameters,
      // several show other parameters one Agent at a time on request.
      assert.equal(await dialog.getByRole('button', { name: 'Model', exact: true }).count(), count)
      assert.equal(await dialog.getByRole('switch', { name: 'Fast mode' }).count(), count === 1 ? 1 : 0)
      if (count > 1) {
        // The whole row is the pointer target; its labelled button is the keyboard control.
        const more = dialog.getByRole('button', { name: new RegExp(`· ${agents[1].agent_name}$`) })
        await more.focus(); await more.press('Enter')
        assert.equal(await more.getAttribute('aria-expanded'), 'true')
        await dialog.getByRole('switch', { name: 'Fast mode' }).waitFor()
        assert.equal(await dialog.getByRole('switch', { name: 'Fast mode' }).count(), 1)
      }
      assert.equal(await dialog.locator('details').count(), 0)
      assert.ok(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1))
      await page.screenshot({ path: `${shots}/run-settings-dialog-${locale}-${theme}-${width}-${count}.png` })
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'detached' })
      assert.ok(await trigger.isVisible())
    } finally { await page.close() }
  })
}

// The Shell's quick-capture control floats at the lower right of the Project's
// middle content, outside the Project chat. The chat footer keeps no empty
// reservation for it, and the control follows the content edge as the chat
// opens, closes and is resized.
for (const [locale, theme] of [['en', 'dark'], ['zh-CN', 'light']]) {
  test(`Quick capture floats beside the Project chat, not inside it (${locale}, ${theme})`, async () => {
    const box = locator => locator.evaluate(node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height } })
    const capture = locale === 'en' ? 'Quick capture' : '快速采集'
    const closeCapture = locale === 'en' ? 'Close quick capture' : '关闭快速采集'
    for (const width of [1024, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, serviceWorkers: 'block' })
      try {
        await page.addInitScript(([locale, theme]) => {
          localStorage.setItem('rainver:locale', locale)
          localStorage.setItem('rainver:theme', theme)
        }, [locale, theme])
        await mockApi(page)
        await page.route('**/api/v1/**/quota', route => route.fulfill({ json: { warn_pct: 80, reserve_pct: 90, holds: [], logins: [{ login_key: 'claude', account_label: 'Team Claude', agent_ids: ['assistant', 'agent-reviewer', 'agent-room-only'],
          checked_at: new Date().toISOString(), window: null, windows: [{ kind: 'week', utilization: 64, resets_at: null, checked_at: new Date().toISOString() }] }] } }))
        await page.goto(`${baseUrl}${base}/agents`)
        await page.locator(surfaces[0].ready).first().waitFor({ timeout: 15_000 })
        await page.evaluate(() => document.fonts.ready)
        const sidecar = page.getByTestId('project-chat-sidecar')
        const content = page.locator('[data-project-area-content]')
        const fab = page.getByRole('button', { name: capture, exact: true })
        const footer = sidecar.getByRole('link', { name: locale === 'en' ? 'Open in Room' : '在 Room 中打开' }).locator('..')
        await footer.waitFor()
        const viewport = await page.evaluate(() => document.documentElement.clientWidth)
        // Its Tailwind offset: 1.25rem from the content edge and the bottom.
        const gap = await page.evaluate(() => 1.25 * parseFloat(getComputedStyle(document.documentElement).fontSize))
        await page.screenshot({ path: `${shots}/capture-open-chat-${locale}-${theme}-${width}.png` })
        // The footer is the panel's last row: no reserved band below it.
        const [panel, foot, area] = [await box(sidecar), await box(footer), await box(content)]
        assert.ok(panel.bottom - foot.bottom <= 1.5, JSON.stringify({ panel, foot }))
        assert.ok(foot.height <= 36, JSON.stringify(foot))
        const placed = async (edge, label) => {
          // The control moves after the layout observer reports the new edge.
          let button
          for (let attempt = 0; attempt < 50; attempt += 1) {
            button = await box(fab)
            if (Math.abs(edge - button.right - gap) <= 2) break
            await page.waitForTimeout(100)
          }
          assert.ok(Math.abs(edge - button.right - gap) <= 2, JSON.stringify({ label, edge, button }))
          assert.ok(Math.abs(900 - button.bottom - gap) <= 2, JSON.stringify({ label, button }))
        }
        await placed(area.right, 'open')
        assert.ok(Math.abs(area.right - panel.left) <= 1, JSON.stringify({ area, panel }))
        // Resizing the chat from the keyboard moves the content edge, and the control with it.
        await sidecar.getByRole('separator').focus()
        await page.keyboard.press('ArrowLeft')
        await page.keyboard.press('ArrowLeft')
        const resized = await box(sidecar)
        assert.ok(resized.width > panel.width + 30, JSON.stringify({ panel, resized }))
        await placed(resized.left, 'resized')
        // The open capture box sits at the same corner, still outside the chat, and closes again.
        await fab.click()
        const dialog = page.getByRole('button', { name: closeCapture, exact: true }).locator('../..')
        const opened = await box(dialog)
        assert.ok(opened.left >= area.left + gap - 1, JSON.stringify({ opened, area }))
        if (resized.left - area.left >= opened.width + 2 * gap) {
          assert.ok(opened.right <= resized.left - gap + 1, JSON.stringify({ opened, resized }))
        }
        await page.screenshot({ path: `${shots}/capture-box-chat-${locale}-${theme}-${width}.png` })
        await page.getByRole('button', { name: closeCapture, exact: true }).click()
        if (width === 1024) {
          const handle = await box(sidecar.getByRole('separator'))
          const x = handle.left + handle.width / 2
          const y = handle.top + handle.height / 2
          await page.mouse.move(x, y)
          await page.mouse.down()
          await page.mouse.move(x - 300, y, { steps: 8 })
          await page.mouse.up()
          const widest = await box(sidecar)
          assert.ok(widest.width > resized.width + 100, JSON.stringify({ widest, resized }))
          await placed(widest.left, 'max-width')
          await fab.click()
          const fallback = await box(dialog)
          assert.ok(fallback.left >= area.left + gap - 1, JSON.stringify({ fallback, area }))
          assert.ok(fallback.right > widest.left && fallback.right <= viewport - gap + 1, JSON.stringify({ fallback, widest }))
          await page.screenshot({ path: `${shots}/capture-max-chat-${locale}-${theme}.png` })
          await page.getByRole('button', { name: closeCapture, exact: true }).click()
        }
        // Closing the chat returns the content edge, and the control, to the viewport edge.
        await sidecar.getByRole('button', { name: locale === 'en' ? 'Close Project chat' : '关闭项目对话' }).click()
        await sidecar.waitFor({ state: 'detached' })
        await placed(viewport, 'closed')
        await page.screenshot({ path: `${shots}/capture-closed-chat-${locale}-${theme}-${width}.png` })
        await page.getByRole('button', { name: locale === 'en' ? 'Open Project chat' : '打开项目对话' }).click()
        await sidecar.waitFor()
        await placed((await box(sidecar)).left, 'reopened')
        if (width === 1440) {
          // The usage control in the same composer: its toggle names the next action in both states.
          const usage = sidecar.getByRole('button', { name: locale === 'en' ? 'Usage: 64% used' : '用量: 已用 64%' })
          await usage.click()
          const hide = page.getByRole('button', { name: locale === 'en' ? 'Hide percentage on the button' : '在按钮上隐藏百分比', exact: true })
          await hide.waitFor()
          assert.equal(await hide.getAttribute('aria-pressed'), null)
          assert.match(await usage.innerText(), /64%/)
          await page.screenshot({ path: `${shots}/usage-shown-${locale}-${theme}.png` })
          await hide.click()
          const show = page.getByRole('button', { name: locale === 'en' ? 'Show percentage on the button' : '在按钮上显示百分比', exact: true })
          await show.waitFor()
          assert.doesNotMatch(await usage.innerText(), /64%/)
          await page.screenshot({ path: `${shots}/usage-hidden-${locale}-${theme}.png` })
        }
      } finally { await page.close() }
    }
    // Phone: the control keeps its place above the tab bar, and the full-screen
    // conversation still hides the Shell chrome that carries it.
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' })
    try {
      await page.addInitScript(([locale, theme]) => {
        localStorage.setItem('rainver:locale', locale)
        localStorage.setItem('rainver:theme', theme)
        localStorage.setItem('project.sidecar.project-collab.open', 'false')
      }, [locale, theme])
      await mockApi(page)
      await page.goto(`${baseUrl}${base}/agents`)
      await page.locator(surfaces[0].ready).first().waitFor({ timeout: 15_000 })
      const fab = page.getByRole('button', { name: capture, exact: true })
      const gap = await page.evaluate(() => 1.25 * parseFloat(getComputedStyle(document.documentElement).fontSize))
      const button = await box(fab)
      assert.ok(Math.abs(390 - button.right - gap) <= 2 && Math.abs(844 - button.bottom - 4 * gap) <= 2, JSON.stringify(button))
      await page.screenshot({ path: `${shots}/capture-phone-${locale}-${theme}.png` })
      await page.getByRole('button', { name: locale === 'en' ? 'Open Project chat' : '打开项目对话' }).click()
      await page.getByTestId('project-chat-sidecar').waitFor()
      await fab.waitFor({ state: 'hidden' })
      await page.screenshot({ path: `${shots}/capture-phone-chat-${locale}-${theme}.png` })
    } finally { await page.close() }
  })
}
