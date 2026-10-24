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
        return { name: tab.textContent, width: text.clientWidth, scroll: text.scrollWidth,
          overflow: getComputedStyle(text).overflowX, ellipsis: getComputedStyle(text).textOverflow,
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
    }
    await page.getByRole('tab', { name: 'README.md' }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: '/tmp/rainver-file-tab-names.png' })
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
    const log = page.getByRole('log').first()
    await log.locator('[data-role="agent"]').first().waitFor()
    const nav = page.getByRole('navigation', { name: 'Primary', exact: true })
    await log.scrollIntoViewIfNeeded()
    const before = await nav.boundingBox()
    const result = await log.evaluate(element => {
      const outer = document.querySelector('main.flex-1, main.min-h-0')
      const outerBefore = outer?.scrollTop
      element.scrollTop = 0
      element.scrollTop = 150
      return { height: element.clientHeight, total: element.scrollHeight, scroll: element.scrollTop,
        containment: getComputedStyle(element).overscrollBehaviorY, outerBefore, outerAfter: outer?.scrollTop,
        bodyHeight: document.scrollingElement.scrollHeight, viewport: innerHeight }
    })
    assert.ok(result.total > result.height && result.scroll > 0, 'history owns a working scroll container')
    assert.equal(result.containment, 'contain')
    assert.equal(result.outerAfter, result.outerBefore)
    assert.ok(result.bodyHeight <= result.viewport, 'document must not scroll behind the shell')
    await page.setViewportSize({ width: 393, height: 550 })
    const after = await nav.boundingBox()
    assert.ok(before.bottom === undefined || before.y + before.height <= 680)
    assert.ok(after.y + after.height <= 551, 'navigation follows the dynamic viewport')
  } finally { await page.close() }
})


test('mobile Project chat close remains reachable and the panel can reopen', async () => {
  const page = await browser.newPage({ viewport: { width: 393, height: 680 }, isMobile: true, serviceWorkers: 'block' })
  try {
    await mockApi(page)
    await page.goto(`${baseUrl}/spaces/${room.space_id}/projects/${project.id}/files`)
    // Desktop browser emulation does not supply physical notch insets. Exercise
    // the shared layout contract with nonzero top, bottom and landscape insets.
    await page.evaluate(() => {
      for (const [edge, value] of Object.entries({ top: 59, bottom: 34, left: 12, right: 12 })) {
        document.documentElement.style.setProperty(`--app-safe-${edge}`, `${value}px`)
      }
    })
    await page.getByRole('button', { name: 'Open Project chat', exact: true }).click()
    const close = page.getByRole('button', { name: 'Close Project chat', exact: true })
    const box = await close.boundingBox()
    assert.ok(box.width >= 44 && box.height >= 44)
    assert.ok(box.x >= 12 && box.y >= 59 && box.y + box.height <= 646)
    assert.equal((await close.textContent()).trim(), '', 'uses the original icon without a new text button')
    const panelBox = await page.getByTestId('project-chat-sidecar').boundingBox()
    assert.ok(panelBox.y >= 59 && panelBox.y + panelBox.height <= 646)
    assert.ok(panelBox.x >= 12 && panelBox.x + panelBox.width <= 381)
    const headerBox = await page.locator('header').first().boundingBox()
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
    assert.ok(diagnostic.shell.height > 0)
    assert.equal('url' in diagnostic, false)
    assert.equal('user' in diagnostic, false)
  } finally { await page.close() }
})
