import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { chromium } from 'playwright-core'
import { preview } from 'vite'
import { work, page as workPage } from '../modules/agent_work/fixtures.test-support.ts'

// Exercise the built app, including Shell and Project layout. No request reaches
// a backend: the same mixed Markdown reply is read in Rooms and Agent Work.
const now = '2026-10-23T18:00:00.000Z'
const room = {
  id: 'room-layout', space_id: 'space-layout', project_id: 'project-layout', project_folder_id: 'folder-layout',
  title: 'Layout reproduction', status: 'active', created_by_user_id: 'user-layout',
  created_at: now, updated_at: now, is_mainline: true,
}
const session = { id: 'session-layout', room_id: room.id, space_id: room.space_id, project_id: room.project_id,
  title: 'Conversation', status: 'active', created_at: now, updated_at: now }
const folder = { id: room.project_folder_id, name: `workspace_${'long-folder-name-'.repeat(9)}` }
const project = { id: room.project_id, space_id: room.space_id, name: 'Layout project', status: 'active' }
const markdown = [
  '- 列表项包含 `apps/web/src/modules/conversation/ConversationSurface.tsx` 和 **加粗说明**，每行末尾都应该可见。'.repeat(3),
  '  - 嵌套列表也应在可用宽度内换行。',
  '- 第二项不能按照超出可见区域的列宽换行。', '',
  `| ${'UnbrokenHeading'.repeat(12)} | Another heading |`, '|---|---|', '| data | value |', '',
  '```text', `long line ${'0123456789'.repeat(90)}`, '```',
].join('\n')
const message = { id: 'message-layout', session_id: session.id, space_id: room.space_id, role: 'assistant',
  sender_agent_id: null, run_id: null, content: markdown, metadata_json: {}, created_at: now }
const item = work({ identity: { kind: 'session', source_id: session.id }, title: 'Layout work',
  space_id: room.space_id, project_id: project.id, runs: [], read_states: [], visible_run_count: 0,
  operations: [{ kind: 'open_session', space_id: room.space_id, session_id: session.id, room_id: room.id, agent_id: 'agent-layout' }] })
const pageOf = items => ({ items, total: items.length, limit: 100, offset: 0 })

async function mockApi(page) {
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname.replace('/api/v1', '')
    let data
    if (path === '/me') data = { id: 'user-layout', name: 'Layout tester', email: 'layout@example.test',
      default_space_id: room.space_id, instance_role: 'member' }
    else if (path === '/me/spaces') data = [{ id: room.space_id, name: 'Layout Space', type: 'personal', role: 'owner' }]
    else if (path === '/plugins/effective') data = { plugins: {} }
    else if (path === '/rooms') data = pageOf([room])
    else if (path === `/rooms/${room.id}`) data = { room, viewer_can_write: false,
      other_member_names: [], agent_count: 0, agent_members: [], user_members: [] }
    else if (path === `/rooms/${room.id}/conversations`) data = pageOf([session])
    else if (path.endsWith('/messages')) data = { ...pageOf([message]), queued: [] }
    else if (path === '/projects') data = pageOf([project])
    else if (path === `/projects/${project.id}`) data = project
    else if (path.endsWith('/folders')) data = pageOf([folder])
    else if (path.endsWith('/locations')) data = [{ status: 'active', execution_ready: true }]
    else if (path.endsWith('/readers')) data = { readers: [] }
    else if (path === '/agents' || path.endsWith('/members')) data = []
    else if (path.endsWith('/quota')) data = { warn_pct: 80, logins: [], holds: [] }
    else if (path === '/rooms/pending-approvals' || path === '/proposals') data = pageOf([])
    else if (path === '/me/agent-attention/item') data = item
    else if (path === '/me/agent-attention') data = workPage([item])
    else if (path === '/me/agent-attention/snapshot') data = { type: 'attention.snapshot', seq: 1,
      version: 'layout', unread_count: 0, page: workPage([item]), notices: [] }
    else if (path === '/me/agent-attention/stream') return route.fulfill({ status: 503, body: '' })
    else return route.fulfill({ status: 404, json: { detail: 'Unavailable in layout fixture' } })
    return route.fulfill({ json: data })
  })
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

for (const surface of ['Room', 'Agent Work']) {
  test(`${surface} keeps list lines visible across responsive breakpoints`, async () => {
    const page = await browser.newPage({ viewport: { width: 800, height: 1000 }, serviceWorkers: 'block' })
    try {
      await mockApi(page)
      const path = surface === 'Room'
        ? `/spaces/${room.space_id}/projects/${project.id}/rooms?room=${room.id}&conversation=${session.id}`
        : '/agent-work'
      await page.goto(baseUrl + path)
      if (surface === 'Agent Work') await page.locator('[data-work-row]').first().click()
      await page.locator('[data-role="agent"] li').first().waitFor()
      await page.evaluate(() => document.fonts.ready)

      for (const width of [380, 800, 1023, 1024, 1280, 1440]) {
        await page.setViewportSize({ width, height: 1000 })
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        const result = await page.evaluate(() => {
          const viewport = document.documentElement.clientWidth
          const li = document.querySelector('[data-role="agent"] li')
          const bounds = li.getBoundingClientRect()
          const ancestors = []
          for (let el = li.parentElement; el; el = el.parentElement) {
            const rect = el.getBoundingClientRect()
            if (getComputedStyle(el).overflowX !== 'visible') {
              ancestors.push({ tag: el.tagName, label: el.getAttribute('aria-label'),
                left: rect.left, right: rect.right, client: el.clientWidth, scroll: el.scrollWidth })
            }
          }
          const log = li.closest('[role="log"]')
          return { viewport, document: document.documentElement.scrollWidth,
            left: bounds.left, right: bounds.right, ancestors, logClient: log.clientWidth, logScroll: log.scrollWidth }
        })
        assert.ok(result.document <= result.viewport + 1, JSON.stringify({ width, ...result }))
        assert.ok(result.left >= -1 && result.right <= result.viewport + 1, JSON.stringify({ width, ...result }))
        // Root scrollWidth alone misses clipping by Shell and the embedded panel.
        for (const ancestor of result.ancestors) {
          assert.ok(result.left >= ancestor.left - 1 && result.right <= ancestor.right + 1,
            JSON.stringify({ width, ...result }))
        }
        assert.ok(result.logScroll <= result.logClient + 1, JSON.stringify({ width, ...result }))
      }

      const markdownStyles = await page.locator('[data-role="agent"]').first().evaluate(el => {
        const list = el.querySelector('ul')
        const tableScroll = el.querySelector('table').parentElement
        const codeScroll = el.querySelector('[data-streamdown="code-block-body"]')
        return { marker: getComputedStyle(list).listStylePosition,
          nestedPadding: parseFloat(getComputedStyle(list.querySelector('ul')).paddingLeft),
          tableOverflow: getComputedStyle(tableScroll).overflowX,
          codeOverflow: getComputedStyle(codeScroll).overflowX,
          blocks: [tableScroll, codeScroll].map(block => ({ right: block.getBoundingClientRect().right,
            parentRight: el.getBoundingClientRect().right })) }
      })
      assert.equal(markdownStyles.marker, 'inside')
      assert.ok(markdownStyles.nestedPadding > 0)
      assert.equal(markdownStyles.tableOverflow, 'auto')
      assert.equal(markdownStyles.codeOverflow, 'auto')
      for (const block of markdownStyles.blocks) assert.ok(block.right <= block.parentRight + 1)
    } finally {
      await page.close()
    }
  })
}
