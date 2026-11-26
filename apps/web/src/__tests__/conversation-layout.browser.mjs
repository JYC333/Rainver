import {SESSION_OPERATION_SCHEMAS, ROOM_OPERATION_SCHEMAS, AGENT_OPERATION_SCHEMAS} from '@rainver/protocol'
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { mkdirSync } from 'node:fs'
import { chromium, webkit } from 'playwright-core'
import { preview } from 'vite'
import { work, workRun, run, turn, page as workPage } from '../modules/agent_work/fixtures.test-support.ts'

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
const project = { id: room.project_id, space_id: room.space_id, name: 'Layout project', status: 'active', current_user_can_read: true, current_user_can_write: true }
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

async function assertMenuUnclipped(page) {
  const result = await page.getByRole('listbox').evaluate(menu => {
    const bounds = menu.getBoundingClientRect()
    for (let parent = menu.parentElement; parent; parent = parent.parentElement) {
      if (!/(auto|scroll|hidden|clip)/.test(getComputedStyle(parent).overflowY)) continue
      const clip = parent.getBoundingClientRect()
      if (bounds.top < clip.top - 1 || bounds.bottom > clip.bottom + 1) return false
    }
    return bounds.height > 24
  })
  assert.ok(result, 'model menu must fit clipping ancestors and scroll its own options')
}

async function mockApi(page, conversations = [session], messages = [message]) {
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname.replace('/api/v1', '')
    let data
    if (path === '/me') data = { id: 'user-layout', name: 'Layout tester', email: 'layout@example.test',
      default_space_id: room.space_id, instance_role: 'member' }
    else if (path === '/me/spaces') data = [{ id: room.space_id, name: 'Layout Space', type: 'personal', role: 'owner' }]
    else if (path === '/plugins/effective') data = { plugins: {} }
    else if (path === '/me/summary') data = { pending_proposals_count: 0, assigned_tasks_count: 0, recent_runs: [], recent_participation: [], accessible_spaces_count: 1, spaces: [{ space_id: room.space_id, name: 'Layout Space', type: 'personal', pending_proposals_count: 0, assigned_tasks_count: 0, recent_failed_runs_count: 0 }] }
    else if (path === '/me/timeline' || path === '/me/pending') data = []
    else if (path === '/me/tasks') data = pageOf([])
    else if (path === '/rooms') data = pageOf([room])
    else if (path === `/rooms/${room.id}`) data = { room, viewer_can_write: false,
      other_member_names: [], agent_count: 0, agent_members: [], user_members: [] }
    else if (path === `/rooms/${room.id}/conversations`) data = pageOf(conversations)
    else if (path.endsWith('/messages')) data = { ...pageOf(messages), queued: [] }
    else if (path === '/projects') data = pageOf([project])
    else if (path === `/projects/${project.id}`) data = project
    else if (path === `/projects/${project.id}/overview`) data = { project, brief: null, attention: [] }
    else if (path.endsWith('/folders')) data = pageOf([folder])
    else if (path.endsWith('/locations')) data = [{ status: 'active', execution_ready: true }]
    else if (path.endsWith('/tree')) data = { name: 'source', path: '.', type: 'dir', children:
      ['first.txt', 'second.txt', 'third.txt', 'example.ts', 'README.md', 'pnpm-workspace.yaml', 'a-very-long-file-name-that-must-remain-fully-visible-in-the-tab.md'].map(name => ({ name, path: name, type: 'file' })) }
    else if (path.endsWith('/git/status')) data = { is_repo: false, branch: null, files: [], truncated: false }
    else if (path.endsWith('/file')) {
      const filePath = new URL(route.request().url()).searchParams.get('path')
      data = { path: filePath, content: filePath.endsWith('.ts') ? 'const greeting = "Hello Rainver";' : filePath, size: filePath.length, line_count: 1 }
    }
    else if (path.endsWith('/file/draft')) data = null
    else if (path.endsWith('/file/revisions')) data = []
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
  browser = process.env.LAYOUT_BROWSER === 'webkit' ? await webkit.launch() : await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE })
})
after(async () => {
  await browser?.close()
  if (server) await new Promise(resolve => server.httpServer.close(resolve))
})

test('Room keeps long user text compact and shows saved images after reload', async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 840 }, serviceWorkers: 'block' })
  const content = `Please review this.\n\n${'A long line of pasted text.\n'.repeat(60)}`
  const shortMessage = Array.from({ length: 10 }, (_, index) => `Short message line ${index + 1}`).join('\n')
  try {
    await mockApi(page, [session], [
      { ...message, id: 'message-short', role: 'user', user_id: 'user-layout', content: shortMessage },
      {
        ...message, role: 'user', user_id: 'user-layout', content,
        input_parts: [{ kind: 'image', media_id: 'media-layout', filename: 'saved.png', media_type: 'image/png', byte_size: 68 }],
      },
    ])
    await page.route('**/conversation-inputs/media/media-layout', route => {
      assert.equal(route.request().headers()['x-rainver-space-id'], room.space_id)
      return route.fulfill({
        contentType: 'image/png',
        body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN8sAAAAASUVORK5CYII=', 'base64'),
      })
    })
    await page.goto(`${baseUrl}/spaces/${room.space_id}/projects/${project.id}/rooms?room=${room.id}&conversation=${session.id}`)
    const preview = page.getByRole('button', { name: 'View full message' })
    await preview.waitFor({ timeout: 15_000 })
    assert.ok(await page.getByText('Short message line 10', { exact: false }).isVisible())
    assert.ok((await preview.boundingBox()).height < 48)
    assert.equal(await page.getByRole('dialog').count(), 0)
    await preview.click()
    const dialog = page.getByRole('dialog', { name: 'View full message' })
    assert.equal(await dialog.getByRole('textbox').inputValue(), content)
    await page.keyboard.press('Escape')
    await page.reload()
    await preview.waitFor()
    await page.getByAltText('saved.png').waitFor()
    await page.waitForFunction(() => document.querySelector('img[alt="saved.png"]')?.naturalWidth > 0)
  } finally {
    await page.close()
  }
})

test('Project Files closes a failed save from the editor toolbar across locales, themes and widths', async () => {
  const path = 'README.md'
  const hash = 'a'.repeat(64)
  const intentId = 'failed-save'
  const screenshots = process.env.FOLDER_SAVE_RECOVERY_SHOTS
  if (screenshots) mkdirSync(screenshots, { recursive: true })
  let closed = 0
  const labels = {
    en: { save: 'Save to Folder', close: 'Close failed save', title: 'Close this failed save?' },
    'zh-CN': { save: '保存到文件夹', close: '关闭失败的保存', title: '关闭这次失败的保存？' },
  }
  for (const locale of ['en', 'zh-CN']) for (const theme of ['dark', 'light']) for (const width of [390, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, serviceWorkers: 'block' })
    try {
      await page.addInitScript(({ locale, theme }) => {
        localStorage.setItem('rainver:locale', locale)
        localStorage.setItem('rainver:theme', theme)
      }, { locale, theme })
      await mockApi(page)
      await page.route('**/api/v1/**/file?*', route => route.fulfill({ json: {
        path, content: 'Original file\n', size: 14, line_count: 2, sha256: hash, encoding: 'utf8', line_ending_mode: 'lf', writable: true,
      } }))
      await page.route('**/api/v1/**/file/draft?*', route => route.fulfill({ json: {
        id: 'draft-layout', space_id: room.space_id, project_id: project.id, project_folder_id: folder.id,
        owner_user_id: 'user-layout', workspace_location_id: 'location-layout', target_kind: 'existing', relative_path: path,
        version: 2, content: 'Keep this private draft\n', byte_size: 24, content_sha256: 'b'.repeat(64),
        base_exists: true, base_sha256: hash, source_encoding: 'utf8', preserve_bom: false, line_ending_mode: 'lf', updated_at: now, expires_at: now,
      } }))
      await page.route('**/api/v1/actions/project.folder.draft.save', route => route.fulfill({ status: 409, json: {
        status: 'refused', error: { code: 'operation_conflict', metadata: { code: 'folder_io_needs_attention', intent_id: intentId } },
      } }))
      await page.route('**/api/v1/actions/project.folder.draft.close_save', route => {
        assert.equal(route.request().postDataJSON().intent_id, intentId)
        closed += 1
        return route.fulfill({ json: { status: 'succeeded', data: { id: intentId } } })
      })
      await page.goto(`${baseUrl}/spaces/${room.space_id}/projects/${project.id}/files?folder=${folder.id}&path=${path}`)
      await page.getByRole('button', { name: labels[locale].save, exact: true }).click()
      const close = page.getByRole('button', { name: labels[locale].close, exact: true })
      await close.waitFor()
      if (screenshots) await page.screenshot({ path: `${screenshots}/${locale}-${theme}-${width}-toolbar.png`, animations: 'disabled' })
      await close.click()
      const dialog = page.getByRole('dialog', { name: labels[locale].title })
      await dialog.waitFor()
      if (screenshots) await page.screenshot({ path: `${screenshots}/${locale}-${theme}-${width}-dialog.png`, animations: 'disabled' })
      await dialog.getByRole('button', { name: labels[locale].close, exact: true }).click()
      await close.waitFor({ state: 'hidden' })
      assert.ok(await page.locator('.cm-content').getByText('Keep this private draft').isVisible())
    } finally {
      await page.close()
    }
  }
  assert.equal(closed, 8)
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
      if (surface === 'Agent Work') assert.equal(await page.getByRole('region', { name: /Runs/ }).count(), 0)
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


test('Files opens previews and fixed internal tabs with native mouse gestures', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' })
  try {
    await mockApi(page)
    await page.goto(`${baseUrl}/spaces/${room.space_id}/projects/${project.id}/files`)
    const file = name => page.getByRole('button', { name, exact: true })
    await file('first.txt').click()
    await page.getByRole('tab', { name: 'first.txt' }).waitFor()
    await file('second.txt').click()
    await page.getByRole('tab', { name: 'second.txt' }).waitFor()
    assert.equal(await page.getByRole('tab', { name: 'first.txt' }).count(), 0)
    await file('second.txt').dblclick()
    assert.equal(await page.getByRole('tab', { name: 'second.txt' }).getAttribute('data-preview'), 'false')
    await file('first.txt').click({ button: 'middle' })
    await page.getByRole('tab', { name: 'first.txt' }).waitFor()
    assert.equal(await page.getByRole('tab', { name: 'first.txt' }).getAttribute('data-preview'), 'false')
    await file('third.txt').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Open in new tab' }).click()
    await page.getByRole('tab', { name: 'third.txt' }).waitFor()
    assert.equal(await page.getByRole('tab', { name: 'third.txt' }).getAttribute('data-preview'), 'false')
    assert.equal(await page.getByRole('tablist', { name: 'Open files' }).getByRole('tab').count(), 3)
    assert.equal(page.context().pages().length, 1)
  } finally {
    await page.close()
  }
})


test('Files shares document tabs and follows light and dark editor themes', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' })
  try {
    await mockApi(page)
    await page.goto(`${baseUrl}/spaces/${room.space_id}/projects/${project.id}/files`)
    await page.getByRole('button', { name: 'example.ts', exact: true }).click()
    await page.locator('.cm-line span[class]').first().waitFor()
    const tab = page.getByRole('tab', { name: 'example.ts' })
    assert.equal(await tab.locator('..').locator('.note-tab__bg').count(), 1)
    const inspect = () => page.locator('.cm-editor').evaluate(editor => ({
      foreground: getComputedStyle(editor).color,
      token: getComputedStyle(editor.querySelector('.cm-line span')).color,
      fontSize: getComputedStyle(editor.querySelector('.cm-scroller')).fontSize,
      content: editor.querySelector('.cm-content').textContent,
    }))
    const dark = await inspect()
    assert.ok(parseFloat(dark.fontSize) >= 12)
    await page.screenshot({ path: '/tmp/rainver-files-dark.png' })
    await page.getByTitle('Switch to light theme').click()
    await page.locator('html.theme-light').waitFor()
    const light = await inspect()
    assert.notEqual(light.foreground, dark.foreground)
    assert.notEqual(light.token, dark.token)
    assert.equal(light.content, dark.content)
    await page.screenshot({ path: '/tmp/rainver-files-light.png' })
    for (const width of [800, 1440]) {
      await page.setViewportSize({ width, height: 1000 })
      const geometry = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }))
      assert.ok(geometry.scroll <= geometry.viewport + 1, JSON.stringify(geometry))
    }
  } finally {
    await page.close()
  }
})


for (const viewport of [{ width: 1000, height: 800 }, { width: 390, height: 844 }]) {
test(`All working delegation members stay after returned results (${viewport.width})`, async () => {
  const page = await browser.newPage({ viewport, serviceWorkers: 'block' })
  try {
    await mockApi(page)
    await page.route('**/api/v1/**', async route => {
      const path = new URL(route.request().url()).pathname
      if (path.endsWith('/messages')) return route.fulfill({ json: { ...pageOf([
        { ...message, id: 'request', role: 'user', user_id: 'user-layout', content: 'Investigate together', metadata_json: { run_ids: ['parent-live'], delegated_run_ids: ['child-done', 'child-live'] } },
        { ...message, id: 'child-reply', run_id: 'child-done', content: 'Returned child findings' },
      ]), queued: [] } })
      if (path.endsWith('/runs/parent-live')) return route.fulfill({ json: { id: 'parent-live', status: 'running', parent_run_id: null } })
      if (path.endsWith('/runs/child-live')) return route.fulfill({ json: { id: 'child-live', status: 'running', parent_run_id: 'parent-live' } })
      if (path.endsWith('/runs/child-done')) return route.fulfill({ json: { id: 'child-done', status: 'succeeded', parent_run_id: 'parent-live' } })
      return route.fallback()
    })
    await page.goto(`${baseUrl}/spaces/${room.space_id}/projects/${project.id}/rooms?room=${room.id}&conversation=${session.id}`)
    const parent = page.getByTestId('turn-parent-live')
    await parent.waitFor()
    await page.waitForFunction(() => {
      const parent = document.querySelector('[data-testid="turn-parent-live"]')
      const child = [...document.querySelectorAll('[data-role="agent"]')].find(node => node.textContent.includes('Returned child findings'))
      return child && parent && Boolean(child.compareDocumentPosition(parent) & Node.DOCUMENT_POSITION_FOLLOWING)
    })
    const sibling = page.getByTestId('turn-child-live')
    await sibling.waitFor()
    await page.waitForFunction(() => {
      const sibling = document.querySelector('[data-testid="turn-child-live"]')
      const result = [...document.querySelectorAll('[data-role="agent"]')].find(node => node.textContent.includes('Returned child findings'))
      return result && sibling && Boolean(result.compareDocumentPosition(sibling) & Node.DOCUMENT_POSITION_FOLLOWING)
    })
    assert.equal(await sibling.count(), 1)
    assert.match(await sibling.textContent(), /delegated by/i)
    assert.equal(await parent.count(), 1)
    assert.equal(await page.getByTestId('turn-child-done').count(), 0)
  } finally { await page.close() }
})
}


test('Room shows the latest messages while Run details are still pending', async () => {
  const page = await browser.newPage({ serviceWorkers: 'block' })
  let releaseRun
  const runGate = new Promise(resolve => { releaseRun = resolve })
  try {
    await page.addInitScript(() => localStorage.setItem('rainver:locale', 'en'))
    await mockApi(page, [session], [{ ...message, run_id: 'slow-run', content: 'Latest message is ready.' }])
    await page.route('**/api/v1/runs/slow-run', async route => {
      await runGate
      await route.fulfill({ json: run({ id: 'slow-run', status: 'succeeded' }) })
    })
    const runRequest = page.waitForRequest('**/api/v1/runs/slow-run')
    await page.goto(`${baseUrl}/spaces/${room.space_id}/projects/${project.id}/rooms?room=${room.id}&conversation=${session.id}`)
    await runRequest
    const transcript = page.getByRole('log', { name: 'Conversation messages', exact: true })
    await transcript.getByText('Latest message is ready.', { exact: true }).waitFor()
    assert.equal(await transcript.getByText('Loading messages…', { exact: true }).count(), 0)
  } finally {
    releaseRun()
    await page.close()
  }
})

test('Room streams a new delegation beyond the loaded history', async () => {
  const shots = '/tmp/rainver-room-live-delegation'
  mkdirSync(shots, { recursive: true })
  const manager = { agent_id: 'agent-manager', agent_name: 'Assistant', role: 'manager', status: 'active' }
  const specialist = { agent_id: 'agent-claude', agent_name: 'Claude', role: 'member', status: 'active' }
  const recent = { ...message, content: 'The previous review is complete.' }
  for (const [surface, locale, theme, width] of [
    ['Room', 'en', 'light', 1280],
    ['Room', 'zh-CN', 'dark', 390],
    ['Sidecar', 'en', 'dark', 390],
    ['Sidecar', 'zh-CN', 'light', 1280],
  ]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, serviceWorkers: 'block' })
    try {
      await page.addInitScript(({ locale, theme, snapshot }) => {
        localStorage.setItem('rainver:locale', locale)
        localStorage.setItem('rainver:theme', theme)
        localStorage.setItem('project.sidecar.project-layout.open', 'true')
        const fetch = window.fetch.bind(window)
        window.fetch = (url, options) => {
          if (!String(url).endsWith('/runs/child-live/turn/stream')) return fetch(url, options)
          const stream = new ReadableStream({
            start(controller) {
              const send = frame => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`))
              const step = { type: 'tool_call', index: 0, call_id: 'inspect', name: 'Inspect changed files',
                kind: null, status: 'running', input: '{"path":"src/app.ts"}', output: null }
              send({ type: 'turn.snapshot', turn: snapshot })
              send({ type: 'turn.part_appended', run_id: snapshot.run_id, cursor: 2, part: step })
              window.addEventListener('fixture:finish-delegation', () => {
                send({ type: 'turn.part_updated', run_id: snapshot.run_id, cursor: 3,
                  part: { ...step, status: 'succeeded', output: 'Review files loaded.' } })
                send({ type: 'turn.state_changed', run_id: snapshot.run_id, state: 'done', blocked_on: null })
              }, { once: true, signal: options.signal })
              options.signal.addEventListener('abort', () => controller.close(), { once: true })
            },
          })
          return Promise.resolve(new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }))
        }
      }, { locale, theme, snapshot: turn({ run_id: 'child-live', state: 'working', parts: [] }) })
      await mockApi(page)
      let child = 'absent'
      const result = { ...message, id: 'child-result', run_id: 'child-live',
        sender_agent_id: specialist.agent_id, content: 'The delegated review is complete.' }
      await page.route('**/api/v1/**', async route => {
        const path = new URL(route.request().url()).pathname
        if (path.endsWith('/mainline-room')) return route.fulfill({ json: { room, viewer_can_write: true } })
        if (path.endsWith('/retrieval')) return route.fulfill({ json: { enabled: false, preferred_domains: [] } })
        // The viewer's own Gmail allows Agent reads; the composer still has no separate Gmail entry (ADR 0033 §6).
        if (path.endsWith('/sources/gmail/connections')) return route.fulfill({ json: { configured: true, connections: [{ id: 'conn-1', mailbox_email: 'layout@example.test',
          status: 'active', granted_scopes: [], last_error_class: null, connected_at: '2026-11-02T08:30:00.000Z', disconnected_at: null,
          agent_read_enabled: true, agent_read_grants: [], updated_at: '2026-11-02T08:30:00.000Z' }] } })
        if (path.endsWith(`/rooms/${room.id}`)) return route.fulfill({ json: {
          room, viewer_can_write: true, other_member_names: [], agent_count: 2,
          agent_members: [manager, specialist], user_members: [],
        } })
        if (path.endsWith('/messages')) return route.fulfill({ json: {
          ...pageOf(child === 'succeeded' ? [recent, result] : [recent]), conversation: session, queued: [],
          active_run_ids: child === 'running' ? ['parent-live', 'child-live'] : ['parent-live'],
        } })
        if (path.endsWith('/runs/parent-live')) return route.fulfill({ json: {
          id: 'parent-live', agent_id: manager.agent_id, owner_user_id: 'user-layout', status: 'waiting_for_dependency',
        } })
        if (path.endsWith('/runs/child-live')) return route.fulfill({ json: {
          id: 'child-live', agent_id: specialist.agent_id, owner_user_id: 'user-layout',
          status: child === 'finalizing' ? 'succeeded' : child,
          delegation_id: 'delegation-live', parent_run_id: 'parent-live',
        } })
        if (path.endsWith('/turn/stream')) return route.fulfill({ contentType: 'text/event-stream', body: '' })
        if (path.endsWith('/runs/child-live/turn')) return route.fulfill({ json: turn({ run_id: 'child-live', parts: [] }) })
        return route.fallback()
      })

      const projectUrl = `${baseUrl}/spaces/${room.space_id}/projects/${project.id}`
      await page.goto(surface === 'Room' ? `${projectUrl}/rooms?room=${room.id}&conversation=${session.id}` : `${projectUrl}/files`)
      if (surface === 'Sidecar' && width < 1024) await page.getByRole('button', { name: 'Open Project chat', exact: true }).click()
      const activity = page.getByRole('status', { name: locale === 'en' ? 'Current activity' : '当前工作状态' })
      const waiting = activity.getByText(locale === 'en' ? 'Assistant · Waiting for other Agents…' : 'Assistant · 等待其他 Agent 返回…')
      const working = activity.getByText(locale === 'en' ? 'Claude · Working…' : 'Claude · 处理中…')
      await waiting.waitFor()
      assert.equal(await working.count(), 0)

      child = 'running'
      await working.waitFor()
      await page.locator('[data-conversation-composer] [contenteditable="true"]').first().waitFor()
      if (surface === 'Room') {
        // A Gmail request is written in the ordinary composer; no dedicated query box or hand-off link exists.
        assert.equal(await page.getByTestId('gmail-private-read-entry').count(), 0)
      }
      assert.equal(await activity.getByRole('button', { name: locale === 'en' ? 'Stop' : '停止' }).count(), 2)
      const liveTurn = page.getByTestId('turn-child-live')
      const tool = liveTurn.getByRole('button', { name: /Inspect changed files/ })
      await tool.waitFor()
      assert.equal(await liveTurn.count(), 1)
      assert.ok(await liveTurn.getByText('Claude', { exact: true }).isVisible())
      await tool.click()
      await liveTurn.getByText(/src\/app\.ts/).waitFor()
      const bounds = await activity.boundingBox()
      assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1)
      await page.screenshot({ path: `${shots}/${surface}-${locale}-${theme}-${width}.png`, animations: 'disabled' })

      child = 'finalizing'
      await working.waitFor({ state: 'hidden' })
      assert.ok(await tool.isVisible())
      child = 'succeeded'
      await page.evaluate(() => window.dispatchEvent(new Event('fixture:finish-delegation')))
      await liveTurn.waitFor({ state: 'detached' })
      const disclosure = page.getByText(locale === 'en' ? 'Delegated result · expand to read' : '委派结果 · 点击展开', { exact: true })
      await disclosure.click()
      await page.getByText(result.content, { exact: true }).waitFor()
      assert.ok(await waiting.isVisible())
    } finally { await page.close() }
  }
})

test('File tabs show complete names and leave room for italic overhang', async () => {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 }, serviceWorkers: 'block' })
  try {
    await mockApi(page)
    await page.goto(`${baseUrl}/spaces/${room.space_id}/projects/${project.id}/files`)
    for (const name of ['pnpm-workspace.yaml', 'a-very-long-file-name-that-must-remain-fully-visible-in-the-tab.md']) {
      await page.getByRole('button', { name, exact: true }).click({ button: 'middle' })
      await page.getByRole('tab', { name, exact: true }).waitFor()
    }
    // Return to an italic preview without replacing the fixed files.
    await page.getByRole('button', { name: 'README.md', exact: true }).click()
    await page.getByRole('tab', { name: 'README.md' }).waitFor()
    const layout = await page.getByRole('tablist', { name: 'Open files' }).evaluate(strip => {
      const tabs = [...strip.querySelectorAll('[role="tab"]')].map(tab => {
        const text = tab.querySelector('.note-tab__label > span')
        const range = document.createRange()
        range.selectNodeContents(text)
        const glyph = range.getBoundingClientRect()
        const label = text.getBoundingClientRect()
        const close = tab.parentElement.querySelector('.note-tab__close').getBoundingClientRect()
        const fills = [...tab.parentElement.querySelectorAll('.note-tab__fill')]
        const inside = (x, y) => fills.some(path => path.isPointInFill(new DOMPoint(x, y).matrixTransform(path.getScreenCTM().inverse())))
        return { name: tab.textContent, width: text.clientWidth, scroll: text.scrollWidth,
          overflow: getComputedStyle(text).overflowX, ellipsis: getComputedStyle(text).textOverflow,
          insideOutline: inside(glyph.left + 1, (glyph.top + glyph.bottom) / 2)
            && inside(glyph.right - 1, (glyph.top + glyph.bottom) / 2)
            && inside((close.left + close.right) / 2, (close.top + close.bottom) / 2),
          endPadding: label.right - glyph.right, clearOfClose: close.left - glyph.right }
      })
      return { tabs, width: strip.clientWidth, scroll: strip.scrollWidth,
        viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth }
    })
    assert.ok(layout.scroll > layout.width, JSON.stringify(layout))
    assert.ok(layout.document <= layout.viewport + 1, JSON.stringify(layout))
    for (const tab of layout.tabs) {
      assert.ok(tab.scroll <= tab.width + 1, JSON.stringify(tab))
      assert.notEqual(tab.ellipsis, 'ellipsis')
      assert.equal(tab.overflow, 'visible')
      assert.ok(tab.endPadding >= 3, JSON.stringify(tab))
      assert.ok(tab.clearOfClose >= 6, JSON.stringify(tab))
      assert.ok(tab.insideOutline, JSON.stringify(tab))
    }
    await page.getByRole('tab', { name: 'README.md' }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: '/tmp/rainver-file-tab-names.png' })
    await page.evaluate(() => document.documentElement.classList.add('theme-light'))
    await page.getByRole('tab', { name: 'a-very-long-file-name-that-must-remain-fully-visible-in-the-tab.md', exact: true }).click()
    await page.getByRole('tablist', { name: 'Open files' }).screenshot({ path: '/tmp/rainver-file-tab-light.png' })
    const shape = await page.locator('.note-tab--active .note-tab__bg').evaluate(background => {
      const box = background.getBoundingClientRect()
      const [left, middle, right] = [...background.children].map(node => node.getBoundingClientRect())
      const fills = [...background.querySelectorAll('.note-tab__fill')]
      const inside = (x, y) => fills.some(path => path.isPointInFill(new DOMPoint(x, y).matrixTransform(path.getScreenCTM().inverse())))
      return { middleEnd: middle.right, rightStart: right.left, leftEnd: left.right, middleStart: middle.left,
        height: box.height, capHeight: right.height,
        outsideRight: inside(box.right - 2, box.top + box.height / 2),
        outsideLeft: inside(box.left + 2, box.top + box.height / 2) }
    })
    assert.ok(Math.abs(shape.middleEnd - shape.rightStart) < 1, JSON.stringify(shape))
    assert.ok(Math.abs(shape.leftEnd - shape.middleStart) < 1, JSON.stringify(shape))
    assert.equal(shape.capHeight, shape.height)
    assert.equal(shape.outsideRight, false, JSON.stringify(shape))
    assert.equal(shape.outsideLeft, false, JSON.stringify(shape))
  } finally {
    await page.close()
  }
})


test('Message file attachments stay compact below image thumbnails', async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, serviceWorkers: 'block' })
  try {
    await mockApi(page)
    const inputs = [
      { kind: 'image', media_id: 'image-layout', filename: 'image.png', media_type: 'image/png', byte_size: 68, sha256: 'a'.repeat(64) },
      { kind: 'input_resource', resource_id: 'resource-layout', source_state: 'saved', display_name: 'pnpm-workspace.yaml',
        relative_path: 'pnpm-workspace.yaml', media_type: 'text/plain', byte_size: 382, sha256: 'b'.repeat(64) },
    ]
    await page.route('**/api/v1/**/messages*', route => route.fulfill({ json: { ...pageOf([
      { ...message, id: 'attachment-message', role: 'user', user_id: 'user-layout', sender_agent_id: null, content: 'Please inspect these attachments.', input_parts: inputs },
    ]), queued: [] } }))
    await page.route('**/api/v1/conversation-inputs/media/image-layout', route => route.fulfill({
      contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0ioAAAAASUVORK5CYII=', 'base64'),
    }))
    await page.goto(`${baseUrl}/spaces/${room.space_id}/projects/${project.id}/rooms?room=${room.id}&conversation=${session.id}`)
    const file = page.getByLabel('Current file pnpm-workspace.yaml', { exact: true })
    const image = page.getByRole('img', { name: 'image.png', exact: true })
    await image.waitFor()
    await file.waitFor()
    for (const width of [380, 1280]) {
      await page.setViewportSize({ width, height: 1000 })
      const imageBounds = await image.boundingBox()
      const fileBounds = await file.boundingBox()
      assert.ok(fileBounds.y >= imageBounds.y + imageBounds.height, JSON.stringify({ imageBounds, fileBounds }))
      assert.ok(fileBounds.height <= 32, JSON.stringify(fileBounds))
      const textSize = await file.evaluate(el => parseFloat(getComputedStyle(el).fontSize))
      assert.ok(textSize <= 14)
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      assert.ok(overflow <= 1)
    }
    await page.screenshot({ path: '/tmp/rainver-message-file-row.png' })
  } finally {
    await page.close()
  }
})

test('mobile navigation and More fit narrow screens and retain Space scope', async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 700 }, serviceWorkers: 'block' })
  try {
    await mockApi(page)
    await page.goto(`${baseUrl}/agent-work`)
    const nav = page.getByRole('navigation', { name: 'Primary', exact: true })
    await nav.waitFor()
    assert.equal(await nav.getByRole('link').count(), 3)
    assert.equal(await nav.getByRole('link', { name: 'Agent Work' }).getAttribute('href'), '/agent-work')
    assert.equal(await nav.getByRole('link', { name: 'Projects', exact: true }).getAttribute('href'), `/spaces/${room.space_id}/projects`)
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 640 })
      await nav.getByRole('button', { name: 'More', exact: true }).click()
      const dialog = page.getByRole('dialog')
      await dialog.waitFor()
      await dialog.evaluate(async element => {
        await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {})))
      })
      const box = await dialog.boundingBox()
      assert.ok(box.x >= 0 && box.x + box.width <= width, 'More fits horizontally')
      assert.ok(box.y >= 0 && box.y + box.height <= 640, 'More fits vertically')
      await dialog.getByRole('link', { name: 'Settings', exact: true }).scrollIntoViewIfNeeded()
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'hidden' })
    }
    await nav.getByRole('button', { name: 'More', exact: true }).click()
    await page.getByRole('dialog').getByRole('link', { name: 'Inbox', exact: true }).click()
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    assert.ok(page.url().endsWith(`/spaces/${room.space_id}/activity`))
  } finally { await page.close() }
})

test('mobile shell stays in the viewport and Project history scrolls independently', async () => {
  const page = await browser.newPage({ viewport: { width: 393, height: 680 }, isMobile: true, serviceWorkers: 'block' })
  try {
    await mockApi(page)
    await page.route('**/api/v1/**/messages*', route => route.fulfill({ json: {
      ...pageOf(Array.from({ length: 30 }, (_, i) => ({ ...message, id: `scroll-message-${i}`, content: `Message ${i}\n\n${markdown}` }))), queued: [],
    } }))
    await page.goto(`${baseUrl}/spaces/${room.space_id}/projects/${project.id}/rooms?room=${room.id}&conversation=${session.id}`)
    assert.equal(await page.locator('meta[name="apple-mobile-web-app-status-bar-style"]').count(),0,
      'do not opt into deprecated iOS translucent status-bar geometry')
    assert.match(await page.locator('meta[name="viewport"]').getAttribute('content'),/viewport-fit=cover/)
    const log = page.getByRole('log', {name:'Conversation messages',exact:true}).locator('.overscroll-y-contain').first()
    await log.locator('[data-role="agent"]').first().waitFor()
    const nav = page.getByRole('navigation', { name: 'Primary', exact: true })
    await log.scrollIntoViewIfNeeded()
    assert.equal(await nav.isVisible(), false)
    const before = await page.locator('[data-mobile-conversation-header]').boundingBox()
    const result = await log.evaluate(element => {
      const outer = document.querySelector('main.flex-1, main.min-h-0')
      const outerBefore = outer?.scrollTop
      element.scrollTop = 0
      element.scrollTop = 150
      return { height: element.clientHeight, total: element.scrollHeight, scroll: element.scrollTop,
        containment: getComputedStyle(element).overscrollBehaviorY, outerBefore, outerAfter: outer?.scrollTop,
        bodyHeight: document.scrollingElement.scrollHeight, viewport: innerHeight }
    })
    assert.ok(result.total > result.height && result.scroll > 0, 'history owns a working scroll container '+JSON.stringify(result))
    assert.equal(result.containment, 'contain')
    assert.equal(result.outerAfter, result.outerBefore)
    assert.ok(result.bodyHeight <= result.viewport, 'document must not scroll behind the shell')
    await page.setViewportSize({ width: 393, height: 550 })
    const after = await page.locator('[data-mobile-conversation-header]').boundingBox()
    assert.ok(before.bottom === undefined || before.y + before.height <= 680)
    assert.ok(after.y + after.height <= 551, 'navigation follows the dynamic viewport')
  } finally { await page.close() }
})


test('mobile Project chat close remains reachable and the panel can reopen', async () => {
  const page = await browser.newPage({ viewport: { width: 393, height: 680 }, isMobile: true, serviceWorkers: 'block' })
  try {
    await mockApi(page)
    await page.route('**/api/v1/projects/*/overview',route=>route.fulfill({json:{project,brief:null,attention:[{id:'gate-layout',title:'Approve pending work',reason:'A person must decide',href:`/projects/${project.id}/board`,attention_class:'gate'}]}}))
    await page.route('**/api/v1/projects/*/mainline-room',route=>route.fulfill({json:{room,viewer_can_write:false}}))
    await page.goto(`${baseUrl}/spaces/${room.space_id}/projects/${project.id}/files`)
    // Desktop browser emulation does not supply physical notch insets. Exercise
    // the shared layout contract with nonzero top, bottom and landscape insets.
    await page.evaluate(() => {
      for (const [edge, value] of Object.entries({ top: 59, bottom: 34, left: 12, right: 12 })) {
        document.documentElement.style.setProperty(`--app-safe-${edge}`, `${value}px`)
      }
    })
    await page.getByRole('button', { name: 'Open Project chat', exact: true }).click()
    const close = page.getByRole('button', { name: 'Back to Project page', exact: true })
    const box = await close.boundingBox()
    assert.ok(box.width >= 32 && box.height >= 32)
    assert.ok(box.x >= 12 && box.y >= 59 && box.y + box.height <= 646)
    assert.equal((await close.textContent()).trim(), '', 'uses the original icon without a new text button')
    const gate=page.getByTestId('project-chat-sidecar').getByRole('link',{name:'Approve pending work',exact:true})
    await gate.waitFor()
    assert.ok(await gate.isVisible(),'Project attention remains visible when Shell navigation yields')
    mkdirSync('/tmp/rainver-mobile-conversation',{recursive:true})
    await page.screenshot({animations:'disabled',path:'/tmp/rainver-mobile-conversation/sidecar-attention.png'})
    const transcript=page.getByTestId('project-chat-sidecar').getByRole('log',{name:'Conversation messages',exact:true})
    await transcript.waitFor()
    await transcript.evaluate(el=>{el.dataset.lifetime='sidecar'})
    await page.setViewportSize({width:1280,height:680})
    await page.waitForFunction(()=>!document.documentElement.hasAttribute('data-mobile-conversation'))
    assert.equal(await transcript.getAttribute('data-lifetime'),'sidecar')
    await page.setViewportSize({width:393,height:680})
    await page.waitForFunction(()=>document.documentElement.hasAttribute('data-mobile-conversation'))
    assert.equal(await transcript.getAttribute('data-lifetime'),'sidecar')
    const panelBox = await page.getByTestId('project-chat-sidecar').boundingBox()
    assert.ok(panelBox.y >= 59 && panelBox.y + panelBox.height <= 646)
    assert.ok(panelBox.x >= 12 && panelBox.x + panelBox.width <= 381)
    const headerBox = await page.locator('[data-mobile-conversation-header]').boundingBox()
    assert.ok(headerBox.y >= 59, 'Shell header also clears the status bar')
    await close.click()
    await page.getByTestId('project-chat-sidecar').waitFor({ state: 'hidden' })
    const reopen = page.getByRole('button', { name: 'Open Project chat', exact: true })
    const reopenBox = await reopen.boundingBox()
    const navBox = await page.getByRole('navigation', { name: 'Primary', exact: true }).boundingBox()
    assert.ok(reopenBox.y + reopenBox.height <= navBox.y, 'reopen stays above bottom navigation')
    assert.ok(Math.abs(navBox.y + navBox.height - 680) <= 1, 'navigation background reaches the viewport bottom')
    const projectsTab = await page.getByRole('navigation', { name: 'Primary', exact: true }).getByRole('link', { name: 'Projects', exact: true }).boundingBox()
    assert.ok(projectsTab.y + projectsTab.height <= 646, 'navigation controls clear the home indicator')
    const capture = await page.getByRole('button', { name: 'Quick capture', exact: true }).boundingBox()
    assert.ok(capture.y + capture.height <= navBox.y, 'quick capture does not cover navigation')
    await reopen.click()
    await close.waitFor()
  } finally { await page.close() }
})

for (const [label, drawer] of [['phone chat', false], ['phone chat and its conversation drawer', true]]) test(`widening over the ${label} leaves no overlay entry for Back to land on`, async () => {
  const page = await browser.newPage({ viewport: { width: 393, height: 680 }, serviceWorkers: 'block' })
  try {
    await mockApi(page)
    await page.route('**/api/v1/projects/*/mainline-room',route=>route.fulfill({json:{room,viewer_can_write:false}}))
    const params = () => new URL(page.url()).searchParams
    await page.goto(`${baseUrl}/home`)
    await page.getByRole('navigation',{name:'Primary',exact:true}).waitFor()
    await page.goto(`${baseUrl}/spaces/${room.space_id}/projects/${project.id}/files`)
    await page.getByRole('button',{name:'Open Project chat',exact:true}).click()
    await page.getByTestId('project-chat-sidecar').getByRole('log',{name:'Conversation messages',exact:true}).waitFor()
    assert.equal(params().get('projectChat'),'1')
    if (drawer) {
      await page.getByRole('button',{name:'Conversations and Room details',exact:true}).click()
      await page.getByRole('dialog').waitFor()
      assert.equal(params().get('conversationDrawer'),'1')
    }
    await page.setViewportSize({width:1280,height:680})
    await page.waitForFunction(()=>!/projectChat|conversationDrawer/.test(location.search))
    await page.getByTestId('project-chat-sidecar').waitFor()
    // Back leaves the Project page: no overlay entry is left behind to bounce on or close itself again.
    await page.goBack()
    await page.waitForURL(url=>new URL(url).pathname==='/home')
    // Forward returns to the Project page with the chat beside it, not to a phone overlay.
    await page.goForward()
    await page.waitForFunction(()=>location.pathname.endsWith('/files') && !/projectChat|conversationDrawer/.test(location.search))
    await page.getByTestId('project-chat-sidecar').waitFor()
  } finally { await page.close() }
})

test('a phone chat carried through widen and narrow keeps its drawer, closes, and leaves no overlay entry', async () => {
  const page = await browser.newPage({ viewport: { width: 393, height: 680 }, serviceWorkers: 'block' })
  try {
    await mockApi(page)
    await page.route('**/api/v1/projects/*/mainline-room',route=>route.fulfill({json:{room,viewer_can_write:false}}))
    const params = () => new URL(page.url()).searchParams
    const sidecar = page.getByTestId('project-chat-sidecar')
    const close = page.getByRole('button', { name: 'Back to Project page', exact: true })
    await page.goto(`${baseUrl}/home`)
    await page.getByRole('navigation',{name:'Primary',exact:true}).waitFor()
    await page.goto(`${baseUrl}/spaces/${room.space_id}/projects/${project.id}/files`)
    await page.getByRole('button',{name:'Open Project chat',exact:true}).click()
    await sidecar.getByRole('log',{name:'Conversation messages',exact:true}).waitFor()
    await page.setViewportSize({width:1280,height:680})
    await page.waitForFunction(()=>!/projectChat/.test(location.search))
    await page.setViewportSize({width:393,height:680})
    await page.waitForFunction(()=>document.documentElement.hasAttribute('data-mobile-conversation'))
    await close.waitFor()
    // Second layer over the carried chat, then widen again: the drawer's entry goes too.
    await page.getByRole('button',{name:'Conversations and Room details',exact:true}).click()
    await page.getByRole('dialog').waitFor()
    assert.equal(params().get('conversationDrawer'),'1')
    await page.setViewportSize({width:1280,height:680})
    await page.waitForFunction(()=>!/projectChat|conversationDrawer/.test(location.search))
    await sidecar.waitFor()
    // Narrowed on the page it was opened on, the chat is still open and closes in place.
    await page.setViewportSize({width:393,height:680})
    await page.waitForFunction(()=>document.documentElement.hasAttribute('data-mobile-conversation'))
    await close.click()
    await sidecar.waitFor({ state: 'hidden' })
    assert.ok(!/projectChat|conversationDrawer/.test(new URL(page.url()).search))
    // Back leaves the Project page and Forward returns to it; neither lands on an overlay entry.
    await page.goBack()
    await page.waitForURL(url=>new URL(url).pathname==='/home')
    await page.goForward()
    await page.waitForFunction(()=>location.pathname.endsWith('/files') && !/projectChat|conversationDrawer/.test(location.search))
    await page.getByRole('button',{name:'Open Project chat',exact:true}).waitFor()
  } finally { await page.close() }
})

test('Settings verifies the running build and exposes opt-in mobile layout diagnostics', async () => {
  const page = await browser.newPage({ viewport: { width: 393, height: 680 }, isMobile: true, serviceWorkers: 'block' })
  try {
    await mockApi(page)
    await page.goto(`${baseUrl}/settings`)
    const check = page.getByRole('button', { name: 'Check for updates', exact: true })
    await check.click()
    await page.getByText('This page matches the build currently served by this address.', { exact: true }).waitFor()
    await page.getByText('Layout diagnostics', { exact: true }).click()
    await page.getByRole('button', { name: 'Collect diagnostics (select text to copy)', exact: true }).click()
    const diagnostic = JSON.parse(await page.getByRole('textbox', { name: 'Layout diagnostics', exact: true }).inputValue())
    const served = await (await page.request.get(`${baseUrl}/version.json`)).json()
    assert.equal(diagnostic.build, served.id)
    assert.equal(diagnostic.window.width, 393)
    assert.ok(diagnostic.shell.rect.height > 0)
    assert.equal(diagnostic.meta.statusBarStyle.length, 0)
    assert.deepEqual(diagnostic.meta.buildInputs, [served.inputsHash])
    assert.ok(diagnostic.viewportUnits['100dvh'].rect.height > 0)
    assert.equal(typeof diagnostic.standalone.displayMode, 'boolean')
    assert.equal('url' in diagnostic, false)
    assert.equal('user' in diagnostic, false)
  } finally { await page.close() }
})

test('Project navigation scrolls independently and file separators use theme borders', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 800 }, serviceWorkers: 'block' })
  try {
    await mockApi(page)
    await page.goto(`${baseUrl}/spaces/${room.space_id}/projects/${project.id}/files`)
    const sidebar = page.locator('[data-project-navigation]')
    const content = page.locator('[data-project-area-content]')
    await sidebar.waitFor()
    await page.getByRole('button', { name: 'first.txt', exact: true }).waitFor()
    const themeBorder = await page.locator('header').first().evaluate(element => getComputedStyle(element).borderBottomColor)
    assert.equal(await content.locator('.border-r').first().evaluate(element => getComputedStyle(element).borderRightColor), themeBorder)
    assert.equal(await content.locator('.border-b').first().evaluate(element => getComputedStyle(element).borderBottomColor), themeBorder)
    await page.evaluate(() => {
      for (const selector of ['[data-project-area-content]', '[data-project-navigation]']) {
        const extra = document.createElement('div'); extra.style.height = '2400px'
        document.querySelector(selector).append(extra)
      }
    })
    const sidebarBefore = await sidebar.boundingBox()
    const contentBox = await content.boundingBox()
    await page.mouse.move(contentBox.x + 30, contentBox.y + 30)
    await page.mouse.wheel(0, 400)
    await page.waitForFunction(() => document.querySelector('[data-project-area-content]').scrollTop > 0)
    assert.equal(await sidebar.evaluate(element => element.scrollTop), 0)
    assert.equal((await sidebar.boundingBox()).y, sidebarBefore.y)
    const contentScroll = await content.evaluate(element => element.scrollTop)
    await page.mouse.move(sidebarBefore.x + 30, sidebarBefore.y + 30)
    await page.mouse.wheel(0, 400)
    await page.waitForFunction(() => document.querySelector('[data-project-navigation]').scrollTop > 0)
    assert.equal(await content.evaluate(element => element.scrollTop), contentScroll)
    assert.equal(await sidebar.evaluate(element => getComputedStyle(element).borderRightColor),
      await page.locator('header').first().evaluate(element => getComputedStyle(element).borderBottomColor))
    assert.equal(await page.locator('.app-safe-shell > div > main').evaluate(element => element.scrollTop), 0)
  } finally { await page.close() }
})

test('Board borders enclose long card lists without moving Project navigation', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 800 }, serviceWorkers: 'block' })
  try {
    await mockApi(page)
    await page.route('**/api/v1/projects/*/board', route => route.fulfill({ json: {
      project: { id: project.id, name: project.name }, viewer_can_write: false, viewer_user_id: 'user-layout', filters: { all: 20, mine: 0, agent_held: 0, needs_me: 0 },
      columns_revision: 'layout-fixture',
      columns: [{ key: 'ready', board_id: null, status_key: 'ready', label: 'Ready', wip_limit: null, count: 20 }],
      cards: Array.from({ length: 20 }, (_, index) => ({ id: `board-long-${index}`, title: `Long Board card ${index}`, status: 'ready', column_key: 'ready', priority: 'normal', risk_level: 'low', due_at: null,
        updated_at: now, responsible: { kind: null, id: null, display_name: null }, active_run_count: 0, latest_run_status: null, evaluation_recommendation: null, blocked_reason: null, completion: { ok: true, missing: [] } })),
    } }))
    await page.goto(`${baseUrl}/spaces/${room.space_id}/projects/${project.id}/board`)
    const last = page.getByTestId('board-card-board-long-19')
    await last.waitFor({ state: 'attached' })
    // The Board fills the Area height; each lane scrolls its own card list inside its border.
    const laneLocator = page.getByTestId('board-column-ready')
    const lane = await laneLocator.boundingBox()
    assert.ok(lane.y + lane.height <= 800 + 1, 'the lane stays within the viewport')
    const list = await last.evaluate(card => {
      let node = card.parentElement
      while (node && !['auto', 'scroll'].includes(getComputedStyle(node).overflowY)) node = node.parentElement
      if (!node) return null
      node.dataset.layoutLaneList = 'true'
      return { scrolls: node.scrollHeight > node.clientHeight + 1, insideLane: node.closest('[data-board-lane]') !== null }
    })
    assert.deepEqual(list, { scrolls: true, insideLane: true }, 'a long card list scrolls inside its lane')
    const listBox = await page.locator('[data-layout-lane-list]').boundingBox()
    assert.ok(listBox.y >= lane.y && listBox.y + listBox.height <= lane.y + lane.height + 1, 'column border encloses the card list')
    const sidebar = page.locator('[data-project-navigation]')
    const top = (await sidebar.boundingBox()).y
    await last.scrollIntoViewIfNeeded()
    const lastBox = await last.boundingBox()
    assert.ok(lastBox.y >= lane.y && lastBox.y + lastBox.height <= lane.y + lane.height + 1, 'column border encloses the last card')
    assert.ok(await page.locator('[data-layout-lane-list]').evaluate(element => element.scrollTop > 0))
    assert.equal((await sidebar.boundingBox()).y, top)
    assert.deepEqual(await laneLocator.boundingBox(), lane, 'scrolling cards does not move the lane')
  } finally { await page.close() }
})

test('Execution context has no empty notice gap and aggregates expired Agents', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' })
  let expired = 0
  try {
    await mockApi(page)
    await page.route('**/api/v1/sessions/*/execution-context', route => route.fulfill({ json: {
      summary: { session_id: session.id, state: 'initialized', host: null, runtime: null,
        runtimes: Array.from({ length: expired }, (_, index) => ({ agent_id: `expired-${index}`, runtime_profile_id: `profile-${index}`, runtime_key: 'claude_code', runtime_installation: 'own', last_run_ended_at: '2020-01-01T00:00:00Z', prompt_cache_ttl_seconds: 3600 })),
        primary: null, attachments: [], dispatch_locked: false, queue_paused_at: null, can_send: true, blocked_reason: null },
      available_hosts: [], available_runtime_profiles: [], available_primary_locations: [],
    } }))
    const path = `${baseUrl}/spaces/${room.space_id}/projects/${project.id}/rooms?room=${room.id}&conversation=${session.id}`
    await page.goto(path)
    const button=page.getByRole('button',{name:/Conversation settings ·/})
    await button.waitFor()
    assert.ok((await button.boundingBox()).height<44)
    expired = 4
    await page.reload()
    await button.click()
    await page.getByRole('tab',{name:'Runtime environment'}).click()
    const panel=page.getByRole('dialog')
    await panel.getByText('Agent session diagnostics and recovery',{exact:true}).click()
    await panel.getByText('Prompt cache estimated expired (4)', { exact: true }).waitFor()
    assert.equal(await panel.getByRole('button', { name: /New session for/ }).count(), 4)
  } finally { await page.close() }
})

test('Reply files open Files & Code and images preview in a closable dialog on desktop and phone', async () => {
  for (const width of [390, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, serviceWorkers: 'block' })
    const png = await page.evaluate(() => {
      const canvas = document.createElement('canvas')
      canvas.width = 2400; canvas.height = 1600
      const context = canvas.getContext('2d')
      context.fillStyle = '#e2e8f0'; context.fillRect(0, 0, 2400, 1600)
      context.fillStyle = '#0f172a'; context.font = '72px sans-serif'; context.fillText('Large preview fixture', 80, 140)
      return canvas.toDataURL('image/png').split(',')[1]
    })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    try {
      await mockApi(page)
      await page.route('**/api/v1/**', async route => {
        const url = new URL(route.request().url())
        if (url.pathname.endsWith('/messages')) return route.fulfill({ json: { ...pageOf([{ ...message, run_id: 'run-preview', metadata_json: { delegated_run_ids: ['child-preview'] }, content: '[Open report](/home/person/project/README.md)\n\n![Show image](/__run_output__/preview.png)\n\n[Expired preview](/tmp/missing.png)' }]), queued: [] } })
        if (url.pathname.endsWith('/runs/run-preview/file-preview')) {
          const path = url.searchParams.get('path')
          if (path === '/tmp/missing.png') return route.fulfill({ status: 404, json: { detail: 'Preview expired' } })
          return route.fulfill({ json: path === '/__run_output__/preview.png'
            ? { kind: 'image', name: 'preview.png', mime_type: 'image/png', content_base64: png }
            : { kind: 'workspace', project_id: project.id, folder_id: folder.id, path: 'README.md' } })
        }
        return route.fallback()
      })
      const source = `${baseUrl}/spaces/${room.space_id}/projects/${project.id}/rooms?room=${room.id}&conversation=${session.id}`
      await page.goto(source)
      await page.getByRole('button', { name: 'Show image', exact: true }).click()
      const dialog = page.getByRole('dialog')
      const image = dialog.getByRole('img', { name: 'preview.png' })
      await image.waitFor()
      await page.waitForFunction(() => { const image = document.querySelector('[role="dialog"] img'); return image?.complete && image.naturalWidth > 0 })
      const bounds = await image.boundingBox()
      assert.ok(bounds.width <= width && bounds.height <= 900 * 0.8, 'Large images stay inside the viewport')
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1))
      assert.equal(new URL(page.url()).pathname, `/spaces/${room.space_id}/projects/${project.id}/rooms`)
      await page.screenshot({ path: `/tmp/rainver-preview-dialog-${width}.png` })
      await dialog.getByRole('button', { name: 'Close', exact: true }).click()
      await page.getByRole('link', { name: 'Expired preview', exact: true }).click()
      await page.getByRole('alert').filter({ hasText: 'unavailable' }).waitFor()
      await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
      await page.getByRole('link', { name: 'Open report', exact: true }).click()
      await page.waitForURL(url => url.pathname.endsWith('/files') && url.searchParams.get('path') === 'README.md')
      await page.locator('.cm-editor').waitFor()
      assert.equal(new URL(page.url()).searchParams.get('folder'), folder.id)
      assert.equal(errors.length, 0, errors.join('\n'))
    } finally { await page.close() }
  }
})


test('Agent Work presents results before folded history across themes, languages and phone widths', async () => {
  for (const locale of ['en', 'zh-CN']) for (const theme of ['dark', 'light']) for (const width of [390, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 960 }, serviceWorkers: 'block' })
    try {
      await page.addInitScript(({ locale, theme }) => {
        localStorage.setItem('rainver:locale', locale)
        localStorage.setItem('rainver:theme', theme)
      }, { locale, theme })
      await mockApi(page)
      const currentId = '55555555-5555-4555-8555-555555555555'
      const olderId = '66666666-6666-4666-8666-666666666666'
      const selected = work({ title: '阅读结果 · Reading result', space_id: room.space_id, project_id: null,
        identity: { kind: 'run', source_id: currentId },
        runs: [workRun({ run_id: currentId, agent_name: 'Reading assistant', started_at: now, ended_at: now }), workRun({ run_id: olderId, agent_name: 'Reading assistant' })],
        visible_run_count: 2, unread: false, read_states: [] })
      await page.route('**/api/v1/**', async route => {
        const path = new URL(route.request().url()).pathname.replace('/api/v1', '')
        if (path === '/me/agent-attention/item') return route.fulfill({ json: selected })
        if (path === '/me/agent-attention') return route.fulfill({ json: workPage([selected]) })
        if (path === '/me/agent-attention/snapshot') return route.fulfill({ json: { type: 'attention.snapshot', seq: 1, version: 'result', unread_count: 0, page: workPage([selected]), notices: [] } })
        if (path.startsWith('/runs/')) {
          const id = path.split('/')[2]
          if (path.endsWith('/turn')) return route.fulfill({ json: turn({ run_id: id, parts: [{ type: 'text', index: 0, text: id === currentId ? '本次结果已经可以阅读。The result is ready to read.' : 'Earlier result' }] }) })
          if (path.endsWith('/authorization-requests')) return route.fulfill({ json: [] })
          if (path === `/runs/${id}`) return route.fulfill({ json: run({ id, space_id: room.space_id }) })
        }
        return route.fallback()
      })
      await page.goto(baseUrl + '/agent-work')
      await page.locator('[data-work-row]').first().click()
      await page.getByText('本次结果已经可以阅读。The result is ready to read.').waitFor()
      const history = page.getByRole('button', { name: locale === 'en' ? /Execution history/ : /执行记录/ })
      assert.equal(await history.getAttribute('aria-expanded'), 'false')
      assert.equal(await page.getByText(currentId, { exact: true }).isVisible(), false)
      await page.screenshot({ path: `/tmp/rainver-work-result-${locale}-${theme}-${width}.png` })
      await history.click()
      const earlier = page.getByRole('button', { name: locale === 'en' ? /Execution 2/ : /第 2 次执行/ })
      await earlier.click()
      await page.getByText('Earlier result', { exact: true }).waitFor()
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
      if (width === 390) await page.screenshot({ path: `/tmp/rainver-work-history-${locale}-${theme}.png` })
    } finally { await page.close() }
  }
})

test('Host Antigravity own installation shows the update action', async () => {
  const hostId = 'host-antigravity'
  const runtime = 'acp_antigravity_acp'
  const entry = { id: 'antigravity-acp', name: 'Google Antigravity', version: '1.5.11' }
  mkdirSync('/tmp/host-antigravity-update', { recursive: true })
  for (const [locale, theme, width] of [['en', 'dark', 390], ['zh-CN', 'light', 1280]]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block' })
    const page = await context.newPage()
    try {
      await page.addInitScript(({locale, theme}) => {
        localStorage.setItem('rainver:locale', locale)
        localStorage.setItem('rainver:theme', theme)
      }, { locale, theme })
      await mockApi(page)
      await page.route('**/api/v1/**', async route => {
        const path = new URL(route.request().url()).pathname.replace('/api/v1', '')
        if (path === '/hosts') return route.fulfill({json:{items:[{
          id: hostId, owner_user_id: 'user-layout', machine_id: 'machine-antigravity', name: 'Laptop', kind: 'remote',
          status: 'online', platform: 'linux', last_heartbeat_at: now, capabilities_json: {
            runtimes: [], antigravity_own_updates: true, installations: { [runtime]: [{ id: 'own', version: '1.5.2', logged_in: true, options: null }] },
          },
        }]}})
        if (path === '/hosts/runtime-definitions') return route.fulfill({json:{items:[{
          runtime_key: runtime, registry_id: entry.id, display_name: entry.name, command: 'agy', remote_eligible: true,
          latest_managed_version: '1.5.10',
        }]}})
        if (path === '/acp-agents/registry') return route.fulfill({json:{items:[entry]}})
        if (path === '/acp-agents' || path === `/hosts/${hostId}/usage` || path === `/hosts/${hostId}/tool-operations`) {
          return route.fulfill({json:{items:[]}})
        }
        return route.fallback()
      })
      await page.goto(`${baseUrl}/spaces/${room.space_id}/command-center`)
      const host = page.getByTestId(`host-agents-${hostId}`)
      const row = host.getByTestId(`host-agent-${hostId}-${runtime}`)
      const label = locale === 'en' ? 'Install managed' : '安装受管版'
      await row.getByText(`${label} 1.5.10`, {exact:true}).waitFor()
      await host.getByRole('button', {name:'Add agent…', exact:true}).click()
      await row.getByText(`${label} 1.5.11`, {exact:true}).waitFor()
      assert.equal(await row.getByRole('button', {name:'Update own Google Antigravity on Laptop'}).isEnabled(), true)
      await host.getByRole('list', {name: locale === 'en' ? 'Agent catalog' : 'Agent 目录'}).getByText(entry.name).waitFor()
      await page.evaluate(() => document.fonts.ready)
      await host.screenshot({path:`/tmp/host-antigravity-update/${locale}-${theme}-${width}.png`,animations:'disabled'})
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    } finally { await context.close() }
  }
})

test('Host Agent catalog keeps installed Agents first and upgrades the selected release', async () => {
  const {mkdir}=await import('node:fs/promises');await mkdir('/tmp/host-agent-catalog',{recursive:true})
  for(const locale of ['en','zh-CN'])for(const theme of ['dark','light'])for(const width of [390,1280]){
    const context=await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block'}),page=await context.newPage();let current='1.2.3',previous='1.0.0',writes=0
    // Install and rollback are durable Host commands: the POST admits one, its status read carries the frozen result.
    const commands={},admit=(kind,result)=>{const id=`catalog-command-${writes}`;commands[id]={id,space_id:room.space_id,host_id:'host-catalog',kind,job_id:`job-${id}`,result};return{status:'succeeded',data:{...commands[id],result:undefined,status:'pending'}}}
    const agent={id:'goose',name:'goose',version:'2.0.0',description:'Research agent / 研究助手',distribution:{kind:'npx',package:'goose-acp@2.0.0',args:[],env:{}}}
    try{
      await page.addInitScript(({locale,theme})=>{localStorage.setItem('rainver:locale',locale);localStorage.setItem('rainver:theme',theme)},{locale,theme})
      await mockApi(page)
      await page.route('**/api/v1/**',async route=>{
        const path=new URL(route.request().url()).pathname.replace('/api/v1','');let data
        if(path==='/me')data={id:'user-layout',name:'Tester',email:'layout@example.test',default_space_id:room.space_id,instance_role:'admin',is_instance_admin:true}
        else if(path==='/hosts')data={items:[{id:'host-catalog',owner_user_id:'user-layout',machine_id:'machine-catalog',name:'Laptop',kind:'remote',status:'online',platform:'linux',last_heartbeat_at:now,capabilities_json:{runtimes:[],versions:{},installations:{acp_goose:[{id:`managed:${current}`,version:current,rollback_version:previous,logged_in:false}]}}}]}
        else if(path==='/hosts/runtime-definitions')data={items:[{runtime_key:'acp_goose',registry_id:'goose',display_name:'goose',command:'goose',remote_eligible:true,latest_managed_version:'2.0.0'}]}
        else if(path==='/acp-agents/registry')data={items:[{...agent,id:'alpha',name:'A new research agent / 新的研究助手'},agent]}
        else if(path==='/acp-agents')data={items:[{...agent,runtime_key:'acp_goose',version:'1.2.3',installed_on:[{host_id:'host-catalog',name:'Laptop'}]}]}
        else if(path==='/hosts/host-catalog/usage')data={items:[]}
        else if(path==='/hosts/host-catalog/installations/acp_goose/rollback'){writes++;current='1.2.3';previous=null;data=admit('runtime_rollback',{ok:true,installation:'managed:1.2.3',host_id:'host-catalog',runtime_key:'acp_goose',error:null})}
        else if(path==='/hosts/host-catalog/installations/acp_goose'){assert.equal(route.request().method(),'POST');assert.equal(route.request().postDataJSON().expected_version,'2.0.0');writes++;previous=current;current='2.0.0';data=admit('runtime_install',{ok:true,installation:'managed:2.0.0',host_id:'host-catalog',runtime_key:'acp_goose',error:null})}
        else if(path.startsWith('/hosts/host-catalog/commands/')){const command=commands[decodeURIComponent(path.split('/').pop())];data={...command,status:'succeeded',error:null,created_at:now,updated_at:now}}
        else return route.fallback()
        return route.fulfill({json:data})
      })
      await page.goto(`${baseUrl}/spaces/${room.space_id}/command-center`)
      const host=page.getByTestId('host-agents-host-catalog');await host.getByRole('button',{name:'Add agent…',exact:true}).click()
      const list=host.getByRole('list',{name:locale==='en'?'Agent catalog':'Agent 目录',exact:true});await list.getByText('goose',{exact:true}).waitFor()
      assert.equal(await list.locator('li').first().getAttribute('data-registry-agent'),'goose')
      assert.equal(await list.locator('li').count(),2)
      await page.evaluate(()=>document.fonts.ready);await host.getByTestId('host-add-agent-host-catalog').scrollIntoViewIfNeeded()
      await page.screenshot({path:`/tmp/host-agent-catalog/${width}-${theme}-${locale}-before.png`,animations:'disabled'})
      await list.getByRole('button',{name:locale==='en'?'Upgrade goose on Laptop':'升级 Laptop 上的 goose',exact:true}).click()
      await list.getByText(locale==='en'?'2.0.0 · Available 2.0.0':'2.0.0 · 可用 2.0.0',{exact:true}).waitFor()
      assert.equal(await list.getByRole('button',{name:/Upgrade|升级/}).count(),0);assert.equal(writes,1)
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
      await page.screenshot({path:`/tmp/host-agent-catalog/${width}-${theme}-${locale}-after.png`,animations:'disabled'})
      assert.equal(await host.getByRole('button',{name:locale==='en'?'Roll back to 1.2.3':'回退到 1.2.3',exact:true}).count(),0)
      await host.getByRole('button',{name:locale==='en'?'More for goose on Laptop':'Laptop 上 goose 的更多操作',exact:true}).click()
      await page.getByRole('menuitem',{name:locale==='en'?'Version management':'版本管理',exact:true}).click()
      const dialog=page.getByRole('dialog',{name:locale==='en'?'Version management · goose':'版本管理 · goose',exact:true})
      await dialog.waitFor();await page.screenshot({path:`/tmp/host-agent-catalog/${width}-${theme}-${locale}-versions.png`,animations:'disabled'})
      await dialog.getByRole('button',{name:locale==='en'?'Roll back to 1.2.3':'回退到 1.2.3',exact:true}).click()
      await list.getByText(locale==='en'?'1.2.3 · Available 2.0.0':'1.2.3 · 可用 2.0.0',{exact:true}).waitFor()
      assert.equal(writes,2)
      await dialog.waitFor({state:'hidden'})
      await host.getByRole('button',{name:locale==='en'?'More for goose on Laptop':'Laptop 上 goose 的更多操作',exact:true}).click()
      await page.getByRole('menuitem',{name:locale==='en'?'Version management':'版本管理',exact:true}).click()
      await dialog.getByText(locale==='en'?'No previous version retained':'没有保留的上一版本',{exact:true}).waitFor()

    }finally{await context.close()}
  }
})


// ADR 0033 §6: a card the withdrawn Gmail hand-off left on a Room reply, as the Room message read projects
// it for its owner: history only — no decision, no link to another conversation, no continuation — while
// another reader's copy never carries it, and the card fits a phone.
test('Room shows a withdrawn Gmail check card to its owner only, as history without a decision or link', async () => {
  const shots = process.env.ROOM_LAYOUT_SHOTS ?? '/tmp/rainver-room-gmail-card-shots'
  mkdirSync(shots, { recursive: true })
  const card = { action_id: 'source.gmail.private_read.request', proposal_id: 'card-gmail', proposal_type: 'gmail_private_read', status: 'failed',
    title: 'Private Gmail check · layout@example.test · Layout project',
    summary: 'Earlier private Gmail check of “Did the builder send the revised kitchen quote this week?” against layout@example.test in Layout project.',
    decidable_by_user_id: 'user-layout', scope: { project_id: project.id } }
  const reply = { ...message, id: 'message-gmail', sender_agent_id: 'agent-layout', content: 'An earlier reply that left a Gmail check card.' }
  for (const [width, locale, theme, owner] of [[1280, 'en', 'light', true], [390, 'zh-CN', 'dark', true], [1280, 'en', 'dark', false]]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, serviceWorkers: 'block' })
    try {
      await page.addInitScript(([locale, theme]) => {
        localStorage.setItem('rainver:locale', locale)
        localStorage.setItem('rainver:theme', theme)
      }, [locale, theme])
      await mockApi(page)
      const posts = []
      await page.route('**/api/v1/**', async route => {
        const request = route.request(), path = new URL(request.url()).pathname.replace('/api/v1', '')
        if (request.method() !== 'GET') posts.push(path)
        // The server projects the card only into its owner's read of the Room message.
        if (path.endsWith('/messages')) return route.fulfill({ json: { ...pageOf([{ ...reply, metadata_json: owner ? { action_previews: [card] } : {} }]), queued: [] } })
        // Still pending in the database: the card itself never offers it.
        if (path === '/proposals/card-gmail') return route.fulfill({ json: { id: 'card-gmail', status: 'pending', expired: false } })
        return route.fallback()
      })
      await page.goto(`${baseUrl}/spaces/${room.space_id}/projects/${project.id}/rooms?room=${room.id}&conversation=${session.id}`)
      await page.getByText('An earlier reply that left a Gmail check card.').waitFor()
      const previews = page.getByTestId('previews-message-gmail')
      if (!owner) {
        assert.equal(await page.getByText(card.title).count(), 0)
        assert.equal(await previews.count(), 0)
        continue
      }
      await previews.getByText('Did the builder send the revised kitchen quote').waitFor()
      await previews.getByText(locale === 'en' ? 'This earlier Gmail check card is no longer in use and cannot start anything.' : '这张早先的 Gmail 查信卡片已停用，不会再启动任何操作。', { exact: true }).waitFor()
      const status = previews.getByText(locale === 'en' ? 'Expired · not applied' : '已过期 · 未生效', { exact: true })
      await status.waitFor()
      assert.equal(await previews.getByRole('button').count(), 0)
      assert.equal(await previews.getByRole('link').count(), 0)
      await page.evaluate(() => document.fonts.ready)
      const fit = await previews.evaluate(el => ({ right: el.getBoundingClientRect().right, scroll: el.scrollWidth, client: el.clientWidth, viewport: innerWidth }))
      assert.ok(fit.right <= fit.viewport + 1 && fit.scroll <= fit.client + 1, JSON.stringify(fit))
      // The status label stays on one line beside a long title, even on a phone.
      const statusBox = await status.evaluate(el => ({ height: el.getBoundingClientRect().height, line: parseFloat(getComputedStyle(el).lineHeight) }))
      assert.ok(statusBox.height <= statusBox.line + 1, JSON.stringify(statusBox))
      await previews.screenshot({ path: `${shots}/${locale}-${theme}-${width}-card.png` })
      await page.screenshot({ path: `${shots}/${locale}-${theme}-${width}-room.png` })
      // Nothing was decided and nothing continued or started (read receipts aside).
      assert.deepEqual(posts.filter(path => path !== '/me/agent-attention/views'), [])
    } finally { await page.close() }
  }
})

// ADR 0036: the owner's application-update card in the Room where they asked, with its scope and what it runs on chosen
// on the card in two levels — an Agent with one runtime profile, then that configuration's model: an unavailable
// configuration names why once, every model its picker offers is listed under it, accepting waits for a
// saved model, choosing another configuration clears it again, and it fits a phone.
test('Room application-update card shows its scope, explains unavailable configurations once and accepts only after a configuration and its model are saved', async () => {
  const shots = process.env.ROOM_LAYOUT_SHOTS ?? '/tmp/rainver-room-gmail-execution-shots'
  mkdirSync(shots, { recursive: true })
  const card = { action_id: 'source.gmail.application_updates.propose', proposal_id: 'card-apps', proposal_type: 'gmail_digest_create', status: 'proposed',
    title: 'Automatic application updates from Gmail · layout@example.test',
    summary: 'Mailbox layout@example.test: in the background, the Agent and model you choose on this card checks new inbox and sent mail from acceptance and records facts on the matching application — interviews, deadlines and correspondence. No Agent and model is chosen yet: choose one that can run it before accepting.',
    risk_level: 'high', decidable_by_user_id: 'user-layout', scope: { project_id: project.id } }
  const reply = { ...message, id: 'message-apps', sender_agent_id: 'agent-layout', content: 'I drafted the card for automatic application updates.' }
  const configuration = (extra) => ({ agent_id: 'agent-layout', agent_name: 'Layout Agent', agent_kind: 'standard', runtime_profile_id: 'profile-codex', profile_name: 'Codex on Laptop',
    runtime_key: 'codex_cli', backend_mode: 'runtime_native', available: false, reason: 'host_offline', models: [], omitted_models: 0, models_cursor: null, ...extra })
  const saved = { agent_id: 'assistant', runtime_profile_id: 'profile-provider', model: 'provider-large-2026' }
  const options = (selected, summary) => ({ status: 'succeeded', data: { proposal_id: 'card-apps', applies: true, selected, summary, next_cursor: null, card_revision: (selected ? 'b' : 'a').repeat(64),
    scope: { mailbox_email: 'layout@example.test', include_sent: true, effects: ['interview', 'deadline', 'contact'], results_to: 'room', room_title: 'Admissions planning', reader_names: ['Layout User', 'Peer Reviewer'], reader_count: 2 },
    configurations: [
      configuration({}),
      configuration({ agent_id: 'agent-other', agent_name: 'Research Agent', runtime_profile_id: 'profile-other', profile_name: 'Shared Host', runtime_key: 'claude_code', reason: 'host_not_owner' }),
      configuration({ agent_id: 'agent-paired', agent_name: 'Paired Agent', runtime_profile_id: 'profile-paired', profile_name: 'Provider on Laptop', runtime_key: 'opencode', backend_mode: 'model_provider', reason: 'provider_unsupported' }),
      configuration({ agent_id: 'agent-folder', agent_name: 'Folder Agent', runtime_profile_id: 'profile-folder', profile_name: 'Provider in Project folder', runtime_key: 'opencode', backend_mode: 'model_provider', reason: 'provider_endpoint_missing' }),
      configuration({ agent_id: 'assistant', agent_name: 'Project Assistant', agent_kind: 'system_assistant', runtime_profile_id: 'profile-provider', profile_name: 'Team provider',
        runtime_key: 'opencode', backend_mode: 'model_provider', available: true, reason: null, models: [{ model: 'provider-large-2026', name: null }] }),
      configuration({ agent_id: 'agent-writer', agent_name: 'Writer', runtime_profile_id: 'profile-writer', profile_name: 'My laptop', runtime_key: 'claude_code', available: true, reason: null,
        models: [{ model: 'synthetic-full-model-a', name: null }, { model: 'opus', name: 'Opus' }], omitted_models: 3, models_cursor: '2.b3B1cw' }),
    ] } })
  for (const [width, locale, theme] of [[1280, 'en', 'light'], [390, 'zh-CN', 'dark'], [390, 'en', 'light'], [1280, 'zh-CN', 'dark']]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, serviceWorkers: 'block' })
    try {
      await page.addInitScript(([locale, theme]) => {
        localStorage.setItem('rainver:locale', locale)
        localStorage.setItem('rainver:theme', theme)
      }, [locale, theme])
      await mockApi(page)
      const posts = []
      let chosen = false
      await page.route('**/api/v1/**', async route => {
        const request = route.request(), path = new URL(request.url()).pathname.replace('/api/v1', '')
        if (request.method() !== 'GET') posts.push(path)
        if (path.endsWith('/messages')) return route.fulfill({ json: { ...pageOf([{ ...reply, metadata_json: { action_previews: [card] } }]), queued: [] } })
        if (path === '/proposals/card-apps') return route.fulfill({ json: { id: 'card-apps', status: 'pending', expired: false } })
        if (path === '/queries/source.gmail.application_updates.execution_options') return route.fulfill({ json: options(chosen ? saved : null, card.summary) })
        if (path === '/actions/source.gmail.application_updates.select_execution') {
          chosen = true
          return route.fulfill({ json: options(saved,
            card.summary.replace('the Agent and model you choose on this card', 'Project Assistant on provider-large-2026 (Team provider)').replace(' No Agent and model is chosen yet: choose one that can run it before accepting.', '')) })
        }
        return route.fallback()
      })
      await page.goto(`${baseUrl}/spaces/${room.space_id}/projects/${project.id}/rooms?room=${room.id}&conversation=${session.id}`)
      await page.getByText('I drafted the card for automatic application updates.').waitFor()
      const previews = page.getByTestId('previews-message-apps')
      const box = previews.getByTestId('gmail-application-execution')
      await box.waitFor()
      const en = locale === 'en'
      await box.getByText(en ? 'Mailbox: layout@example.test' : '邮箱：layout@example.test', { exact: true }).waitFor()
      await box.getByText(en ? /new inbox and sent mail/ : /新收到和新发送的邮件/).waitFor()
      await box.getByText(en ? /application email correspondence/ : /申请邮件联络记录/).waitFor()
      await box.getByText(en ? /Layout Agent · Codex on Laptop: its execution Host is offline/ : /Layout Agent · Codex on Laptop：其执行 Host 离线/).waitFor()
      await box.getByText(en ? /Research Agent · Shared Host: its runtime is on another person/ : /Research Agent · Shared Host：其运行时在他人的 Host 上/).waitFor()
      await box.getByText(en ? /Paired Agent · Provider on Laptop: this runtime cannot be bound to a ModelProvider/ : /Paired Agent · Provider on Laptop：该运行时不能绑定 ModelProvider/).waitFor()
      await box.getByText(en ? /Folder Agent · Provider in Project folder: its ModelProvider has no compatible endpoint/ : /Folder Agent · Provider in Project folder：其 ModelProvider 没有该运行时所需的兼容端点/).waitFor()
      // Each unavailable configuration is named once; no model level is shown before a configuration is chosen.
      assert.equal(await box.getByText(en ? /its runtime is on another person/ : /其运行时在他人的 Host 上/).count(), 1)
      const configLevel = box.getByRole('button', { name: en ? 'Agent and runtime' : 'Agent 与运行配置', exact: true })
      const modelLevel = box.getByRole('button', { name: en ? 'Model' : '模型', exact: true })
      assert.equal(await modelLevel.count(), 0)
      const accept = previews.getByRole('button', { name: en ? 'Accept' : '接受', exact: true })
      assert.equal(await accept.isDisabled(), true)
      await page.evaluate(() => document.fonts.ready)
      const fits = async () => {
        const fit = await previews.evaluate(el => ({ right: el.getBoundingClientRect().right, scroll: el.scrollWidth, client: el.clientWidth, viewport: innerWidth }))
        assert.ok(fit.right <= fit.viewport + 1 && fit.scroll <= fit.client + 1, JSON.stringify(fit))
      }
      await fits()
      await previews.screenshot({ path: `${shots}/${locale}-${theme}-${width}-unchosen.png` })
      // First level: a configuration. Nothing is saved yet, and the card still cannot be accepted.
      await configLevel.click()
      await page.getByRole('option', { name: en ? 'Project Assistant (Assistant) · Team provider' : 'Project Assistant（系统助手） · Team provider' }).click()
      await modelLevel.waitFor()
      assert.equal(await accept.isDisabled(), true)
      await fits()
      await previews.screenshot({ path: `${shots}/${locale}-${theme}-${width}-configuration.png` })
      // Second level: its model, saved on the card; then it can be accepted.
      await modelLevel.click()
      await page.getByRole('option', { name: 'provider-large-2026', exact: true }).click()
      await previews.getByText(/Project Assistant on provider-large-2026 \(Team provider\)/).waitFor()
      await page.waitForFunction(() => { const b = [...document.querySelectorAll('[data-testid="previews-message-apps"] button')].find(x => /^(Accept|接受)$/.test(x.textContent?.trim() ?? '')); return b && !b.disabled })
      await fits()
      await previews.screenshot({ path: `${shots}/${locale}-${theme}-${width}-chosen.png` })
      await page.screenshot({ path: `${shots}/${locale}-${theme}-${width}-room.png` })
      // Another configuration clears the model shown and blocks accepting again.
      await configLevel.click()
      await page.getByRole('option', { name: 'Writer · My laptop' }).click()
      assert.match((await modelLevel.textContent()) ?? '', en ? /Choose a model/ : /选择模型/)
      assert.equal(await accept.isDisabled(), true)
      // Its further models are counted and reachable from here.
      await box.getByText(en ? '3 more models of this runtime are not shown yet.' : '该运行配置另有 3 个模型尚未显示。', { exact: true }).waitFor()
      await box.getByRole('button', { name: en ? 'Show more models' : '显示更多模型', exact: true }).waitFor()
      await fits()
      await previews.screenshot({ path: `${shots}/${locale}-${theme}-${width}-switched.png` })
      assert.deepEqual(posts.filter(path => path !== '/me/agent-attention/views'), ['/actions/source.gmail.application_updates.select_execution'])
    } finally { await page.close() }
  }
})

test('Proposal detail and the private Agent chat offer the application-update choice to its owner only, on standalone and combined cards', async () => {
  const shots = process.env.ROOM_LAYOUT_SHOTS ?? '/tmp/rainver-proposal-gmail-execution-shots'
  mkdirSync(shots, { recursive: true })
  const summary = 'Mailbox layout@example.test: in the background, Project Assistant on provider-large-2026 (Team provider) checks new inbox and sent mail from acceptance and records facts on the matching application — interviews, deadlines and correspondence.'
  // What GET /proposals/:id returns for a strict Gmail card: no owner in its payload, so owner_user_id is the row's own.
  const dto = (id, proposalType, owner) => ({
    id, space_id: room.space_id, user_id: owner, project_folder_id: null, source_session_id: null, source_task_id: null, source_run_id: 'run-apps',
    created_by_run_id: 'run-apps', proposal_type: proposalType, target_scope: '', target_namespace: '', memory_type: '',
    proposed_title: proposalType === 'gmail_setup' ? 'Gmail for this Project · layout@example.test' : 'Automatic application updates from Gmail · layout@example.test',
    title_parts: null, proposed_content: '', rationale: '', status: 'pending', risk_level: 'high', urgency: 'normal', visibility: 'private', preview: false,
    review_deadline: null, expires_at: null, expired: false, created_at: now, decided_at: null, resulting_memory_id: null, owner_user_id: owner,
    subject_user_id: null, sensitivity_level: null, access_level: null, provenance_entries: null, source_activity_id: null, grant_id: null,
    required_approver_user_id: null, required_approver_user_ids: null, requires_approval_type: null, egress_approval_status: null, egress_approval_id: null,
    project_id: project.id, target_memory_id: null, chosen_on_card: true,
  })
  const options = id => ({ status: 'succeeded', data: { proposal_id: id, applies: true, selected: { agent_id: 'assistant', runtime_profile_id: 'profile-provider', model: 'provider-large-2026' },
    summary, next_cursor: null, card_revision: 'c'.repeat(64),
    scope: { mailbox_email: 'layout@example.test', include_sent: true, effects: ['interview', 'deadline', 'contact'], results_to: 'private', room_title: null, reader_names: [], reader_count: 0 },
    configurations: [{ agent_id: 'assistant', agent_name: 'Project Assistant', agent_kind: 'system_assistant', runtime_profile_id: 'profile-provider', profile_name: 'Team provider',
      runtime_key: 'opencode', backend_mode: 'model_provider', available: true, reason: null, models: [{ model: 'provider-large-2026', name: null }], omitted_models: 0, models_cursor: null }] } })
  const cards = { 'card-apps': dto('card-apps', 'gmail_digest_create', 'user-layout'), 'card-setup': dto('card-setup', 'gmail_setup', 'user-layout'),
    'card-other': dto('card-other', 'gmail_digest_create', 'user-other') }
  const chatSession = { ...session, id: 'session-private', room_id: null, title: 'Private chat' }
  const chatCard = { action_id: 'source.gmail.application_updates.propose', proposal_id: 'card-apps', proposal_type: 'gmail_digest_create', status: 'proposed',
    title: cards['card-apps'].proposed_title, summary, risk_level: 'high', decidable_by_user_id: 'user-layout', scope: { project_id: project.id } }
  const chatReply = { ...message, id: 'message-private-apps', session_id: chatSession.id, sender_agent_id: 'agent-layout', content: 'I drafted the card for automatic application updates.',
    metadata_json: { action_previews: [chatCard] } }
  const agent = { id: 'agent-layout', space_id: room.space_id, name: 'Layout Agent', agent_kind: 'standard', status: 'active', description: null, created_at: now, updated_at: now }
  const fits = async locator => {
    const fit = await locator.evaluate(el => ({ right: el.getBoundingClientRect().right, scroll: el.scrollWidth, client: el.clientWidth, viewport: innerWidth }))
    assert.ok(fit.right <= fit.viewport + 1 && fit.scroll <= fit.client + 1, JSON.stringify(fit))
  }
  for (const [width, locale, theme] of [[1280, 'en', 'light'], [390, 'zh-CN', 'dark']]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, serviceWorkers: 'block' })
    const en = locale === 'en'
    try {
      await page.addInitScript(([locale, theme]) => {
        localStorage.setItem('rainver:locale', locale)
        localStorage.setItem('rainver:theme', theme)
      }, [locale, theme])
      await mockApi(page)
      const queried = []
      await page.route('**/api/v1/**', async route => {
        const url = new URL(route.request().url()), path = url.pathname.replace('/api/v1', '')
        const card = path.startsWith('/proposals/') ? cards[path.slice('/proposals/'.length)] : null
        if (card) return route.fulfill({ json: card })
        if (path === '/queries/source.gmail.application_updates.execution_options') {
          const id = JSON.parse(url.searchParams.get('input') ?? '{}').proposal_id
          queried.push(id)
          return route.fulfill({ json: options(id) })
        }
        if (path === `/agents/${agent.id}`) return route.fulfill({ json: agent })
        if (path === `/projects/${project.id}/agents/${agent.id}`) return route.fulfill({ json: { agent_id: agent.id, project_id: project.id, status: 'active' } })
        if (path === `/sessions/${chatSession.id}/messages`) return route.fulfill({ json: [chatReply] })
        if (path === `/sessions/${chatSession.id}`) return route.fulfill({ json: chatSession })
        if (path.startsWith(`/agents/${agent.id}/conversation-backends`)) return route.fulfill({ json: { options: [], selected_runtime_profile_id: null, session_config: [] } })
        if (path === '/hosts') return route.fulfill({ json: { items: [] } })
        return route.fallback()
      })
      for (const id of ['card-apps', 'card-setup']) {
        await page.goto(`${baseUrl}/spaces/${room.space_id}/proposals/${id}`)
        const box = page.getByTestId('gmail-application-execution')
        await box.waitFor()
        await page.getByText(summary).first().waitFor()
        await box.getByText(en ? /application email correspondence/ : /申请邮件联络记录/).waitFor()
        // The same control as in conversation: the saved choice is echoed on both levels.
        assert.match((await box.getByRole('button', { name: en ? 'Agent and runtime' : 'Agent 与运行配置', exact: true }).textContent()) ?? '', /Project Assistant.*Team provider/)
        assert.match((await box.getByRole('button', { name: en ? 'Model' : '模型', exact: true }).textContent()) ?? '', /provider-large-2026/)
        await page.waitForFunction(() => { const b = [...document.querySelectorAll('button')].find(x => /^(Accept|接受)$/.test(x.textContent?.trim() ?? '')); return b && !b.disabled })
        await page.evaluate(() => document.fonts.ready)
        await fits(page.locator('main').first())
        await page.screenshot({ path: `${shots}/${locale}-${theme}-${width}-detail-${id}.png`, animations: 'disabled', fullPage: true })
      }
      await page.goto(`${baseUrl}/spaces/${room.space_id}/proposals/card-other`)
      await page.getByText(en ? /Only the mailbox owner chooses the Agent and model/ : /只有邮箱所有者/).waitFor()
      assert.equal(await page.getByTestId('gmail-application-execution').count(), 0)
      // The detail page's decision buttons are not translated yet.
      assert.equal(await page.getByRole('button', { name: 'Accept', exact: true }).isDisabled(), true)
      await page.screenshot({ path: `${shots}/${locale}-${theme}-${width}-detail-not-owner.png`, animations: 'disabled', fullPage: true })
      assert.deepEqual(queried, ['card-apps', 'card-setup'])
      await page.goto(`${baseUrl}/spaces/${room.space_id}/projects/${project.id}/agents/${agent.id}/chat?session=${chatSession.id}`)
      await page.getByText('I drafted the card for automatic application updates.').waitFor()
      const chatBox = page.getByTestId('gmail-application-execution')
      await chatBox.waitFor()
      await chatBox.getByText(en ? /application email correspondence/ : /申请邮件联络记录/).waitFor()
      await page.waitForFunction(() => { const b = [...document.querySelectorAll('[data-testid="gmail-application-execution"]')].length && [...document.querySelectorAll('button')].find(x => /^(Accept|接受)$/.test(x.textContent?.trim() ?? '')); return b && !b.disabled })
      await page.evaluate(() => document.fonts.ready)
      await fits(chatBox)
      await page.screenshot({ path: `${shots}/${locale}-${theme}-${width}-private-chat.png`, animations: 'disabled' })
    } finally { await page.close() }
  }
})

test('Room fills the desktop area and scrolls long conversation lists internally', async () => {
  const shots = process.env.ROOM_LAYOUT_SHOTS ?? '/tmp/rainver-room-height-shots'
  mkdirSync(shots, { recursive: true })
  for (const [locale, theme] of [['en', 'light'], ['zh-CN', 'dark']]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, serviceWorkers: 'block' })
    try {
      await page.addInitScript(([locale, theme]) => {
        localStorage.setItem('rainver:locale', locale)
        localStorage.setItem('rainver:theme', theme)
      }, [locale, theme])
      await mockApi(page, [session, ...Array.from({ length: 80 }, (_, i) => ({ ...session, id: `extra-${i}`, title: `Conversation ${i}` }))])
      await page.goto(`${baseUrl}/spaces/${room.space_id}/projects/${project.id}/rooms?room=${room.id}`)
      await page.getByRole('navigation', { name: locale === 'en' ? 'Conversations' : '对话' }).getByRole('button').first().waitFor()
      await page.screenshot({ path: `${shots}/${locale}-${theme}-entry.png` })
      await page.getByRole('navigation', { name: locale === 'en' ? 'Conversations' : '对话' }).getByRole('button').first().click()
      await page.locator('[data-role="agent"] li').first().waitFor()
      for (const [width, height] of [[1024, 800], [1280, 1000], [1920, 1400]]) {
        await page.setViewportSize({ width, height })
        await page.evaluate(() => document.fonts.ready)
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        const nav = page.getByRole('navigation', { name: 'Conversations', exact: true })
        const metrics = await nav.evaluate(el => {
          const area = document.querySelector('[data-project-area-content]')
          const chat = document.querySelector('main[aria-label="Conversation"]')
          const card = chat.firstElementChild
          return { areaBottom: area.getBoundingClientRect().bottom, chatBottom: card.getBoundingClientRect().bottom,
            navBottom: el.getBoundingClientRect().bottom, chatHeight: card.clientHeight,
            client: el.clientHeight, scroll: el.scrollHeight, areaClient: area.clientHeight, areaScroll: area.scrollHeight,
            documentHeight: document.documentElement.scrollHeight, viewport: innerHeight }
        })
        assert.ok(metrics.scroll > metrics.client + 100, JSON.stringify(metrics))
        assert.ok(metrics.areaBottom - metrics.chatBottom >= 0 && metrics.areaBottom - metrics.chatBottom <= 24, JSON.stringify(metrics))
        assert.ok(metrics.navBottom <= metrics.chatBottom + 1, JSON.stringify(metrics))
        if (width >= 1280) assert.ok(metrics.chatBottom - metrics.navBottom <= 12, JSON.stringify(metrics))
        assert.ok(metrics.areaScroll <= metrics.areaClient + 1, JSON.stringify(metrics))
        assert.ok(metrics.documentHeight <= metrics.viewport + 1, JSON.stringify(metrics))
        if (height === 1400) assert.ok(metrics.chatHeight > 1000, JSON.stringify(metrics))
        await nav.evaluate(el => { el.scrollTop = el.scrollHeight })
        assert.ok(await nav.evaluate(el => el.scrollTop > 0))
        await nav.getByRole('button').last().scrollIntoViewIfNeeded()
        await page.screenshot({ path: `${shots}/${locale}-${theme}-${width}.png` })
      }
      await page.setViewportSize({ width: 390, height: 900 })
      await page.locator('main[aria-label="Conversation"]').scrollIntoViewIfNeeded()
      await page.screenshot({ path: `${shots}/${locale}-${theme}-390.png` })
    } finally { await page.close() }
  }
})

for (const [width, locale, theme] of [[1280, 'en', 'dark'], [1280, 'zh-CN', 'light'], [390, 'en', 'light'], [390, 'zh-CN', 'dark']]) {
  test(`short Project sidecar keeps setup and message entry reachable (${width} ${locale} ${theme})`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 520 }, serviceWorkers: 'block' })
    try {
      await page.addInitScript(({ locale, theme }) => {
        localStorage.setItem('rainver:locale', locale)
        localStorage.setItem('rainver:theme', theme)
        localStorage.setItem('project.sidecar.project-layout.open', 'true')
      }, { locale, theme })
      await mockApi(page)
      await page.route('**/api/v1/projects/*/mainline-room', route => route.fulfill({ json: { room, viewer_can_write: true } }))
      await page.route('**/api/v1/sessions/*/execution-context', route => route.fulfill({ json: {
        summary: { session_id: session.id, state: 'uninitialized', host: null, runtime: null, primary: null,
          attachments: [], dispatch_locked: false, can_send: false, blocked_reason: null },
        available_hosts: [], available_runtime_profiles: [], available_primary_locations: [],
      } }))
      await page.goto(`${baseUrl}/spaces/${room.space_id}/projects/${project.id}/files`)
      if (width < 1024) await page.getByRole('button', { name: locale === 'en' ? 'Open Project chat' : '打开项目对话', exact: true }).click()
      const sidecar = page.getByTestId('project-chat-sidecar')
      const entry=sidecar.getByRole('button',{name:locale==='en'?/Conversation settings ·/:/对话设置 ·/})
      await entry.waitFor()
      const editor=sidecar.locator('[contenteditable="true"]').first()
      await editor.waitFor();await editor.fill('Keep this draft visible')
      await entry.click()
      const dialog=page.getByRole('dialog')
      await dialog.getByRole('tab',{name:locale==='en'?'Runtime environment':'运行环境'}).click()
      const confirm=dialog.getByRole('button',{name:locale==='en'?'Confirm execution context':'确认执行上下文',exact:true})
      await confirm.scrollIntoViewIfNeeded()
      const box=await confirm.boundingBox();assert.ok(box.y>=0&&box.y+box.height<=520)
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'hidden' })
      await editor.fill('Keep this draft visible')
      await editor.press('Tab')
      assert.equal(await editor.textContent(), 'Keep this draft visible')
      await page.screenshot({ path: `/tmp/rainver-layout-shots/sidecar-short-${width}-${locale}-${theme}.png` })
    } finally { await page.close() }
  })
}

for (const [locale, theme] of [['en', 'dark'], ['zh-CN', 'light']]) {
  test(`Quota warning vertically centers content and dismissal (${locale} ${theme})`, async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, serviceWorkers: 'block' })
    try {
      await page.addInitScript(([locale, theme]) => {
        localStorage.setItem('rainver:locale', locale)
        localStorage.setItem('rainver:theme', theme)
      }, [locale, theme])
      await mockApi(page)
      await page.route('**/quota', route => route.fulfill({ json: { warn_pct: 70, reserve_pct: 100, holds: [], logins: [{
        account_label: 'Codex CLI · server-desktop-test', login_key: 'layout-quota',
        window: { kind: 'week', utilization: 70, resets_at: new Date(Date.now() + 3_600_000).toISOString() },
        checked_at: new Date().toISOString(),
      }] } }))
      await page.goto(`${baseUrl}/spaces/${room.space_id}/projects/${project.id}/rooms?room=${room.id}&conversation=${session.id}`)
      const warning = page.getByTestId('conversation-quota-line')
      await warning.waitFor()
      for (const width of [1920, 1280, 390]) {
        await page.setViewportSize({ width, height: 1000 })
        await page.evaluate(() => document.fonts.ready)
        await warning.scrollIntoViewIfNeeded()
        const geometry = await warning.evaluate(el => {
          const content = el.firstElementChild.getBoundingClientRect()
          const close = el.querySelector('button').getBoundingClientRect()
          return { delta: Math.abs((content.top + content.bottom - close.top - close.bottom) / 2),
            fits: el.scrollWidth <= el.clientWidth + 1 }
        })
        assert.ok(geometry.delta <= 1, JSON.stringify({ width, ...geometry }))
        assert.ok(geometry.fits, 'wrapped warning fits its parent surface')
        await page.screenshot({ path: `/tmp/quota-center-${locale}-${theme}-${width}.png` })
      }
      await warning.getByRole('button').click()
      await warning.waitFor({ state: 'detached' })
    } finally { await page.close() }
  })
}

test('Conversation settings unify Room sidecar and Agent Work with strict HTTP and bounded scrolling', async () => {
  const shots='/tmp/rainver-conversation-settings';mkdirSync(shots,{recursive:true})
  for(const locale of ['en','zh-CN'])for(const theme of ['dark','light'])for(const width of [390,1280])for(const surface of ['Room','Sidecar','Agent Work']){
    const page=await browser.newPage({viewport:{width,height:900},serviceWorkers:'block'})
    try{
      await page.addInitScript(({locale,theme})=>{localStorage.setItem('rainver:locale',locale);localStorage.setItem('rainver:theme',theme);localStorage.setItem('project.sidecar.project-layout.open','true')},{locale,theme})
      await mockApi(page)
      const manager={agent_id:'agent-layout',agent_name:'Assistant',agent_kind:'system_assistant',role:'manager',status:'active'}
      const optional={agent_id:'specialist-layout',agent_name:'Codex',agent_kind:'standard',role:'member',status:'active'}
      const members=[manager,...Array.from({length:24},(_,i)=>({agent_id:'joined-'+i,agent_name:'Participant '+String(i).padStart(2,'0'),agent_kind:'standard',role:'member',status:'active'})),optional]
      const runtime={agent_id:manager.agent_id,runtime_profile_id:'runtime-layout',runtime_key:'claude_code',runtime_installation:'own',session_config:[{id:'model',type:'select',category:'model',value:'current-model'}]}
      let joined=false,retained=false,saves=0,refuseNext=true,revision=1,model='current-model',failRefresh=false,firstPreflight=true,offline=false,showAttachment=false
      let dispatchLocked = false
      let releasePreflight
      const initialPreflight=new Promise(resolve=>{releasePreflight=resolve})
      const detail={room,viewer_can_write:true,other_member_names:[],agent_count:members.length,agent_members:members,user_members:[]}
      const profiles=members.map(member=>({agent_id:member.agent_id,agent_name:member.agent_name,runtime_profile_id:member===manager?'runtime-layout':'profile-'+member.agent_id,runtime_key:'claude_code',runtime_installation:'own',execution_host_id:'host-layout',workspace_mode:'managed',workspace_location_id:null,preferred:true,usable:true,reason:null}))
      await page.route('**/api/v1/**',async route=>{
        const path=new URL(route.request().url()).pathname.replace('/api/v1','')
        if(path==='/skills/available')return route.fulfill({json:[{kind:'skill',skill_package_id:'skill-audit',package_hash:'a'.repeat(64),display_name:'Audit'}]})
        if(path===`/rooms/${room.id}`)return route.fulfill({json:detail})
        if(path.endsWith('/mainline-room'))return route.fulfill({json:{room,viewer_can_write:true}})
        if(path.endsWith('/retrieval'))return route.fulfill({json:{enabled:false,preferred_domains:[]}})
        if(path.endsWith('/messages'))return route.fulfill({json:{...pageOf([]),queued:[]}})
        if(path.endsWith('/execution-context')){
          if(firstPreflight){firstPreflight=false;await initialPreflight}
          if(failRefresh){failRefresh=false;return route.fulfill({status:503,json:{detail:'Synthetic preflight outage'}})}
          return route.fulfill({json:{summary:{participant_agent_ids:[...members.filter(m=>m!==optional).map(m=>m.agent_id),'hidden-layout',...(joined?[optional.agent_id]:[])],participants_revision:String(revision),session_id:session.id,state:'initialized',host:{host_id:'host-layout',host_name:'Laptop',host_kind:'remote',online:!offline,managed_workspace_available:true,daemon_last_heartbeat_at:now},runtime:joined?{...runtime,agent_id:optional.agent_id,runtime_profile_id:profiles.at(-1).runtime_profile_id}:runtime,runtimes:profiles.filter(p=>p.agent_id!==optional.agent_id||joined).map(p=>({...runtime,...p,session_config:p.agent_id===manager.agent_id?[{id:'model',type:'select',category:'model',value:model}]:[]})),primary:{kind:'managed',managed_workspace_id:session.id,display_path:null},attachments:showAttachment?[{id:'attachment-layout',workspace_location_id:'docs-layout',folder_name:'Shared docs',display_path:'/work/shared/research-documents',access_mode:'read',status:'active'}]:[],dispatch_locked:dispatchLocked,queue_paused_at:null,can_send:!offline,blocked_reason:offline?'Device offline':null},available_hosts:[],available_runtime_profiles:profiles.map(p=>({...p,retained_binding:p.agent_id===optional.agent_id?retained:true})),available_primary_locations:[]}})
        }
        if(path.endsWith('/conversation-backends')){
          const id=path.split('/')[2],p=profiles.find(p=>p.agent_id===id)
          const config=(id===manager.agent_id||id==='joined-0')?[{id:'model',name:'Model',description:null,type:'select',category:'model',current_value:'current-model',options:[{value:'current-model',name:'Gemini 4 Pro Preview'},...Array.from({length:6},(_,i)=>({value:'middle-'+i,name:'Middle model '+i})),{value:'next-model',name:'Next model'}]}]:[]
          return route.fulfill({json:{options:[{...p,name:'CLI',session_config_options:config}],binding:{...runtime,...p},session_config:id===manager.agent_id?[{id:'model',type:'select',category:'model',value:model}]:[]}})
        }
        if(path==='/actions/conversation.execution.initialize'){
          const body=route.request().postDataJSON();SESSION_OPERATION_SCHEMAS['conversation.execution.initialize'].input.parse(body)
          assert.equal(body.participants_revision,String(revision));assert.equal(body.runtime.agent_id,manager.agent_id)
          assert.deepEqual(Object.keys(body.runtime).sort(),['agent_id','runtime_installation','runtime_key','runtime_profile_id'])
          assert.deepEqual(body.participant_changes,[{agent_id:optional.agent_id,participating:!joined}]);assert.equal(body.additional_runtimes.length,!joined&&!retained?1:0);assert.equal(body.participant_agent_ids,undefined)
          if(refuseNext){refuseNext=false;revision++;return route.fulfill({status:409,json:{detail:'Participants changed; refresh and retry your selection'}})}
          joined=!joined;retained=true;revision++;saves++
          return route.fulfill({json:{status:'succeeded',data:{id:session.id,session_id:session.id,space_id:room.space_id}}})
        }
        if(path==='/actions/conversation.session_config.save'){
          const body=route.request().postDataJSON();AGENT_OPERATION_SCHEMAS['conversation.session_config.save'].input.parse(body)
          assert.equal(body.allow_quota_model_switch,undefined)
          model=body.session_config.find(s=>s.category==='model').value
          return route.fulfill({json:{status:'succeeded',data:{id:session.id,session_id:session.id,space_id:room.space_id}}})
        }
        return route.fallback()
      })
      const path=surface==='Room'?`/spaces/${room.space_id}/projects/${project.id}/rooms?room=${room.id}&conversation=${session.id}`:surface==='Sidecar'?`/spaces/${room.space_id}/projects/${project.id}/files`:'/agent-work'
      await page.goto(baseUrl+path)
      if(surface==='Sidecar' && width<1024) await page.getByRole('button',{name:locale==='en'?'Open Project chat':'打开项目对话',exact:true}).click()
      if(surface==='Agent Work')await page.locator('[data-work-row]').first().click()
      const unknownEntry=page.getByRole('button',{name:locale==='en'?'Conversation settings':'对话设置',exact:true})
      await unknownEntry.click()
      const loadingDialog=page.getByRole('dialog')
      await loadingDialog.getByRole('status').waitFor()
      assert.equal(await loadingDialog.getByRole('button',{name:locale==='en'?'Add Agent from Room':'从Room添加Agent',exact:true}).count(),0)
      await page.screenshot({animations:'disabled',path:`${shots}/${surface}-${locale}-${theme}-${width}-loading.png`})
      releasePreflight()
      await loadingDialog.getByRole('button',{name:locale==='en'?'Add Agent from Room':'从Room添加Agent',exact:true}).waitFor()
      await page.keyboard.press('Escape')
      const entry=page.getByRole('button',{name:locale==='en'?'Conversation settings · 26':'对话设置 · 26',exact:true})
      await entry.waitFor()
      const editor=page.locator('[contenteditable="true"]').first()
      await editor.fill('@Ass')
      await page.getByRole('option',{name:'@Assistant',exact:true}).click()
      assert.match(await editor.innerText(),/Assistant/)
      await editor.fill('/Au')
      const skillOption=page.getByRole('option').filter({hasText:'/Audit'})
      await skillOption.waitFor();await assertMenuUnclipped(page)
      assert.ok(await editor.evaluate(el=>el===document.activeElement),'autocomplete keeps typing focus')
      await page.screenshot({path:`${shots}/${surface}-${locale}-${theme}-${width}-skill-suggestions.png`,animations:'disabled'})
      await skillOption.click();assert.match(await editor.innerText(),/Audit/)
      await editor.fill('Keep this message draft')
      await entry.scrollIntoViewIfNeeded()
      await page.locator('[data-sonner-toast]').last().waitFor({state:'hidden'}).catch(()=>{})
      for(const control of [entry,page.getByRole('button',{name:locale==='en'?'Send':'发送',exact:true}).last()]) {
        const box=await control.boundingBox();assert.ok(box&&box.y>=0&&box.y+box.height<=900,JSON.stringify({surface,box}))
        assert.ok(await control.evaluate(el=>{const b=el.getBoundingClientRect();return el.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2))}),surface+' control is unobstructed')
      }
      await page.screenshot({animations:'disabled',path:`${shots}/${surface}-${locale}-${theme}-${width}-entry.png`})
      assert.equal(await page.getByTestId('execution-preflight-collapsed').count(),0)
      await entry.click()
      const dialog=page.getByRole('dialog'),add=dialog.getByRole('button',{name:locale==='en'?'Add Agent from Room':'从Room添加Agent',exact:true})
      await add.waitFor();assert.equal(await dialog.getByText('Codex',{exact:true}).count(),0)
      failRefresh=true
      await page.evaluate(()=>window.dispatchEvent(new Event('focus')))
      await dialog.getByRole('status').filter({hasText:'Synthetic preflight outage'}).waitFor()
      assert.equal(await dialog.getByRole('button',{name:locale==='en'?'Add Agent from Room':'从Room添加Agent',exact:true}).count(),0)
      await page.screenshot({animations:'disabled',path:`${shots}/${surface}-${locale}-${theme}-${width}-refresh-failure.png`})
      await dialog.getByRole('button',{name:locale==='en'?'Retry':'重试',exact:true}).click()
      await add.waitFor()

      await add.click({trial:true})
      for (const trigger of await dialog.getByRole('button', {name:'Model', exact:true}).all()) {
        assert.ok(await trigger.locator('span').evaluate(el=>el.scrollWidth<=el.clientWidth+1), 'selected model name must be fully visible')
      }
      await page.screenshot({animations:'disabled',path:`${shots}/${surface}-${locale}-${theme}-${width}-compact.png`})
      const firstAgent=dialog.locator('[data-agent-settings]').filter({has:page.getByText('Assistant',{exact:true})})
      dispatchLocked = true
      await page.evaluate(() => window.dispatchEvent(new Event('focus')))
      const switchNotice = dialog.getByText(locale === 'en' ? /Running and queued work keeps its model/ : /正在执行和已排队的工作沿用原模型/).first()
      await switchNotice.waitFor()
      assert.ok(await add.isDisabled())
      await firstAgent.getByRole('button', {name:'Model',exact:true}).click({trial:true})
      await page.screenshot({animations:'disabled',path:`${shots}/${surface}-${locale}-${theme}-${width}-running.png`})
      dispatchLocked = false
      await page.evaluate(() => window.dispatchEvent(new Event('focus')))
      await switchNotice.waitFor({state:'hidden'})
      const disclosure=firstAgent.getByRole('button',{name:/Other parameters|其他参数/})
      await firstAgent.getByText('Assistant',{exact:true}).click()
      assert.equal(await disclosure.getAttribute('aria-expanded'),'true')
      await firstAgent.getByText('Assistant',{exact:true}).click()
      assert.equal(await disclosure.getAttribute('aria-expanded'),'false')
      const rowBounds=await disclosure.boundingBox()
      await disclosure.click({position:{x:rowBounds.width-12,y:rowBounds.height/2}})
      assert.equal(await disclosure.getAttribute('aria-expanded'),'true')
      await firstAgent.getByText('Assistant',{exact:true}).click()
      assert.equal(await disclosure.getAttribute('aria-expanded'),'false')
      const list=dialog.locator('div.overflow-y-auto').first()
      assert.ok(await list.evaluate(el=>el.scrollHeight>el.clientHeight+100))
      await list.evaluate(el=>el.scrollTop=el.scrollHeight)
      assert.ok(await add.isVisible());await add.click()
      const search=dialog.getByRole('textbox');await search.fill('code')
      await dialog.getByRole('button',{name:'Codex',exact:true}).click()
      const save=dialog.getByRole('button',{name:locale==='en'?'Add to conversation':'加入对话',exact:true})
      await save.click();await dialog.getByRole('alert').filter({hasText:'Participants changed; refresh and retry your selection'}).waitFor();assert.equal(saves,0)
      await page.screenshot({animations:'disabled',path:`${shots}/${surface}-${locale}-${theme}-${width}-failure.png`})
      await dialog.getByRole('button',{name:locale==='en'?'Retry':'重试',exact:true}).click()
      await dialog.getByRole('button',{name:'Codex',exact:true}).click()
      await save.click();await save.waitFor({state:'hidden'});assert.equal(saves,1)
      const codex=dialog.locator('[data-agent-settings]').filter({has:page.getByText('Codex',{exact:true})})
      await codex.getByRole('button',{name:locale==='en'?'Remove':'移除',exact:true}).click();await codex.getByRole('button',{name:locale==='en'?'Confirm removal':'确认移出',exact:true}).click();await codex.waitFor({state:'hidden'});assert.equal(saves,2)
      await add.click();await search.fill('code');await dialog.getByRole('button',{name:'Codex',exact:true}).click();await save.click();await save.waitFor({state:'hidden'});assert.equal(saves,3)
      const other=dialog.locator('[data-agent-settings]').filter({has:page.getByText('Participant 00',{exact:true})})
      await other.getByRole('button',{name:/Other parameters|其他参数/}).press('Enter')
      await other.getByRole('checkbox').check()
      const assistant=dialog.locator('[data-agent-settings]').filter({has:page.getByText('Assistant',{exact:true})});await assistant.getByRole('button',{name:/Other parameters|其他参数/}).press('Enter')
      const scrollBefore = await list.evaluate(el=>({height:el.scrollHeight, top:el.scrollTop}))
      await assistant.getByRole('button',{name:'Model',exact:true}).click();await assert.equal(await list.evaluate(el=>el.scrollHeight),scrollBefore.height, 'opening model menu must not grow the dialog scroll area');await page.getByRole('option',{name:'Gemini 4 Pro Preview',exact:true}).click({trial:true});await assertMenuUnclipped(page);await page.screenshot({path:`${shots}/${surface}-${locale}-${theme}-${width}-eight-models.png`,animations:'disabled'});await page.getByRole('option',{name:'Next model',exact:true}).click()
      await assistant.getByRole('button',{name:'Model',exact:true}).filter({hasText:'Next model'}).waitFor();
      await assistant.getByRole('status').waitFor({state:'hidden'});assert.equal(model,'next-model')
      assert.equal(await other.getByRole('button',{name:'Model',exact:true}).textContent(),'Gemini 4 Pro Preview')
      await other.getByRole('status').filter({hasText:locale==='en'?'Not saved':'尚未保存'}).waitFor()
      await other.getByRole('button',{name:locale==='en'?'Discard changes':'放弃修改',exact:true}).click({trial:true})
      await page.screenshot({animations:'disabled',path:`${shots}/${surface}-${locale}-${theme}-${width}-agents.png`})
      await dialog.getByRole('tab',{name:locale==='en'?'Runtime environment':'运行环境',exact:true}).click()
      await dialog.getByText(locale==='en'?'Device':'设备',{exact:true}).waitFor()
      assert.equal(await dialog.getByText(locale==='en'?/Host and primary directory are fixed/:/初始化后Host和主目录固定/).count(),0)
      await dialog.getByRole('button',{name:locale==='en'?'Add folder':'添加目录',exact:true}).click({trial:true})
      await page.screenshot({animations:'disabled',path:`${shots}/${surface}-${locale}-${theme}-${width}-environment.png`})
      showAttachment=true;await page.evaluate(()=>window.dispatchEvent(new Event('focus')))
      await dialog.getByText(/Shared docs/).waitFor()
      const accessBadge=dialog.locator('span').filter({hasText:locale==='en'?/^Read only$/:/^只读$/})
      assert.ok(await accessBadge.isVisible())
      assert.ok(await accessBadge.evaluate(el=>el.scrollWidth<=el.clientWidth+1))
      await page.screenshot({animations:'disabled',path:`${shots}/${surface}-${locale}-${theme}-${width}-folders.png`})
      offline=true;await page.evaluate(()=>window.dispatchEvent(new Event('focus')))
      await dialog.getByText('Device offline',{exact:true}).waitFor()
      await page.screenshot({animations:'disabled',path:`${shots}/${surface}-${locale}-${theme}-${width}-offline.png`})
      offline=false;showAttachment=false;await page.evaluate(()=>window.dispatchEvent(new Event('focus')))
      await dialog.getByText('Device offline',{exact:true}).waitFor({state:'hidden'})
      assert.ok(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1))
      await page.keyboard.press('Escape');assert.equal(await editor.innerText(),'Keep this message draft')
      await page.getByRole('button',{name:locale==='en'?'Send':'发送',exact:true}).last().click()
      await dialog.waitFor()
      await dialog.getByRole('note').filter({hasText:locale==='en'?'Save or discard':'发送前请保存'}).waitFor()
      await dialog.getByRole('tab',{name:locale==='en'?'Agents':'Agent',exact:true}).click()
      await other.getByRole('button',{name:/Other parameters|其他参数/}).press('Enter')
      await other.getByRole('button',{name:locale==='en'?'Discard changes':'放弃修改',exact:true}).click()
      await other.getByRole('status').waitFor({state:'hidden'})
      await page.keyboard.press('Escape')
      assert.equal(await editor.innerText(),'Keep this message draft')
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1))
    }finally{await page.close()}
  }
})

test('Direct Agent settings keep failed drafts visible and guard sends across appearance variants', async () => {
  const shots = '/tmp/rainver-conversation-settings'; mkdirSync(shots, { recursive: true })
  for (const locale of ['en', 'zh-CN']) for (const theme of ['dark', 'light']) for (const width of [390, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, serviceWorkers: 'block' })
    try {
      await page.addInitScript(({locale,theme}) => { localStorage.setItem('rainver:locale',locale); localStorage.setItem('rainver:theme',theme) }, {locale,theme})
      await mockApi(page)
      let sends = 0, writes = 0, model = 'current', readFailures = 0
      await page.route('**/api/v1/**', async route => {
        const path = new URL(route.request().url()).pathname.replace('/api/v1','')
        if(path==='/skills/available')return route.fulfill({json:[{kind:'skill',skill_package_id:'skill-audit',package_hash:'a'.repeat(64),display_name:'Audit'}]})
        if (path === '/agents/agent-layout') return route.fulfill({json:{id:'agent-layout', space_id:room.space_id, name:'Assistant', status:'active', agent_kind:'system_assistant'}})
        if (path.endsWith('/conversation-backends')) {
          if(readFailures){readFailures--;return route.fulfill({status:503,json:{detail:'Synthetic read failure'}})}
          return route.fulfill({json:{
          options:[{runtime_profile_id:'runtime-layout', name:'CLI', runtime_key:'claude_code', usable:true,
            session_config_options:[{id:'model',name:'Model',type:'select',category:'model',current_value:'current',options:[{value:'current',name:'Gemini 4 Pro Preview'},...Array.from({length:6},(_,i)=>({value:'middle-'+i,name:'Middle model '+i})),{value:'next',name:'Next model'}]}]}],
          binding:{runtime_profile_id:'runtime-layout',runtime_key:'claude_code'},session_config:[{id:'model',type:'select',category:'model',value:model}],
        }})}
        if (path.endsWith('/retrieval')) return route.fulfill({json:{enabled:false,preferred_domains:[]}})
        if (path.endsWith('/messages')) return route.fulfill({json:[]})
        if (path === '/actions/conversation.session_config.save') {
          writes++;if(writes===1)return route.fulfill({status:503,json:{detail:'Synthetic save failure'}})
          assert.equal(route.request().postDataJSON().allow_quota_model_switch,undefined)
          model='next';readFailures=1
          return route.fulfill({json:{status:'succeeded',data:{id:session.id,session_id:session.id,space_id:room.space_id}}})
        }
        if (path.endsWith('/chat')) { sends++; return route.fulfill({status:500,json:{detail:'Must not send'}}) }
        return route.fallback()
      })
      await page.goto(`${baseUrl}/spaces/${room.space_id}/agents/agent-layout/chat?session=${session.id}`)
      const entry = page.getByRole('button',{name:locale==='en'?'Conversation settings · 1':'对话设置 · 1',exact:true})
      await entry.waitFor()
      const skillInput=page.locator('textarea').last()
      await skillInput.fill('/Au')
      const skillOption=page.getByRole('option').filter({hasText:'/Audit'})
      await skillOption.waitFor();await assertMenuUnclipped(page)
      assert.ok(await skillInput.evaluate(el=>el===document.activeElement),'plain composer keeps typing focus')
      await page.screenshot({path:`${shots}/Direct-${locale}-${theme}-${width}-skill-suggestions.png`,animations:'disabled'})
      await skillOption.click();assert.match(await skillInput.inputValue(),/Audit/)
      await skillInput.fill('')
      await entry.click()
      const dialog = page.getByRole('dialog')
      await page.screenshot({path:`${shots}/Direct-${locale}-${theme}-${width}-normal.png`,animations:'disabled'})
      await dialog.getByRole('button',{name:'Model',exact:true}).click()
      await page.getByRole('option',{name:'Gemini 4 Pro Preview',exact:true}).click({trial:true})
      await assertMenuUnclipped(page)
      await page.screenshot({path:`${shots}/Direct-${locale}-${theme}-${width}-eight-models.png`,animations:'disabled'})
      await page.getByRole('option',{name:'Next model',exact:true}).click()
      await dialog.getByRole('alert').filter({hasText:'Synthetic save failure'}).waitFor()
      await page.screenshot({path:`${shots}/Direct-${locale}-${theme}-${width}-failed.png`,animations:'disabled'})
      await page.keyboard.press('Escape')
      const input = page.locator('textarea').last(); await input.fill('Keep direct message')
      await page.screenshot({path:`${shots}/Direct-${locale}-${theme}-${width}-entry.png`,animations:'disabled'})
      await page.getByRole('button',{name:locale==='en'?'Send':'发送',exact:true}).click()
      await dialog.getByRole('note').filter({hasText:locale==='en'?'Save or discard':'发送前请保存'}).waitFor()
      assert.equal(sends,0)
      await dialog.getByRole('button',{name:locale==='en'?'Retry':'重试',exact:true}).click()
      const refresh=dialog.getByRole('button',{name:locale==='en'?'Refresh saved settings':'重新读取已保存设置',exact:true})
      await refresh.waitFor()
      await page.screenshot({path:`${shots}/Direct-${locale}-${theme}-${width}-read-failed.png`,animations:'disabled'})
      await refresh.click()
      await dialog.getByRole('alert').waitFor({state:'hidden'})
      assert.equal(writes,2)
      assert.equal(await dialog.getByRole('button',{name:'Model',exact:true}).textContent(),'Next model')
      await page.keyboard.press('Escape')
      assert.equal(await input.inputValue(),'Keep direct message')
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1))
    } finally { await page.close() }
  }
})

test('Direct first-message drafts become the accepted baseline and allow the second send', async () => {
  const page = await browser.newPage({viewport:{width:390,height:900},serviceWorkers:'block'})
  try {
    await page.addInitScript(() => localStorage.setItem('rainver:locale','en'))
    await mockApi(page)
    let sends = 0, saved = [], reads = 0
    const options = [
      {id:'model',name:'Model',type:'select',category:'model',current_value:'current',options:[{value:'current',name:'Gemini 4 Pro Preview'},{value:'next',name:'Next model'}]},
      {id:'fast',name:'Fast mode',type:'boolean',category:'model_config',current_value:false},
    ]
    await page.route('**/api/v1/**', async route => {
      const path = new URL(route.request().url()).pathname.replace('/api/v1','')
      if(path==='/agents/agent-layout')return route.fulfill({json:{id:'agent-layout',space_id:room.space_id,name:'Assistant',status:'active',agent_kind:'system_assistant'}})
      if(path.endsWith('/conversation-backends')) { reads++; return route.fulfill({json:{options:[{runtime_profile_id:'runtime-layout',name:'CLI',runtime_key:'claude_code',usable:true,session_config_options:options}],binding:{runtime_profile_id:'runtime-layout',runtime_key:'claude_code'},session_config:saved}}) }
      if(path.endsWith('/retrieval'))return route.fulfill({json:{enabled:false,preferred_domains:[]}})
      if(path.endsWith('/messages'))return route.fulfill({json:[]})
      if(path==='/actions/conversation.session_config.save')throw new Error('First drafts must use first send')
      if(path==='/actions/agent.chat.send') {
        sends++
        const body=route.request().postDataJSON()
        if(sends===1){assert.equal(body.session_id,undefined);saved=body.session_config;assert.equal(saved.find(s=>s.id==='model').value,'next');assert.equal(saved.find(s=>s.id==='fast').value,true)}
        else {assert.equal(body.session_id,session.id);assert.equal(body.session_config,undefined)}
        return route.fulfill({status:202,json:{status:'succeeded',data:{space_id:room.space_id,schema_version:'chat_turn_accepted.v1',session_id:session.id,run_id:'first-draft-run',user_message_id:'first-draft-message',status:'queued',event_stream_url:'/api/v1/runs/first-draft-run/turn/stream',backend:{runtime_profile_id:'runtime-layout',runtime_key:'claude_code'}}}})
      }
      if(path==='/runs/first-draft-run/turn/stream')return route.fulfill({contentType:'text/event-stream',body:'event: server.error\ndata: {"message":"Synthetic disconnect after acceptance"}\n\n'})
      return route.fallback()
    })
    await page.goto(`${baseUrl}/spaces/${room.space_id}/agents/agent-layout/chat`)
    await page.getByRole('button',{name:'Conversation settings · 1',exact:true}).click()
    const dialog=page.getByRole('dialog')
    await dialog.getByRole('button',{name:'Model',exact:true}).click()
    await page.getByRole('option',{name:'Next model',exact:true}).click()
    await page.getByRole('listbox').waitFor({state:'hidden'})
    await dialog.getByRole('switch',{name:'Fast mode'}).click()
    await page.keyboard.press('Escape')
    const input=page.locator('textarea').last()
    await input.fill('First message');await page.getByRole('button',{name:'Send',exact:true}).click()
    await page.waitForURL('**?session='+session.id)
    await input.fill('Second message')
    const send=page.getByRole('button',{name:'Send',exact:true})
    await send.click()
    await page.waitForFunction(()=>document.querySelector('textarea')?.value==='')
    assert.equal(sends,2);assert.ok(reads>=2)
    assert.equal(await dialog.count(),0)
  } finally {await page.close()}
})

test('Project mobile full viewport preserves one transcript, Room drawer history and viewport recovery', async () => {
  const shots = process.env.MOBILE_CONVERSATION_SHOTS ?? '/tmp/rainver-mobile-conversation'; mkdirSync(shots, { recursive: true })
  for (const locale of ['en', 'zh-CN']) for (const theme of ['dark', 'light']) {
    const page = await browser.newPage({ viewport: { width: 402, height: 812 }, serviceWorkers: 'block' })
    try {
      await page.addInitScript(({locale,theme}) => {
        localStorage.setItem('rainver:locale',locale); localStorage.setItem('rainver:theme',theme)
      }, {locale,theme})
      await mockApi(page, [session, {...session,id:'other-layout',title:'Other conversation',is_running:true}])
      await page.goto(baseUrl + '/home')
      await page.getByRole('navigation',{name:locale==='en'?'Primary':'主导航',exact:true}).waitFor()
      await page.waitForFunction(() => document.querySelector('.page-dashboard') && !document.querySelector('.page-dashboard .animate-pulse'))
      await page.screenshot({animations:'disabled',path:`${shots}/${locale}-${theme}-home.png`})
      await page.goto(`${baseUrl}/spaces/${room.space_id}/projects/${project.id}/rooms?room=${room.id}`)
      const list = page.getByRole('navigation',{name:locale==='en'?'Conversations':'对话',exact:true})
      await list.getByRole('button').first().waitFor()
      await page.screenshot({animations:'disabled',path:`${shots}/${locale}-${theme}-entry.png`})
      await list.getByRole('button').first().click()
      const log = page.getByRole('log',{name:locale==='en'?'Conversation messages':'对话消息',exact:true})
      await log.locator('[data-role="agent"]').first().waitFor()
      await log.evaluate(el => { el.dataset.lifetime = 'same' })
      for (const [width,height] of [[390,844],[402,812],[844,390],[402,812],[1280,900],[402,812]]) {
        await page.setViewportSize({width,height})
        await page.waitForFunction(({width,height}) => document.documentElement.hasAttribute('data-mobile-conversation') === (width < 1024) && (width >= 1024 || Math.abs(document.querySelector('.app-safe-shell').getBoundingClientRect().height-height)<2), {width,height})
        assert.equal(await log.count(),1)
        assert.equal(await log.getAttribute('data-lifetime'),'same','breakpoint must retain transcript lifetime')
        const metrics = await page.evaluate(() => {
          const rect = document.querySelector('.conversation-card').getBoundingClientRect()
          return { top:rect.top,bottom:rect.bottom,height:rect.height,doc:document.documentElement.scrollHeight,inner:innerHeight,visual:visualViewport.height,css:document.documentElement.style.getPropertyValue('--conversation-visual-height'),width:document.documentElement.scrollWidth,focused:document.documentElement.hasAttribute('data-mobile-conversation') }
        })
        assert.equal(metrics.focused,width<1024)
        assert.ok(metrics.doc<=height+1 && metrics.width<=width+1,JSON.stringify(metrics))
        if(width<1024) { assert.ok(metrics.top<100 && Math.abs(metrics.bottom-height)<2,JSON.stringify(metrics)) }
        await page.screenshot({animations:'disabled',path:`${shots}/${locale}-${theme}-${width}-${height}.png`})
      }
      const drawerButton = page.getByRole('button',{name:locale==='en'?'Conversations and Room details':'对话与 Room 详情',exact:true})
      await drawerButton.click()
      const dialog=page.getByRole('dialog'); await dialog.waitFor()
      const drawerBox=await dialog.boundingBox()
      assert.ok(drawerBox.x>=0 && drawerBox.y>=0 && drawerBox.x+drawerBox.width<=403 && drawerBox.y+drawerBox.height<=813,JSON.stringify(drawerBox))
      await dialog.getByRole('textbox').fill('Other')
      assert.equal(await dialog.getByRole('button',{name:/Other conversation/}).count(),1)
      await page.screenshot({animations:'disabled',path:`${shots}/${locale}-${theme}-drawer.png`})
      await page.goBack()
      await dialog.waitFor({state:'hidden'})
      await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label')?.includes('Room'))
      assert.equal(await log.getAttribute('data-lifetime'),'same')
      await page.evaluate(() => {
        for (const [edge,value] of Object.entries({top:62,bottom:34,left:12,right:12})) document.documentElement.style.setProperty(`--app-safe-${edge}`,`${value}px`)
        Object.defineProperties(visualViewport,{height:{configurable:true,value:350},offsetTop:{configurable:true,value:24},scale:{configurable:true,value:1}})
        visualViewport.dispatchEvent(new Event('resize'))
        visualViewport.dispatchEvent(new Event('scroll'))
      })
      const keyboard = await page.locator('.app-safe-shell').boundingBox()
      assert.ok(Math.abs(keyboard.y-24)<1 && Math.abs(keyboard.height-350)<1,JSON.stringify(keyboard))
      const card = await page.locator('.conversation-card').boundingBox()
      assert.ok(card.y>=86 && card.y+card.height<=375,JSON.stringify(card))
      const send=await page.getByRole('button',{name:locale==='en'?'Send':'发送',exact:true}).boundingBox()
      assert.ok(send.y>=card.y && send.y+send.height<=card.y+card.height+1,JSON.stringify({send,card}))
      await page.screenshot({animations:'disabled',path:`${shots}/${locale}-${theme}-keyboard-insets.png`})
      await page.evaluate(() => {Object.defineProperty(visualViewport,'scale',{configurable:true,value:1.5});visualViewport.dispatchEvent(new Event('resize'))})
      const zoom = await page.locator('.app-safe-shell').boundingBox()
      assert.ok(Math.abs(zoom.y)<1 && Math.abs(zoom.height-812)<1,'pinch zoom is not keyboard compensation')
      await page.evaluate(() => {
        for(const key of ['height','offsetTop','scale']) delete visualViewport[key]
        visualViewport.dispatchEvent(new Event('resize'))
      })
      const restored=await page.locator('.conversation-card').boundingBox()
      assert.ok(restored.y>=62 && Math.abs(restored.y+restored.height-778)<2,JSON.stringify(restored))
      assert.equal(await log.getAttribute('data-lifetime'),'same')
      await page.screenshot({animations:'disabled',path:`${shots}/${locale}-${theme}-restored-insets.png`})
    } finally { await page.close() }
  }
})

for (const surface of ['Room','Sidecar']) test(`mobile ${surface} conversation selection restores its draft and reading position without duplicate transcripts`, async () => {
  const page=await browser.newPage({viewport:{width:402,height:812},serviceWorkers:'block'})
  try {
    await mockApi(page,[session,{...session,id:'other-layout',title:'Other conversation'}])
    await page.route('**/api/v1/**/messages*',route=>route.fulfill({json:{...pageOf(Array.from({length:30},(_,i)=>({...message,id:`reading-${i}`,content:`Reading ${i}\n\n${markdown}`}))),queued:[]}}))
    if(surface==='Sidecar') {
      await page.route('**/api/v1/projects/*/mainline-room',route=>route.fulfill({json:{room,viewer_can_write:false}}))
      await page.route(`**/api/v1/rooms/${room.id}`,async route=>{
        await new Promise(resolve=>setTimeout(resolve,300))
        await route.fulfill({json:{room,viewer_can_write:false,other_member_names:[],agent_count:0,agent_members:[],user_members:[]}})
      })
      await page.goto(`${baseUrl}/spaces/${room.space_id}/projects/${project.id}/files?projectChat=1`)
    } else {
      await page.goto(`${baseUrl}/spaces/${room.space_id}/projects/${project.id}/rooms?room=${room.id}&conversation=${session.id}`)
    }
    const log=page.getByRole('log',{name:'Conversation messages',exact:true})
    const scroller=log.locator('.overscroll-y-contain').first()
    await log.locator('[data-role="agent"]').first().waitFor()
    const editor=page.locator('[contenteditable="true"]').first()
    await editor.fill('Draft belongs to the first conversation')
    await scroller.evaluate(el=>{el.scrollTop=el.scrollHeight})
    const scrollBox=await scroller.boundingBox()
    await page.mouse.move(scrollBox.x+2,scrollBox.y+2)
    await page.mouse.wheel(0,-300)
    await page.waitForFunction(()=>{const el=document.querySelector('[role="log"] .overscroll-y-contain');return el.scrollHeight-el.clientHeight-el.scrollTop>100})
    await page.evaluate(()=>document.fonts.ready)
    await scroller.evaluate(el=>{el.scrollTop=150;el.dispatchEvent(new Event('scroll'))})
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
    const pick=async(name)=>{
      await page.getByRole('button',{name:'Conversations and Room details',exact:true}).click()
      await page.getByRole('dialog').getByRole('button',{name:new RegExp('^'+name)}).click()
      await page.getByRole('dialog').waitFor({state:'hidden'})
      await log.locator('[data-role="agent"]').first().waitFor()
    }
    await pick('Other conversation')
    assert.equal(await log.count(),1)
    assert.equal(await editor.textContent(),'')
    await editor.fill('Another draft')
    await pick('Conversation')
    await page.waitForFunction(()=>document.querySelector('[contenteditable="true"]')?.textContent==='Draft belongs to the first conversation')
    await page.waitForFunction(() => {
      const el = document.querySelector('[role="log"] .overscroll-y-contain')
      return el && el.scrollHeight - el.clientHeight - el.scrollTop < 2
    })
    assert.equal(await log.count(),1)
  } finally {await page.close()}
})

test('mobile whole-thread carry is reachable at 390 and 768 and desktop has one entry', async () => {
  for (const width of [390,768,1280]) for (const locale of ['en','zh-CN']) {
    const page=await browser.newPage({viewport:{width,height:900},serviceWorkers:'block'})
    try {
      await page.addInitScript(locale=>{localStorage.setItem('rainver:locale',locale);localStorage.setItem('rainver:theme',locale==='en'?'dark':'light')},locale)
      await mockApi(page)
      await page.goto(`${baseUrl}/spaces/${room.space_id}/projects/${project.id}/rooms?room=${room.id}&conversation=${session.id}`)
      await page.getByRole('log').locator('[data-role="agent"]').first().waitFor()
      const carryName=locale==='en'?'Carry into a new thread':'带入新的对话'
      if(width<1024) {
        await page.getByRole('button',{name:locale==='en'?'Conversations and Room details':'对话与 Room 详情',exact:true}).click()
        await page.getByRole('dialog').getByText(locale==='en'?'Everyone in this Project':'本项目所有成员',{exact:true}).waitFor()
      }
      const carry=page.getByRole('button',{name:carryName,exact:true})
      assert.equal(await carry.count(),1,'one accessible carry entry at each breakpoint')
      await carry.scrollIntoViewIfNeeded()
      await page.screenshot({path:`/tmp/review-carry-${locale}-${width}.png`,animations:'disabled'})
      await carry.click()
      await page.waitForURL(url=>url.searchParams.get('new')==='1'&&!url.searchParams.has('conversationDrawer'))
      await page.getByText(locale==='en'?'A conversation will be attached to this conversation before the message':'一个对话 将在发送消息前附加到此对话',{exact:true}).waitFor()
      assert.equal(await page.getByRole('log').count(),1)
      assert.equal(await page.getByRole('button',{name:carryName,exact:true}).count(),0,'draft has no whole-thread source')
      await page.screenshot({path:`/tmp/review-carry-${locale}-${width}-draft.png`,animations:'disabled'})
    } finally {await page.close()}
  }
})

test('mobile sidecar consumes owned history and preserves a closed desktop preference', async () => {
  const page=await browser.newPage({viewport:{width:390,height:844},serviceWorkers:'block'})
  try {
    await page.addInitScript(()=>{
      localStorage.setItem('rainver:locale','en')
      localStorage.setItem('project.sidecar.project-layout.open','false')
    })
    await mockApi(page,[session,{...session,id:'other-layout',title:'Other conversation'}])
    await page.route('**/api/v1/projects/*/mainline-room',route=>route.fulfill({json:{room,viewer_can_write:false}}))
    await page.goto(baseUrl+'/home')
    await page.locator('.page-dashboard').waitFor()
    assert.equal(new URL(page.url()).pathname,'/home','establish an authenticated source before testing back navigation')
    const source=`${baseUrl}/spaces/${room.space_id}/projects/${project.id}/files`
    await page.goto(source)
    const open=page.getByRole('button',{name:'Open Project chat',exact:true})
    const close=page.getByRole('button',{name:'Back to Project page',exact:true})
    for(const choice of ['Other conversation','New conversation',null]) {
      await open.click()
      await page.getByRole('button',{name:'Conversations and Room details',exact:true}).click()
      const dialog=page.getByRole('dialog')
      if(choice) await dialog.getByRole('button',{name:choice,exact:true}).click()
      else await dialog.getByRole('button',{name:'Close',exact:true}).click()
      await dialog.waitFor({state:'hidden'})
      assert.ok(!new URL(page.url()).searchParams.has('conversationDrawer'))
      await close.click()
      await open.waitFor()
      assert.equal(page.url(),source)
      assert.equal(await page.evaluate(()=>localStorage.getItem('project.sidecar.project-layout.open')),'false')
    }
    await page.setViewportSize({width:1280,height:900})
    await open.waitFor()
    assert.equal(await page.getByTestId('project-chat-sidecar').count(),0)
    assert.equal(await page.evaluate(()=>localStorage.getItem('project.sidecar.project-layout.open')),'false')
    await page.goBack()
    assert.equal(new URL(page.url()).pathname,'/home','one back after close reaches the source history entry')
    await page.setViewportSize({width:390,height:844})
    await page.goto(source+'?projectChat=1&conversationDrawer=1')
    await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click()
    await close.click()
    await open.waitFor()
    assert.equal(page.url(),source,'direct overlay deep link closes in place')
  } finally {await page.close()}
})

// Insets/short heights are synthetic. Neither engine proves installed iOS coverage.
test('Viewport probe entry, layout comparisons and input privacy', async () => {
  const shots = '/tmp/rainver-viewport-probe'
  mkdirSync(shots, { recursive: true })
  for (const locale of ['en', 'zh-CN']) for (const theme of ['dark', 'light']) for (const width of [390, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 812 }, serviceWorkers: 'block' })
    try {
      await page.addInitScript(({ locale, theme }) => {
        localStorage.setItem('rainver:locale', locale)
        localStorage.setItem('rainver:theme', theme)
      }, { locale, theme })
      await mockApi(page)
      await page.goto(baseUrl + '/settings')
      const diagnostics = page.locator('details').filter({ has: page.locator('summary', { hasText: locale === 'en' ? 'Layout diagnostics' : '布局诊断' }) })
      await diagnostics.locator('summary').click()
      const link = diagnostics.getByRole('link', { name: locale === 'en' ? 'Open viewport test' : '打开视口对照测试' })
      await link.scrollIntoViewIfNeeded()
      await page.screenshot({ path: `${shots}/entry-${locale}-${theme}-${width}.png` })
      let apiCalls = 0
      page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) apiCalls++ })
      await link.click()
      await page.waitForURL('**/viewport-test/index.html?**')
      await page.getByRole('heading', { name: locale === 'en' ? 'iPhone viewport test' : 'iPhone 视口对照' }).waitFor()
      assert.equal(await page.locator('.viewport-test-shell').getAttribute('data-mode'), 'flow-vh', 'start with the phone-validated C layout')
      assert.deepEqual(await page.locator('link[rel="manifest"]').evaluateAll(links => links.map(link => link.getAttribute('href'))), ['/viewport-test/manifest.webmanifest'])
      const manifest = await (await page.request.get(baseUrl + '/viewport-test/manifest.webmanifest')).json()
      assert.equal(manifest.id, '/viewport-test/')
      assert.equal(manifest.scope, '/viewport-test/')
      assert.equal(manifest.start_url, '/viewport-test/index.html')
      assert.equal(await page.locator('[data-app-chrome]').count(), 0)
      assert.match(await page.locator('meta[name="rainver-build-inputs"]').getAttribute('content'), /^[a-f0-9]{64}$/)
      await page.evaluate(() => {
        document.documentElement.style.setProperty('--app-safe-top', '62px')
        document.documentElement.style.setProperty('--app-safe-bottom', '34px')
      })
      const input = page.getByRole('textbox', { name: locale === 'en' ? 'Type here to test the keyboard' : '在此输入以测试键盘', exact: true })
      assert.equal(await input.evaluate(element => getComputedStyle(element).fontSize), '16px', 'actual pixels, not rem under the 14px root')
      const headerState = await page.locator('.viewport-test-shell').evaluate(shell => {
        const header = shell.querySelector('header'), heading = header.querySelector('h1'), main = shell.querySelector('main')
        return { top: header.getBoundingClientRect().top, bottom: header.getBoundingClientRect().bottom,
          titleTop: heading.getBoundingClientRect().top, mainTop: main.getBoundingClientRect().top,
          background: getComputedStyle(header).backgroundColor, pageBackground: getComputedStyle(shell).backgroundColor,
          safeBackingHeight: getComputedStyle(shell, '::before').height }
      })
      assert.equal(headerState.top, 0)
      assert.ok(headerState.titleTop >= 62, 'title below top safe area')
      assert.ok(headerState.mainTop >= headerState.bottom, 'scroll content below opaque header')
      assert.equal(headerState.background, headerState.pageBackground)
      assert.notEqual(headerState.background, 'rgba(0, 0, 0, 0)')
      assert.equal(headerState.safeBackingHeight, 'auto', 'baseline has no hidden fixed backing')
      await input.fill('PRIVATE-UNSENT-PROBE-TEXT')
      for (const [index, mode] of ['fixed', 'flow-dvh', 'flow-vh'].entries()) {
        await page.getByRole('group', { name: locale === 'en' ? 'Layout comparison' : '布局对照', exact: true }).getByRole('button').nth(index).click()
        await page.getByRole('button', { name: locale === 'en' ? /Bottom button/ : /底部按钮/ }).click()
        for (const height of [420, 812]) {
          await page.setViewportSize({ width, height })
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
          const geometry = await page.locator('.viewport-test-shell').evaluate(shell => {
            const rect = shell.getBoundingClientRect(), footer = shell.querySelector('footer').getBoundingClientRect()
            return { bottom: rect.bottom, footer: footer.bottom, overflow: document.documentElement.scrollWidth > innerWidth }
          })
          assert.ok(Math.abs(geometry.bottom - height) < 1, JSON.stringify({ mode, geometry, height }))
          assert.ok(Math.abs(geometry.footer - height) < 1)
          assert.equal(geometry.overflow, false)
        }
        await page.screenshot({ path: `${shots}/${locale}-${theme}-${width}-${mode}.png` })
      }
      assert.equal(await input.inputValue(), 'PRIVATE-UNSENT-PROBE-TEXT')
      await page.getByRole('button', { name: locale === 'en' ? 'Record layout' : '采集布局', exact: true }).click()
      await page.getByText(locale === 'en' ? 'Results (select to copy)' : '结果（选中文字复制）', { exact: true }).click()
      assert.equal(await page.getByRole('textbox', { name: locale === 'en' ? 'Results (select to copy)' : '结果（选中文字复制）', exact: true }).evaluate(element => getComputedStyle(element).fontSize), '16px')
      await page.locator('.viewport-test-shell main').evaluate(element => { element.scrollTop = element.scrollHeight })
      assert.equal(await page.locator('.viewport-test-shell header').evaluate(element => element.getBoundingClientRect().top), 0, 'scrolling the report must not scroll text into the notch')
      const report = await page.getByRole('textbox', { name: locale === 'en' ? 'Results (select to copy)' : '结果（选中文字复制）', exact: true }).inputValue()
      assert.ok(!report.includes('PRIVATE-UNSENT-PROBE-TEXT'))
      const samples = JSON.parse(report)
      assert.ok(samples.length > 0 && samples.length <= 12)
      const last = samples.at(-1)
      assert.equal(last.mode, 'flow-vh')
      assert.equal(last.safeArea.bottom, '34px')
      assert.equal(last.taps, 3)
      assert.equal(last.footer.bottom, 812)
      assert.equal(apiCalls, 0, 'probe must not ask for identity or product content')
      assert.deepEqual(await page.evaluate(() => Object.keys(localStorage).filter(key => localStorage.getItem(key)?.includes('PRIVATE-UNSENT-PROBE-TEXT'))), [])
    } finally { await page.close() }
  }
})

test('Viewport probe survives the existing root service worker without registering another', async () => {
  const context = await browser.newContext({ serviceWorkers: 'allow' })
  try {
    const page = await context.newPage()
    await mockApi(page)
    await page.goto(baseUrl + '/settings')
    await page.evaluate(() => navigator.serviceWorker.ready)
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller))
    await page.goto(baseUrl + '/viewport-test/index.html')
    await page.getByRole('heading', { name: 'iPhone viewport test' }).waitFor()
    await page.reload()
    await page.getByRole('heading', { name: 'iPhone viewport test' }).waitFor()
    assert.equal(await page.locator('link[rel="manifest"]').getAttribute('href'), '/viewport-test/manifest.webmanifest')
    const scopes = await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map(registration => new URL(registration.scope).pathname))
    assert.deepEqual(scopes, ['/'])
  } finally { await context.close() }
  const fresh = await browser.newContext({ serviceWorkers: 'allow' })
  try {
    const page = await fresh.newPage()
    await page.goto(baseUrl + '/viewport-test/index.html')
    await page.getByRole('heading', { name: 'iPhone viewport test' }).waitFor()
    assert.deepEqual(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map(registration => registration.scope)), [])
  } finally { await fresh.close() }
})

// Synthetic WebKit geometry only: CSS large viewport 874, API readout 812.
// The real phone established C in the probe; these protect production wiring.
test('iPhone PWA uses Flow B on normal Home Settings Room and Project sidecar', async () => {
  const shots = '/tmp/rainver-pwa-production'
  mkdirSync(shots, { recursive: true })
  for (const locale of ['en', 'zh-CN']) for (const theme of ['dark', 'light']) {
    const page = await browser.newPage({ viewport: { width: 402, height: 874 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148', serviceWorkers: 'block' })
    try {
      await page.addInitScript(({ locale, theme }) => {
        localStorage.setItem('rainver:locale', locale)
        localStorage.setItem('rainver:theme', theme)
        Object.defineProperty(navigator, 'standalone', { configurable: true, value: true })
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: 812 })
        const viewport = Object.assign(new EventTarget(), { height: 812, width: 402, offsetTop: 0, offsetLeft: 0, scale: 1 })
        Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport })
      }, { locale, theme })
      await mockApi(page)
      await page.route('**/api/v1/projects/*/mainline-room', route => route.fulfill({ json: { room, viewer_can_write: false } }))
      const safe = () => page.evaluate(() => {
        document.documentElement.style.setProperty('--app-safe-top', '62px')
        document.documentElement.style.setProperty('--app-safe-bottom', '34px')
      })
      const bounds = () => page.locator('.app-safe-shell').evaluate(shell => {
        const rect = shell.getBoundingClientRect(), nav = shell.querySelector('nav.md\\:hidden')
        return { top: rect.top, bottom: rect.bottom, position: getComputedStyle(shell).position,
          padBottom: getComputedStyle(shell).paddingBottom, navBottom: nav?.getBoundingClientRect().bottom,
          navPadding: nav ? getComputedStyle(nav).paddingBottom : null }
      })
      await page.goto(baseUrl + '/home')
      await page.locator('.page-dashboard').waitFor()
      await safe()
      await page.waitForFunction(() => document.documentElement.hasAttribute('data-iphone-pwa'))
      assert.deepEqual(await bounds(), { top: 0, bottom: 874, position: 'relative', padBottom: '0px', navBottom: 874, navPadding: '34px' })
      assert.equal(await page.getByText('Bottom boundary + safe area', { exact: true }).count(), 0)
      assert.equal(await page.locator('.app-safe-shell').evaluate(shell => getComputedStyle(shell).paddingTop), '62px')
      assert.equal(await page.locator('.app-safe-shell header').first().evaluate(header => header.getBoundingClientRect().top), 62)

      await page.screenshot({ path: `${shots}/home-${locale}-${theme}.png` })
      await page.goto(baseUrl + '/settings')
      await safe()
      await page.locator('input').first().waitFor()
      assert.equal(await page.locator('input').first().evaluate(input => getComputedStyle(input).fontSize), '16px')
      await page.evaluate(() => { Object.assign(visualViewport, { height: 350, offsetTop: 24 }); visualViewport.dispatchEvent(new Event('resize')) })
      await page.waitForFunction(() => document.querySelector('.app-safe-shell').getBoundingClientRect().height === 350)
      assert.equal((await bounds()).bottom, 374)
      assert.equal((await bounds()).navPadding, '0px')
      await page.evaluate(() => { Object.assign(visualViewport, { scale: 1.5 }); visualViewport.dispatchEvent(new Event('resize')) })
      assert.equal((await bounds()).bottom, 874, 'pinch must not be treated as keyboard')
      await page.evaluate(() => { Object.assign(visualViewport, { height: 812, offsetTop: 0, scale: 1 }); visualViewport.dispatchEvent(new Event('resize')) })
      assert.equal((await bounds()).bottom, 874)
      await page.screenshot({ path: `${shots}/settings-${locale}-${theme}.png` })
      await page.goto(`${baseUrl}/spaces/${room.space_id}/projects/${project.id}/rooms?room=${room.id}&conversation=${session.id}`)
      await safe()
      await page.getByRole('log', { name: locale === 'en' ? 'Conversation messages' : '对话消息', exact: true }).waitFor()
      assert.equal((await bounds()).bottom, 874)
      assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue('--conversation-visual-height')), '100dvh')
      await page.screenshot({ path: `${shots}/room-${locale}-${theme}.png` })
      const mobileHeader = page.locator('[data-mobile-conversation-header]')
      assert.equal((await mobileHeader.boundingBox()).y, 62)
      await mobileHeader.locator('button').last().click()
      const drawer = page.locator('.mobile-conversation-drawer')
      await drawer.waitFor()
      assert.equal((await drawer.boundingBox()).y, 62)
      assert.equal(await drawer.locator('input').first().evaluate(input => getComputedStyle(input).fontSize), '16px')
      await page.screenshot({ path: `${shots}/initial-drawer-${locale}-${theme}.png`, animations: 'disabled' })
      await page.keyboard.press('Escape')
      await drawer.waitFor({ state: 'detached' })

      await page.goto(`${baseUrl}/spaces/${room.space_id}/projects/${project.id}/files`)
      await safe()
      await page.getByRole('button', { name: locale === 'en' ? 'Open Project chat' : '打开项目对话', exact: true }).click()
      const panel = page.getByTestId('project-chat-sidecar')
      await panel.getByRole('log', { name: locale === 'en' ? 'Conversation messages' : '对话消息', exact: true }).waitFor()
      const box = await panel.boundingBox()
      assert.ok(Math.abs(box.y - 62) < 1 && Math.abs(box.y + box.height - 840) < 1, JSON.stringify(box))
      await page.screenshot({ path: `${shots}/sidecar-${locale}-${theme}.png` })
      await page.setViewportSize({ width: 1280, height: 874 })
      await page.waitForFunction(() => !document.documentElement.hasAttribute('data-iphone-pwa'))
      assert.equal((await bounds()).position, 'fixed', 'desktop breakpoint restores original shell')
      assert.equal(await page.locator('.app-safe-shell').evaluate(shell => getComputedStyle(shell).paddingTop), '62px')


    } finally { await page.close() }
  }
})

// Model the WebKit split explicitly: a layout owner can be taller than the
// viewport used by fixed inset:0. This is not native keyboard/zoom emulation.
test('mobile Room drawer covers the viewport, avoids search autofocus and keeps touch input at 16px', async () => {
  const shots = '/tmp/rainver-pwa-drawer'
  mkdirSync(shots, { recursive: true })
  const scenarios = [
    { name: 'iphone-pwa', ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X)', installed: true, locale: 'en', theme: 'light' },
    { name: 'desktop-ua-pwa', ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', installed: true, locale: 'zh-CN', theme: 'dark' },
    { name: 'iphone-browser', ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X)', installed: false, locale: 'en', theme: 'dark' },
  ]
  for (const scenario of scenarios) {
    const page = await browser.newPage({ viewport: { width: 402, height: 812 }, isMobile: true, hasTouch: true, userAgent: scenario.ua, serviceWorkers: 'block' })
    try {
      await page.addInitScript(scenario => {
        localStorage.setItem('rainver:locale', scenario.locale)
        localStorage.setItem('rainver:theme', scenario.theme)
        Object.defineProperty(navigator, 'standalone', { configurable: true, value: scenario.installed })
        const viewport = Object.assign(new EventTarget(), { height: 812, width: 402, offsetTop: 0, offsetLeft: 0, scale: 1 })
        Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport })
      }, scenario)
      await mockApi(page, [{ ...session, title: 'Conversation alpha' }, { ...session, id: 'session-beta', title: 'Conversation beta' }])
      await page.goto(`${baseUrl}/spaces/${room.space_id}/projects/${project.id}/rooms?room=${room.id}&conversation=${session.id}`)
      const transcript = page.getByRole('log', { name: scenario.locale === 'en' ? 'Conversation messages' : '对话消息', exact: true })
      await transcript.waitFor()
      await page.addStyleTag({ content: 'html[data-test-large-viewport] { --app-pwa-height: 874px !important; --conversation-visual-height: 874px !important; }' })
      await transcript.evaluate(element => { element.dataset.drawerLifetime = 'retained' })
      assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-iphone-pwa')), scenario.installed)


      const applyGeometry = () => page.evaluate(installed => {
        const root = document.documentElement
        root.style.setProperty('--app-safe-top', '62px')
        root.style.setProperty('--app-safe-bottom', '34px')
        if (installed) {
          root.setAttribute('data-test-large-viewport', '')
          root.style.setProperty('--app-pwa-height', '874px')
          root.style.setProperty('--conversation-visual-height', '874px')
        }
      }, scenario.installed)
      await applyGeometry()
      const trigger = page.locator('[data-mobile-conversation-header] button').last()
      await trigger.click()
      const drawer = page.locator('.mobile-conversation-drawer')
      await drawer.waitFor()
      assert.equal(await drawer.evaluate(element => document.activeElement === element), true, 'open focuses the labelled container, not a text field')
      const search = drawer.getByRole('textbox')
      assert.equal(await search.evaluate(element => getComputedStyle(element).fontSize), '16px', 'portal font guard also works without the PWA flag')
      await applyGeometry()
      const backdrop = page.locator('[data-dialog-overlay]')
      const total = scenario.installed ? 874 : 812
      assert.ok((await backdrop.boundingBox()).height >= total, 'backdrop must cover the layout owner, not stop at the short fixed viewport')
      const rest = await drawer.boundingBox()
      assert.ok(Math.abs(rest.y - (62)) < 1 && Math.abs(rest.y + rest.height - total) < 1, JSON.stringify(rest))
      assert.ok(await drawer.evaluate(element => parseFloat(getComputedStyle(element).paddingBottom) >= 34), 'bottom safe area belongs inside the drawer background')
      const shot = await page.screenshot({ path: `${shots}/${scenario.name}-open.png`, fullPage: true, animations: 'disabled' })
      if (scenario.theme === 'light') {
        const pixels = await page.evaluate(async base64 => {
          const image = new Image()
          image.src = 'data:image/png;base64,' + base64
          await image.decode()
          const canvas = document.createElement('canvas')
          canvas.width = image.width; canvas.height = image.height
          const context = canvas.getContext('2d')
          context.drawImage(image, 0, 0)
          const bottom = [...context.getImageData(image.width - 10, image.height - 10, 1, 1).data].slice(0, 3)
          context.fillStyle = getComputedStyle(document.body).backgroundColor
          context.fillRect(0, 0, 1, 1)
          const background = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3)
          return { bottom, background }
        }, shot.toString('base64'))
        const paintBounds = await backdrop.evaluate(element => ({ position: getComputedStyle(element).position, height: element.getBoundingClientRect().height,
          cssHeight: document.documentElement.style.getPropertyValue('--app-pwa-height'), scrollHeight: document.documentElement.scrollHeight }))
        assert.ok(pixels.bottom.reduce((a, b) => a + b, 0) < pixels.background.reduce((a, b) => a + b, 0) * 0.8,
          'backdrop must actually paint the bottom, not just report a taller rect: ' + JSON.stringify({ pixels, paintBounds }))
      }
      await search.fill('alpha')
      assert.equal(await drawer.locator('nav button').count(), 1, 'search remains usable')
      await page.evaluate(() => { document.documentElement.removeAttribute('data-test-large-viewport'); Object.assign(visualViewport, { height: 350, offsetTop: 24 }); visualViewport.dispatchEvent(new Event('resize')) })
      const keyboard = await drawer.boundingBox()
      assert.equal(keyboard.y, 86, 'keyboard top includes each owned inset once')
      assert.ok(Math.abs(keyboard.y + keyboard.height - 374) < 1, 'no extra 34px above the keyboard: ' + JSON.stringify(keyboard))
      assert.equal(await search.evaluate(element => document.activeElement === element), true)
      await page.screenshot({ path: `${shots}/${scenario.name}-keyboard.png`, fullPage: true, animations: 'disabled' })
      await page.evaluate(() => { Object.assign(visualViewport, { height: 812, offsetTop: 0 }); visualViewport.dispatchEvent(new Event('resize')) })
      await applyGeometry()
      assert.ok((await backdrop.boundingBox()).height >= total)
      await search.press('Escape')
      await drawer.waitFor({ state: 'hidden' })
      assert.equal(await transcript.getAttribute('data-drawer-lifetime'), 'retained')
      await page.waitForFunction(() => document.activeElement?.closest('[data-mobile-conversation-header]'))
      await backdrop.waitFor({ state: 'detached' })
      assert.equal(await page.locator('[data-dialog-overlay]').count(), 0)
    } finally { await page.close() }
  }
})

test('iPhone PWA allows native dragging without scroll corrections and restores keyboard and zoom', async () => {
  // Mobile WebKit automation has no wheel API. Its desktop mode checks the
  // same scroll containment; neither engine recreates native iPhone bounce.
  const page = await browser.newPage({ viewport: { width: 402, height: 812 }, hasTouch: true, isMobile: process.env.LAYOUT_BROWSER !== 'webkit',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X)', serviceWorkers: 'block' })
  try {
    await page.addInitScript(() => {
      localStorage.setItem('rainver:locale', 'en')
      localStorage.setItem('rainver:theme', 'light')
      Object.defineProperty(navigator, 'standalone', { configurable: true, value: true })
      const viewport = Object.assign(new EventTarget(), { height: 812, width: 402, offsetTop: 0, offsetLeft: 0, scale: 1 })
      Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport })
      window.__rootCorrections = 0
      const original = window.scrollTo.bind(window)
      window.scrollTo = (...args) => { window.__rootCorrections++; return original(...args) }
    })
    await mockApi(page)
    await page.goto(baseUrl + '/home')
    await page.locator('.page-dashboard').waitFor()
    await page.addStyleTag({ content: 'html[data-test-large-viewport] { --app-pwa-height: 874px !important; --conversation-visual-height: 874px !important; }' })
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-test-large-viewport', '')
      document.documentElement.style.setProperty('--app-safe-top', '62px')
      document.documentElement.style.setProperty('--app-safe-bottom', '34px')
      document.querySelector('.app-safe-shell main').scrollTop = 50
    })
    if (process.env.LAYOUT_BROWSER === 'webkit') {
      await page.mouse.move(200, 300)
      await page.mouse.wheel(0, 200)
    } else {
      // Actual browser touch input, not a scrollTop assignment or wheel proxy.
      const touch = await page.context().newCDPSession(page)
      await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 200, y: 500 }] })
      for (let step = 1; step <= 10; step++) {
        await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 200, y: 500 - step * 15 }] })
      }
      await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await touch.detach()
    }
    await page.waitForFunction(() => document.querySelector('.app-safe-shell main').scrollTop > 50)
    // WebKit wheel scrolling is asynchronous; sample after it settles, not
    // between animation frames, before checking unrelated root-edge input.
    await page.evaluate(() => new Promise((resolve, reject) => {
      const main = document.querySelector('.app-safe-shell main')
      const deadline = performance.now() + 5000
      let previous = -1, stable = 0
      const next = () => {
        const value = main.scrollTop
        stable = value === previous ? stable + 1 : 0
        previous = value
        if (stable >= 8) resolve()
        else if (performance.now() > deadline) reject(new Error('inner scroll did not settle'))
        else requestAnimationFrame(next)
      }
      requestAnimationFrame(next)
    }))

    const mainScroll = await page.locator('.app-safe-shell main').evaluate(el => el.scrollTop)
    await page.mouse.move(200, 20)
    await page.mouse.wheel(0, 500)
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await page.waitForFunction(() => scrollY > 0)
    assert.ok(await page.evaluate(() => scrollY > 0), 'outer edge dragging must remain possible')
    assert.equal(await page.locator('.app-safe-shell main').evaluate(el => el.scrollTop), mainScroll)
    await page.evaluate(() => { document.scrollingElement.scrollTop = 0 }) // test setup for idle offset checks
    await page.waitForFunction(() => scrollY === 0)
    for (const offset of [-120, -24, 24, 120, -8, 0]) {
      await page.evaluate(offset => {
        visualViewport.offsetTop = offset
        visualViewport.dispatchEvent(new Event('scroll'))
        window.dispatchEvent(new Event('scroll'))
      }, offset)
      assert.equal(await page.locator('.app-safe-shell header').first().evaluate(el => el.getBoundingClientRect().top), 62,
        'idle viewport offsets must not create a moving layout feedback loop')
    }
    assert.equal(await page.evaluate(() => window.__rootCorrections), 0)
    await page.evaluate(() => { visualViewport.scale = 1.5; visualViewport.dispatchEvent(new Event('resize')) })
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).overflowY), 'visible')
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).overflowY), 'visible', 'release root for zoom panning')
    assert.equal(await page.evaluate(() => visualViewport.scale), 1.5)
    await page.evaluate(() => {
      document.documentElement.removeAttribute('data-test-large-viewport')
      Object.assign(visualViewport, { height: 350, offsetTop: 24, scale: 1 })
      visualViewport.dispatchEvent(new Event('resize'))
    })
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).overflowY), 'visible')
    assert.equal(await page.locator('.app-safe-shell').evaluate(el => el.getBoundingClientRect().bottom), 374)
    await page.evaluate(() => {
      Object.assign(visualViewport, { height: 812, offsetTop: 24 })
      visualViewport.dispatchEvent(new Event('resize'))
      document.documentElement.setAttribute('data-test-large-viewport', '')
    })
    assert.equal(await page.locator('.app-safe-shell header').first().evaluate(el => el.getBoundingClientRect().top), 62)
    assert.equal(await page.locator('.app-safe-shell').evaluate(el => el.getBoundingClientRect().bottom), 874)
    assert.equal(await page.evaluate(() => window.__rootCorrections), 0)
    mkdirSync('/tmp/rainver-pwa-no-jitter', { recursive: true })
    await page.screenshot({ path: '/tmp/rainver-pwa-no-jitter/home.png', fullPage: true, animations: 'disabled' })
    await page.goto(`${baseUrl}/spaces/${room.space_id}/projects/${project.id}/rooms?room=${room.id}&conversation=${session.id}`)
    await page.getByRole('log', { name: 'Conversation messages', exact: true }).waitFor()
    await page.evaluate(() => {
      document.documentElement.style.setProperty('--app-safe-top', '62px')
      document.documentElement.style.setProperty('--app-safe-bottom', '34px')
    })
    await page.locator('[data-mobile-conversation-header] button').last().click()
    const drawer = page.locator('.mobile-conversation-drawer')
    await drawer.waitFor()
    assert.equal((await drawer.boundingBox()).y, 62)
    await page.screenshot({ path: '/tmp/rainver-pwa-no-jitter/drawer.png', fullPage: true, animations: 'disabled' })
    assert.equal(await page.evaluate(() => window.__rootCorrections), 0)
  } finally { await page.close() }
})

test('Viewport top schemes show version evidence and preserve only bounded verdicts across reload', async () => {
  const shots = '/tmp/rainver-top-comparison'
  mkdirSync(shots, { recursive: true })
  for (const locale of ['en', 'zh-CN']) for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: 390, height: 874 }, serviceWorkers: 'block' })
    try {
      await page.addInitScript(({ locale, theme }) => {
        localStorage.setItem('rainver:locale', locale)
        localStorage.setItem('rainver:theme', theme)
      }, { locale, theme })
      let apiCalls = 0
      page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) apiCalls++ })
      await page.goto(baseUrl + '/viewport-test/index.html')
      await page.locator('[data-probe-version-status="current"]').waitFor()
      await page.getByText(locale === 'en' ? 'Test page version · TOP-TEST-2' : '测试页版本 · TOP-TEST-2', { exact: true }).waitFor()
      const modes = ['baseline', 'solid', 'text-clip', 'clearance', 'sticky']
      const group = page.getByRole('group', { name: locale === 'en' ? 'Top-edge comparison' : '顶部方案对照', exact: true })
      for (const [index, mode] of modes.entries()) {
        await group.getByRole('button').nth(index).click()
        await page.evaluate(() => {
          document.documentElement.style.setProperty('--app-safe-top', '62px')
          document.documentElement.style.setProperty('--app-safe-bottom', '34px')
          document.querySelector('.viewport-test-shell main').scrollTop = 0
        })
        const geometry = await page.locator('.viewport-test-shell').evaluate(shell => {
          const target = shell.querySelector('[data-top-target]'), edge = document.querySelector('.viewport-test-top-surface')
          return { target: target.getBoundingClientRect().top, bottom: shell.getBoundingClientRect().bottom,
            inset: getComputedStyle(shell.querySelector('header')).paddingTop,
            surface: edge ? { parent: edge.parentElement.tagName, height: edge.getBoundingClientRect().height,
              clip: getComputedStyle(edge).backgroundClip, pointer: getComputedStyle(edge).pointerEvents } : null,
            overflow: document.documentElement.scrollWidth > innerWidth }
        })
        assert.equal(geometry.bottom, 874, 'top comparison must not change C bottom height')
        assert.equal(geometry.overflow, false)
        assert.ok(geometry.target >= 62)
        assert.equal(parseFloat(geometry.inset), 62 + 10.5 + (mode === 'clearance' ? 16 : 0))
        if (mode === 'solid' || mode === 'text-clip') {
          assert.equal(geometry.surface.parent, 'BODY', 'surface must not be inside clipped Shell')
          assert.equal(geometry.surface.height, mode === 'solid' ? 62 : 11)
          assert.equal(geometry.surface.pointer, 'none')
          if (mode === 'text-clip') assert.equal(geometry.surface.clip, 'text')
        } else assert.equal(geometry.surface, null)
        assert.equal(new URL(page.url()).searchParams.get('top'), mode)
        await page.screenshot({ path: `${shots}/${locale}-${theme}-${mode}.png`, animations: 'disabled' })
        await page.getByRole('button', { name: locale === 'en' ? 'Still blurred' : '仍虚化', exact: true }).click()
      }
      const editor = page.getByRole('textbox', { name: locale === 'en' ? 'Type here to test the keyboard' : '在此输入以测试键盘', exact: true })
      await editor.fill('PRIVATE-TOP-COMPARISON')
      assert.equal(await editor.evaluate(el => getComputedStyle(el).fontSize), '16px')
      await page.reload()
      assert.equal(await page.locator('.viewport-test-shell').getAttribute('data-top'), 'sticky')
      const outcomes = page.getByRole('list', { name: locale === 'en' ? 'Your comparison results' : '我的对照结果', exact: true })
      assert.equal(await outcomes.locator('li').count(), 5)
      assert.equal(await outcomes.getByText(locale === 'en' ? /Still blurred/ : /仍虚化/).count(), 5)
      assert.equal(await editor.inputValue(), '')
      assert.ok(!(await page.evaluate(() => sessionStorage.getItem('rainver:viewport-top-observations'))).includes('PRIVATE-TOP-COMPARISON'))
      await page.route('**/version.json?*', route => route.fulfill({ json: { id: 'different-server-build', builtAt: 'today' } }))
      await page.getByRole('button', { name: locale === 'en' ? 'Check for updates' : '检查更新', exact: true }).click()
      await page.locator('[data-probe-version-status="available"]').waitFor()
      assert.equal(await page.getByText(/different-server-build/).count(), 1)
      await page.route('**/version.json?*', route => route.abort())
      await page.getByRole('button', { name: locale === 'en' ? 'Check for updates' : '检查更新', exact: true }).click()
      await page.locator('[data-probe-version-status="error"]').waitFor()
      assert.equal(apiCalls, 0)
    } finally { await page.close() }
  }
})

test('Task collaboration line stays a small entry with the composer, opens on demand and surfaces pauses and stops, across themes, languages, widths and the Project sidecar', async () => {
  const shots = '/tmp/rainver-collaboration-line'
  mkdirSync(shots, { recursive: true })
  // Past the old 128-handoff cap: counted and reminded, never a limit or a mode.
  const base = { group_id: 'group-layout', group_status: 'active', task_id: 'task-layout',
    task_title: 'Implement unlimited task handoffs with threshold reminders and dual review', task_status: 'in_progress',
    delegations_used: 130, turns_used: 260, next_reminder_at: 200,
    participant_agent_ids: ['agent-codex', 'agent-antigravity'], active: true, stop_reason: null, can_manage: true }
  const t = (locale, en, zh) => locale === 'en' ? en : zh
  const open = async (page, locale, theme, initial) => {
    await page.addInitScript(({ locale, theme }) => {
      localStorage.setItem('rainver:locale', locale)
      localStorage.setItem('rainver:theme', theme)
    }, { locale, theme })
    await mockApi(page)
    const state = { view: initial, calls: [] }
    await page.route('**/api/v1/queries/room.collaboration.get**', route => route.fulfill({ json: { status: 'succeeded', data: state.view } }))
    await page.route('**/api/v1/actions/agent_group.status.set', route => {
      const body = route.request().postDataJSON()
      state.calls.push(body)
      // The server's own state after the command; the line must read it again.
      state.view = { invalid: false, collaboration: { ...state.view.collaboration, group_status: body.status, active: false, stop_reason: body.status === 'paused' ? 'paused' : 'stopped' } }
      return route.fulfill({ json: { status: 'succeeded', data: { group_id: base.group_id, status: body.status } } })
    })
    return state
  }
  const fits = async (line, label) => {
    const fit = await line.evaluate(el => ({ right: el.getBoundingClientRect().right, viewport: document.documentElement.clientWidth,
      overflow: el.scrollWidth - el.clientWidth, doc: document.documentElement.scrollWidth }))
    assert.ok(fit.right <= fit.viewport + 1 && fit.overflow <= 1 && fit.doc <= fit.viewport + 1, JSON.stringify({ label, ...fit }))
  }
  const roomUrl = `${baseUrl}/spaces/${room.space_id}/projects/${project.id}/rooms?room=${room.id}&conversation=${session.id}`
  for (const locale of ['en', 'zh-CN']) for (const theme of ['dark', 'light']) for (const width of [390, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, serviceWorkers: 'block' })
    const label = `${locale}-${theme}-${width}`
    try {
      const state = await open(page, locale, theme, { invalid: false, collaboration: base })
      await page.goto(roomUrl)
      const line = page.getByTestId('conversation-collaboration-line')
      await line.waitFor()
      await page.evaluate(() => document.fonts.ready)
      await fits(line, label)
      // Normal collaboration: one small entry, no counts or controls until opened.
      const toggle = line.getByTestId('conversation-collaboration-toggle')
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false')
      assert.equal(await line.getByRole('button').count(), 1)
      assert.ok(!(await line.textContent()).includes(t(locale, '130 handoffs', '已交接 130 次')))
      const collapsedHeight = (await line.boundingBox()).height
      assert.ok(collapsedHeight <= (width === 390 ? 48 : 34), JSON.stringify({ label, collapsedHeight }))
      await page.screenshot({ path: `${shots}/${label}-collapsed.png`, animations: 'disabled' })
      await toggle.click()
      await line.getByTestId('conversation-collaboration-details').waitFor()
      await fits(line, `${label}-open`)
      const text = await line.textContent()
      assert.ok(text.includes(t(locale, '130 handoffs', '已交接 130 次')), text)
      assert.ok(text.includes(t(locale, 'next reminder at 200, no total limit', '下次在第 200 次交接时提醒，不设总次数上限')), text)
      // No mode, finite limit, pending request or enabling confirmation exists by default.
      assert.ok(!/limit 128|上限 128|Remove limit|取消上限|reminder mode|提醒模式/.test(text), text)
      assert.equal(await line.getByTestId('conversation-collaboration-request').count(), 0)
      assert.deepEqual((await line.getByRole('button').allTextContents()).slice(1), [t(locale, 'Pause', '暂停'), t(locale, 'Stop', '停止')])
      const stopButton = line.getByRole('button', { name: t(locale, 'Stop', '停止') })
      // Narrow layouts reuse the shared coarse/narrow touch rule (reading-touch).
      if (width === 390) assert.ok((await stopButton.boundingBox()).height >= 44, label)
      await page.screenshot({ path: `${shots}/${label}-open.png`, animations: 'disabled' })
      // Stop asks first and changes nothing until confirmed.
      await stopButton.click()
      await line.getByText(t(locale, 'Stop this task collaboration?', '停止此任务协作？'), { exact: false }).waitFor()
      await fits(line, `${label}-stop`)
      await line.screenshot({ path: `${shots}/${label}-stop-confirm.png`, animations: 'disabled' })
      assert.equal(state.calls.length, 0)
      await line.getByRole('button', { name: t(locale, 'Confirm', '确认') }).click()
      await line.getByText(t(locale, 'stopped', '已停止'), { exact: false }).waitFor()
      assert.deepEqual(state.calls, [{ group_id: base.group_id, status: 'cancelled' }])
      // Ended: folded back to the entry, no resident old details or controls.
      assert.equal(await line.getAttribute('data-phase'), 'ended')
      assert.equal(await line.getByTestId('conversation-collaboration-details').count(), 0)
      assert.equal(await line.getByRole('button').count(), 1)
      await fits(line, `${label}-after`)
    } finally {
      await page.close()
    }
  }
  // Paused, stopped, a named admission stop and an unreadable record, at the narrow width.
  const states = {
    paused: { invalid: false, collaboration: { ...base, group_status: 'paused', active: false, stop_reason: 'paused' } },
    stopped: { invalid: false, collaboration: { ...base, group_status: 'cancelled', active: false, stop_reason: 'stopped' } },
    finished: { invalid: false, collaboration: { ...base, group_status: 'succeeded' } },
    failures: { invalid: false, collaboration: { ...base, active: false, stop_reason: 'repeated_failures' } },
    unavailable: { invalid: false, collaboration: { ...base, task_title: null, task_status: null, active: false, stop_reason: 'task_unavailable' } },
    invalid: { invalid: true, collaboration: null },
  }
  for (const locale of ['en', 'zh-CN']) for (const [name, view] of Object.entries(states)) {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 }, serviceWorkers: 'block' })
    try {
      await open(page, locale, 'dark', view)
      await page.goto(roomUrl)
      const line = page.getByTestId('conversation-collaboration-line')
      await line.waitFor()
      await fits(line, `${locale}-${name}`)
      const text = await line.textContent()
      if (name === 'paused') {
        assert.ok(text.includes(t(locale, 'paused', '已暂停')))
        assert.ok(await line.getByRole('button', { name: t(locale, 'Resume', '恢复') }).isVisible())
        assert.ok(await line.getByRole('button', { name: t(locale, 'Stop', '停止') }).isVisible())
      }
      if (name === 'stopped' || name === 'finished') {
        assert.ok(text.includes(name === 'stopped' ? t(locale, 'stopped', '已停止') : t(locale, 'finished', '已结束')), text)
        assert.ok(!text.includes(t(locale, '130 handoffs', '已交接 130 次')), text)
        assert.equal(await line.getByRole('button').count(), 1)
        await line.getByTestId('conversation-collaboration-toggle').click()
        await line.getByText(t(locale, '130 handoffs', '已交接 130 次')).waitFor()
        assert.equal(await line.getByRole('button').count(), 1)
        await fits(line, `${locale}-${name}-open`)
      }
      if (name === 'failures') {
        assert.ok(text.includes(t(locale, 'three handoffs in a row without a result', '连续三次交接无结果')), text)
        assert.ok(await line.getByRole('button', { name: t(locale, 'Pause', '暂停') }).isVisible())
        assert.ok(await line.getByRole('button', { name: t(locale, 'Stop', '停止') }).isVisible())
      }
      if (name === 'unavailable') assert.ok(text.includes(t(locale, 'Task not available here', '此处无法查看该 Task')), text)
      if (name === 'invalid') assert.ok(text.includes(t(locale, 'cannot be read', '无法读取')), text)
      await line.screenshot({ path: `${shots}/state-${locale}-${name}.png`, animations: 'disabled' })
    } finally {
      await page.close()
    }
  }
  // The Project chat sidecar shows the same line in its panel.
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' })
  try {
    await open(page, 'en', 'light', { invalid: false, collaboration: base })
    await page.route('**/api/v1/projects/*/overview', route => route.fulfill({ json: { project, brief: null, attention: [] } }))
    await page.route('**/api/v1/projects/*/mainline-room', route => route.fulfill({ json: { room, viewer_can_write: true } }))
    await page.goto(`${baseUrl}/spaces/${room.space_id}/projects/${project.id}/files`)
    // Desktop opens the Project chat panel by default.
    const sidecar = page.getByTestId('project-chat-sidecar')
    await sidecar.waitFor()
    const line = sidecar.getByTestId('conversation-collaboration-line')
    await line.waitFor()
    const panel = await sidecar.boundingBox(), box = await line.boundingBox()
    assert.ok(box.x >= panel.x - 1 && box.x + box.width <= panel.x + panel.width + 1, JSON.stringify({ panel, box }))
    await fits(line, 'sidecar')
    assert.equal(await line.getByRole('button').count(), 1)
    await page.screenshot({ path: `${shots}/sidecar-en-light-1280.png`, animations: 'disabled' })
    await line.getByTestId('conversation-collaboration-toggle').click()
    await line.getByRole('button', { name: 'Pause' }).click()
    // A pause is shown with Resume and Stop in the sidecar without reopening.
    await line.getByRole('button', { name: 'Resume' }).waitFor()
    assert.ok(await line.getByRole('button', { name: 'Stop' }).isVisible())
    await fits(line, 'sidecar-paused')
    await page.screenshot({ path: `${shots}/sidecar-paused-en-light-1280.png`, animations: 'disabled' })
  } finally {
    await page.close()
  }

  // Switching conversation in the Room page never carries an open stop confirmation along or back.
  const switching = await browser.newPage({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' })
  try {
    const other = { ...session, id: 'session-collab-other', title: 'Other collaboration' }
    await switching.addInitScript(() => { localStorage.setItem('rainver:locale', 'en'); localStorage.setItem('rainver:theme', 'dark') })
    await mockApi(switching, [{ ...session, title: 'First collaboration' }, other])
    const calls = []
    const views = { [session.id]: { ...base, delegations_used: 3, next_reminder_at: 25 }, [other.id]: { ...base, group_id: 'group-other', task_id: 'task-other', delegations_used: 1, next_reminder_at: 25 } }
    await switching.route('**/api/v1/queries/room.collaboration.get**', route => route.fulfill({ json: { status: 'succeeded',
      data: { invalid: false, collaboration: views[JSON.parse(new URL(route.request().url()).searchParams.get('input') ?? '{}').session_id] ?? null } } }))
    await switching.route('**/api/v1/actions/agent_group.status.set', route => { calls.push(route.request().postDataJSON()); return route.fulfill({ status: 500, body: '' }) })
    await switching.goto(roomUrl)
    const line = switching.getByTestId('conversation-collaboration-line')
    await line.getByTestId('conversation-collaboration-toggle').click()
    await line.getByText('3 handoffs', { exact: false }).waitFor()
    await line.getByRole('button', { name: 'Stop' }).click()
    await line.getByRole('button', { name: 'Confirm' }).waitFor()
    const list = switching.getByRole('navigation', { name: 'Conversations', exact: true })
    await list.getByRole('button', { name: 'Other collaboration' }).first().click()
    await switching.waitForFunction(() => document.querySelector('[data-testid="conversation-collaboration-toggle"]')?.getAttribute('aria-expanded') === 'false')
    assert.equal(await line.getByRole('button', { name: 'Confirm' }).count(), 0)
    await line.getByTestId('conversation-collaboration-toggle').click()
    await line.getByText('1 handoffs', { exact: false }).waitFor()
    assert.ok(await line.getByRole('button', { name: 'Stop' }).isEnabled())
    await line.screenshot({ path: `${shots}/switched-conversation-en-dark-1280.png`, animations: 'disabled' })
    await list.getByRole('button', { name: 'First collaboration' }).first().click()
    await line.getByTestId('conversation-collaboration-toggle').click()
    await line.getByText('3 handoffs', { exact: false }).waitFor()
    assert.equal(await line.getByRole('button', { name: 'Confirm' }).count(), 0)
    assert.equal(calls.length, 0)
  } finally {
    await switching.close()
  }
})

test('Collaboration threshold reminder stays above the composer and dismisses only that notice', async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 900 }, serviceWorkers: 'block' })
  try {
    await page.addInitScript(() => localStorage.setItem('rainver:locale', 'en'))
    await mockApi(page)
    const notices = []
    const notice = count => ({ ...message, id: `reminder-${count}`, role: 'system',
      content: `Reached ${count} handoffs. Latest result: finished.`,
      metadata_json: { room_display: 'system_notice', execution_event: 'collaboration_reminder',
        execution_details: { delegations_used: count } } })
    await page.route('**/api/v1/**/messages*', route => route.fulfill({ json: { ...pageOf([message, ...notices]), queued: [] } }))
    const url = `${baseUrl}/spaces/${room.space_id}/projects/${project.id}/rooms?room=${room.id}&conversation=${session.id}`
    const banner = page.getByTestId('conversation-collaboration-reminder')
    await page.goto(url)
    await page.getByRole('log').getByText('UnbrokenHeading', { exact: false }).first().waitFor()
    assert.equal(await banner.count(), 0)
    notices.push(notice(25))
    await banner.getByText('Task collaboration reached 25 handoffs. Work continues.').waitFor()
    const composer = page.locator('[data-conversation-composer]')
    assert.ok((await banner.boundingBox()).y < (await composer.boundingBox()).y)
    assert.equal(await page.getByRole('log').getByText('Reached 25 handoffs.', { exact: false }).count(), 0)
    await banner.getByText('Show task collaboration details', { exact: true }).click()
    await banner.getByText('Latest result: finished.', { exact: false }).waitFor()
    await page.screenshot({ path: '/tmp/rainver-threshold-reminder-mobile.png' })
    await banner.getByRole('button', { name: 'Dismiss task collaboration reminder' }).click()
    await banner.waitFor({ state: 'detached' })
    await page.reload()
    await page.getByRole('log').getByText('UnbrokenHeading', { exact: false }).first().waitFor()
    assert.equal(await banner.count(), 0)
    notices.push(notice(50))
    await banner.getByText('Task collaboration reached 50 handoffs. Work continues.').waitFor()

    await page.setViewportSize({ width: 1280, height: 900 })
    await page.route('**/api/v1/projects/*/mainline-room', route => route.fulfill({ json: { room, viewer_can_write: true } }))
    await page.goto(`${baseUrl}/spaces/${room.space_id}/projects/${project.id}/files`)
    const sidecar = page.getByTestId('project-chat-sidecar')
    await sidecar.getByTestId('conversation-collaboration-reminder').getByText('Task collaboration reached 50 handoffs. Work continues.').waitFor()
    await page.screenshot({ path: '/tmp/rainver-threshold-reminder-sidecar.png' })
  } finally {
    await page.close()
  }
})

test('Project Runtime settings opens the Assistant defaults on a phone', async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' })
  try {
    await mockApi(page)
    await page.route(`**/api/v1/projects/${project.id}`, route => route.fulfill({ json: { ...project, owner_user_id: 'user-layout' } }))
    await page.route('**/api/v1/agents/system-assistant?*', route => route.fulfill({ json: { assistant: { id: 'project-assistant' } } }))
    await page.route('**/api/v1/agents/project-assistant/runtime-profiles', route => route.fulfill({ json: [
      { id: 'default-cli', name: 'Claude on Host', runtime_key: 'claude_code', is_default: true },
      { id: 'other-cli', name: 'Codex on Host', runtime_key: 'codex_cli', is_default: false },
    ] }))
    await page.goto(`${baseUrl}/spaces/${room.space_id}/projects/${project.id}?settings=runtime`)
    const dialog = page.getByRole('dialog', { name: 'Runtime settings' })
    await dialog.getByRole('radio', { name: /Claude on Host/ }).waitFor()
    assert.equal(await dialog.getByRole('radio', { name: /Claude on Host/ }).isChecked(), true)
    await page.screenshot({ path: `/tmp/rainver-project-assistant-runtime-390.png` })
  } finally { await page.close() }
})

test('Project chat header aligns with the Files toolbar', async () => {
  const screenshots = process.env.PROJECT_CHAT_HEADER_SHOTS
  if (screenshots) mkdirSync(screenshots, { recursive: true })
  for (const [locale, theme] of [['en', 'dark'], ['zh-CN', 'light']]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' })
    try {
      await mockApi(page, [
        { ...session, title: 'Rainver Agent 角色化与插件架构评估'.repeat(4) },
        ...Array.from({ length: 24 }, (_, index) => ({ ...session, id: `history-${index}`, title: `History ${index}`, created_at: '2026-10-22T18:00:00.000Z', updated_at: '2026-10-22T18:00:00.000Z' })),
      ])
      await page.route('**/api/v1/projects/*/mainline-room', route => route.fulfill({ json: { room, viewer_can_write: false } }))
      const host = 'server-desktop-' + 'long-host-name-'.repeat(8)
      const branch = 'feature/' + 'long-branch-name-'.repeat(8)
      await page.route('**/api/v1/**/locations', route => route.fulfill({ json: [{
        id: 'location-layout', status: 'active', execution_ready: true, execution_host_kind: 'remote',
        host_name: host, display_path: '/workspace/' + 'long-path-segment/'.repeat(12),
      }] }))
      await page.route('**/api/v1/**/git/status', route => route.fulfill({ json: {
        is_repo: true, branch, files: [], truncated: false,
      } }))
      await page.addInitScript(({ locale, theme }) => {
        localStorage.setItem('rainver:locale', locale)
        localStorage.setItem('rainver:theme', theme)
      }, { locale, theme })
      await page.goto(`${baseUrl}/spaces/${room.space_id}/projects/${project.id}/files`)
      const files = page.getByTestId('files-toolbar')
      const switcher = page.getByTestId('sidecar-switcher')
      const header = page.getByTestId('sidecar-desktop-header')
      await switcher.getByText(/Rainver Agent/).waitFor({ timeout: 10_000 })
      await files.waitFor()
      const hostBadge = files.getByTitle(host, { exact: true })
      const branchBadge = files.getByTitle(branch, { exact: true })
      await hostBadge.waitFor({ timeout: 10_000 })
      await branchBadge.waitFor({ timeout: 10_000 })
      for (const badge of [hostBadge, branchBadge]) {
        assert.ok(await badge.locator('span').evaluate(label => label.scrollWidth > label.clientWidth))
      }
      const hostBounds = await hostBadge.boundingBox()
      const newFolderBounds = await files.getByRole('button', { name: 'New Folder' }).boundingBox()
      assert.ok(hostBounds.x + hostBounds.width < newFolderBounds.x)
      assert.ok(await files.evaluate(el => el.scrollWidth <= el.clientWidth))
      const fileBounds = await files.boundingBox()
      const chatBounds = await header.boundingBox()
      assert.ok(Math.abs(fileBounds.y - chatBounds.y) <= 1)
      assert.ok(Math.abs(fileBounds.height - chatBounds.height) <= 1)
      assert.ok(await header.getByTestId('sidecar-audience').isVisible())
      if (screenshots) await page.screenshot({ path: `${screenshots}/${locale}-${theme}.png` })
      await switcher.click()
      assert.equal(await switcher.getAttribute('aria-expanded'), 'true')
      const menu = page.getByTestId('sidecar-navigator')
      await menu.waitFor()
      const popover = page.getByRole('dialog').filter({ has: menu })
      const menuBounds = await popover.boundingBox()
      assert.ok(Math.abs(menuBounds.x - chatBounds.x - 8) <= 1)
      assert.ok(Math.abs(chatBounds.x + chatBounds.width - menuBounds.x - menuBounds.width - 8) <= 1)
      assert.ok(Math.abs(menuBounds.y - chatBounds.y - chatBounds.height - 8) <= 1)
      assert.ok(menuBounds.height > 352 && menuBounds.y + menuBounds.height <= 900)
      assert.ok(await menu.getByRole('tabpanel').evaluate(el => el.scrollHeight > el.clientHeight))
      assert.ok(await page.getByText('第二项不能按照超出可见区域的列宽换行。').isVisible())
      if (screenshots) await page.screenshot({ path: `${screenshots}/${locale}-${theme}-menu.png` })
      await page.keyboard.press('Escape')
      await menu.waitFor({ state: 'hidden' })
      assert.equal(await switcher.getAttribute('aria-expanded'), 'false')
      await page.locator('[data-testid="sidecar-switcher"]:focus').waitFor({ timeout: 2_000 })
      const resize = header.locator('..').getByRole('separator')
      const handle = await resize.boundingBox()
      await page.mouse.move(handle.x + handle.width / 2, handle.y + 25)
      await page.mouse.down()
      await page.mouse.move(handle.x - 290, handle.y + 25, { steps: 8 })
      await page.mouse.up()
      assert.ok(await files.getByRole('button', { name: 'New Folder' }).isVisible())
      assert.ok(await files.getByRole('button', { name: 'New File' }).isVisible())
      assert.equal(await files.getByText('New Folder', { exact: true }).isVisible(), false)
      assert.equal(await hostBadge.isVisible(), false)
      assert.ok(await files.evaluate(el => el.scrollWidth <= el.clientWidth))
      assert.equal((await files.boundingBox()).height, fileBounds.height)
      assert.equal((await header.boundingBox()).height, chatBounds.height)
      if (screenshots) await page.screenshot({ path: `${screenshots}/${locale}-${theme}-narrow.png` })
    } finally {
      await page.close()
    }
  }
})
