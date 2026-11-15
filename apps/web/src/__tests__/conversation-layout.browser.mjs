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

async function mockApi(page, conversations = [session]) {
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
    else if (path.endsWith('/messages')) data = { ...pageOf([message]), queued: [] }
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
    await last.waitFor()
    const lane = await page.getByTestId('board-column-ready').boundingBox()
    const lastBox = await last.boundingBox()
    assert.ok(lastBox.y + lastBox.height <= lane.y + lane.height, 'column border encloses the last card')
    const sidebar = page.locator('[data-project-navigation]')
    const top = (await sidebar.boundingBox()).y
    await last.scrollIntoViewIfNeeded()
    assert.equal((await sidebar.boundingBox()).y, top)
    assert.ok(await page.locator('[data-project-area-content]').evaluate(element => element.scrollTop > 0))
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
      await page.setViewportSize({ width: 390, height: 900 })
      await page.locator('main[aria-label="Conversation"]').scrollIntoViewIfNeeded()
      await page.screenshot({ path: `${shots}/${locale}-${theme}-390.png` })
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
      await page.setViewportSize({ width: 390, height: 900 })
      await page.locator('main[aria-label="Conversation"]').scrollIntoViewIfNeeded()
      await page.screenshot({ path: `${shots}/${locale}-${theme}-390.png` })
    } finally { await page.close() }
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
          return route.fulfill({json:{summary:{participant_agent_ids:[...members.filter(m=>m!==optional).map(m=>m.agent_id),'hidden-layout',...(joined?[optional.agent_id]:[])],participants_revision:String(revision),session_id:session.id,state:'initialized',host:{host_id:'host-layout',host_name:'Laptop',host_kind:'remote',online:!offline,managed_workspace_available:true,daemon_last_heartbeat_at:now},runtime:joined?{...runtime,agent_id:optional.agent_id,runtime_profile_id:profiles.at(-1).runtime_profile_id}:runtime,runtimes:profiles.filter(p=>p.agent_id!==optional.agent_id||joined).map(p=>({...runtime,...p,session_config:p.agent_id===manager.agent_id?[{id:'model',type:'select',category:'model',value:model}]:[]})),primary:{kind:'managed',managed_workspace_id:session.id,display_path:null},attachments:showAttachment?[{id:'attachment-layout',workspace_location_id:'docs-layout',folder_name:'Shared docs',display_path:'/work/shared/research-documents',access_mode:'read',status:'active'}]:[],dispatch_locked:false,queue_paused_at:null,can_send:!offline,blocked_reason:offline?'Device offline':null},available_hosts:[],available_runtime_profiles:profiles.map(p=>({...p,retained_binding:p.agent_id===optional.agent_id?retained:true})),available_primary_locations:[]}})
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
    const readingTop=await scroller.evaluate(el=>el.scrollTop)
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
    await page.waitForFunction(top=>Math.abs(document.querySelector('[role="log"] .overscroll-y-contain').scrollTop-top)<2,readingTop,{timeout:3000}).catch(async()=>{throw new Error(JSON.stringify({expected:readingTop,actual:await scroller.evaluate(el=>({top:el.scrollTop,height:el.clientHeight,total:el.scrollHeight}))}))})
    await page.waitForTimeout(400) // delayed sidecar detail hydration cannot reset restoration
    assert.ok(Math.abs(await scroller.evaluate(el=>el.scrollTop)-readingTop)<2)
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
test('iPhone PWA uses C on normal Home Settings Room and Project sidecar', async () => {
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
      // Stationary first frame, not the separate root-pan regression.
      const topSurface = () => page.locator('.pwa-top-color-surface').evaluate(surface => {
        const style = getComputedStyle(surface), rect = surface.getBoundingClientRect()
        return { outsideRoot: surface.parentElement === document.body, empty: surface.childNodes.length === 0,
          ariaHidden: surface.getAttribute('aria-hidden'), top: rect.top, width: rect.width, height: rect.height,
          position: style.position, clip: style.backgroundClip, pointer: style.pointerEvents,
          opaque: style.opacity === '1' && style.backgroundColor === getComputedStyle(document.body).backgroundColor,
          hitThrough: document.elementFromPoint(200, 5) !== surface, scrollY, scale: visualViewport.scale }
      })
      const initialSurface = await topSurface()
      assert.equal(await page.locator('.app-safe-shell').evaluate(shell => getComputedStyle(shell).paddingTop), '72px', '62px device inset plus 10px trial, applied once')
      assert.deepEqual(initialSurface, { outsideRoot: true, empty: true, ariaHidden: 'true', top: 0, width: 402,
        height: 11, position: 'fixed', clip: 'text', pointer: 'none', opaque: true, hitThrough: true, scrollY: 0, scale: 1 })
      assert.equal(await page.locator('.app-safe-shell header').first().evaluate(header => header.getBoundingClientRect().top), 72,
        'only the requested 10px trial beyond one device inset on first Home frame')

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
      assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue('--conversation-visual-height')), '100vh')
      await page.screenshot({ path: `${shots}/room-${locale}-${theme}.png` })
      assert.deepEqual(await topSurface(), initialSurface, 'navigation preserves the independent edge surface')
      const mobileHeader = page.locator('[data-mobile-conversation-header]')
      assert.equal((await mobileHeader.boundingBox()).y, 72)
      await mobileHeader.locator('button').last().click()
      const drawer = page.locator('.mobile-conversation-drawer')
      await drawer.waitFor()
      assert.equal((await drawer.boundingBox()).y, 72)
      assert.equal(await drawer.locator('input').first().evaluate(input => getComputedStyle(input).fontSize), '16px')
      await page.screenshot({ path: `${shots}/initial-drawer-${locale}-${theme}.png`, animations: 'disabled' })
      assert.deepEqual(await topSurface(), initialSurface, 'portal must not hide the sampling surface')
      await page.keyboard.press('Escape')
      await drawer.waitFor({ state: 'detached' })

      await page.goto(`${baseUrl}/spaces/${room.space_id}/projects/${project.id}/files`)
      await safe()
      await page.getByRole('button', { name: locale === 'en' ? 'Open Project chat' : '打开项目对话', exact: true }).click()
      const panel = page.getByTestId('project-chat-sidecar')
      await panel.getByRole('log', { name: locale === 'en' ? 'Conversation messages' : '对话消息', exact: true }).waitFor()
      const box = await panel.boundingBox()
      assert.ok(Math.abs(box.y - 72) < 1 && Math.abs(box.y + box.height - 840) < 1, JSON.stringify(box))
      await page.screenshot({ path: `${shots}/sidecar-${locale}-${theme}.png` })
      await page.setViewportSize({ width: 1280, height: 874 })
      await page.waitForFunction(() => !document.documentElement.hasAttribute('data-iphone-pwa'))
      assert.equal((await bounds()).position, 'fixed', 'desktop breakpoint restores original shell')
      assert.equal(await page.locator('.app-safe-shell').evaluate(shell => getComputedStyle(shell).paddingTop), '62px', 'wide layout drops the trial clearance')
      assert.equal(await page.locator('.pwa-top-color-surface').evaluate(surface => getComputedStyle(surface).display), 'none',
        'desktop must not get the experimental edge surface')

    } finally { await page.close() }
  }
})

// Model the WebKit split explicitly: a layout owner can be taller than the
// viewport used by fixed inset:0. This is not native keyboard/zoom emulation.
test('mobile Room drawer covers C, avoids search autofocus and keeps touch input at 16px', async () => {
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
      assert.equal(await page.locator('.pwa-top-color-surface').evaluate(surface => getComputedStyle(surface).display),
        scenario.installed ? 'block' : 'none', 'ordinary Safari must not receive the compatibility surface')

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
      assert.ok(Math.abs(rest.y - (scenario.installed ? 72 : 62)) < 1 && Math.abs(rest.y + rest.height - total) < 1, JSON.stringify(rest))
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
      assert.equal(keyboard.y, scenario.installed ? 96 : 86, 'keyboard top includes each owned inset once')
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
      assert.equal(await page.locator('.app-safe-shell header').first().evaluate(el => el.getBoundingClientRect().top), 72,
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
    assert.equal(await page.locator('.app-safe-shell header').first().evaluate(el => el.getBoundingClientRect().top), 72)
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
    assert.equal((await drawer.boundingBox()).y, 72)
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
